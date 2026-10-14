// Admin tools for accounts: the role, suspending and lifting it, deleting, signing out everywhere.
// Clerk is a stand-in here (no real Clerk): what is checked is what the backend asks of it.
import type { Job, Worker } from 'bullmq';
import { Code, ConnectError } from '@connectrpc/connect';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { setClerkAdmin, ClerkAdminError } from '../src/modules/auth/clerk-admin.ts';
import { users } from '../src/modules/auth/schema.ts';
import { getUser } from '../src/modules/auth/users.ts';
import {
  createAutomation,
  getAutomation,
  setEnabled,
  setMinIntervalMs,
} from '../src/modules/automations/automations.ts';
import { handleRunAutomation } from '../src/modules/automations/jobs.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { saveWebMessage } from '../src/modules/channels/messages.ts';
import { SUSPENDED_TEXT } from '../src/modules/orchestrator/process-message.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { runTurn } from '../src/modules/orchestrator/turn.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  installFakeTelegram,
  installFakeVm,
  mcpCall,
  telegramUpdate,
  type SentTelegram,
} from './fakes.ts';
import {
  call,
  chatUser,
  createUser,
  expectContract,
  signClerk,
  testApp,
  waitFor,
} from './helpers.ts';

type Err = { error: { code: string; message: string; details?: Record<string, unknown> } };

let workers: Worker[];
let vmFake: ReturnType<typeof installFakeVm>;
let tg: { sent: SentTelegram[] };

/** What the backend asked of Clerk, and what the stand-in should answer next. */
const clerk = {
  roles: [] as Array<{ clerkId: string; role: string }>,
  deleted: [] as string[],
  revoked: [] as string[],
  /** The next call fails with this (used once). */
  fail: null as ClerkAdminError | null,
  sessions: 2,
};
function take(): void {
  const e = clerk.fail;
  clerk.fail = null;
  if (e) throw e;
}

beforeAll(() => {
  wireModules();
  setMinIntervalMs(1000);
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  setClerkAdmin(undefined);
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  vmFake = installFakeVm();
  tg = installFakeTelegram();
  Object.assign(clerk, { roles: [], deleted: [], revoked: [], fail: null, sessions: 2 });
  setClerkAdmin({
    async setRole(clerkId, role) {
      take();
      clerk.roles.push({ clerkId, role });
    },
    async deleteUser(clerkId) {
      take();
      clerk.deleted.push(clerkId);
    },
    async revokeSessions(clerkId) {
      take();
      clerk.revoked.push(clerkId);
      return clerk.sessions;
    },
  });
});

const send = (method: string, path: string, token: string, body?: unknown) =>
  call(path, { method, token, ...(body !== undefined ? { body } : {}) });

const auditRows = (userId: string, action: string) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.action, action)));

const chat = () => Math.floor(Math.random() * 1e9);
const tgPost = (update: unknown) =>
  call('/webhooks/telegram', {
    method: 'POST',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
  });

/** A user with credits, a Max plan (room for automations) and a linked Telegram chat. */
async function linkedUser(credits = 1000) {
  const user = await createUser({ plan: 'max', credits } as never);
  const chatId = chat();
  const lc = (await (
    await send('POST', '/v1/channels/link-codes', user.token, { channel: 'telegram' })
  ).json()) as { code: string };
  await tgPost(telegramUpdate(chatId, lc.code));
  await waitFor(async () =>
    tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('✅')),
  );
  return { ...user, chatId };
}

/** Is the error the contract's Error shape with this code? */
async function expectError(res: Response, status: number, code: string): Promise<Err> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  const body = JSON.parse(text) as Err;
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  return body;
}

describe('admin accounts: who may call them', () => {
  it('every account tool is admin-only, with the Error shape', async () => {
    const user = await createUser();
    const other = await createUser();
    const calls: Array<[string, string, string, unknown]> = [
      [
        'adminSetUserRole',
        'PUT',
        `/v1/admin/users/${other.id}/role`,
        { role: 'admin', reason: 'x' },
      ],
      ['adminSuspendUser', 'POST', `/v1/admin/users/${other.id}/suspend`, { reason: 'x' }],
      ['adminUnsuspendUser', 'POST', `/v1/admin/users/${other.id}/unsuspend`, { reason: 'x' }],
      [
        'adminRevokeUserSessions',
        'POST',
        `/v1/admin/users/${other.id}/sessions/revoke`,
        { reason: 'x' },
      ],
      [
        'adminDeleteUser',
        'DELETE',
        `/v1/admin/users/${other.id}`,
        { reason: 'x', confirmEmail: other.email },
      ],
    ];
    for (const [op, method, path, body] of calls) {
      const body403 = await expectContract<Err>(
        op,
        await send(method, path, user.token, body),
        403,
      );
      expect(body403.error).toMatchObject({ code: 'forbidden', message: 'Admins only' });
      await expectContract(op, await call(path, { method, body }), 401);
    }
    expect(clerk.roles).toEqual([]);
    expect(clerk.deleted).toEqual([]);
    expect(clerk.revoked).toEqual([]);
    expect((await getUser(other.id))!).toMatchObject({ role: 'user', status: 'active' });
    expect(vmFake.stops).toEqual([]);
  });

  it('a reason is required, and must not be blank', async () => {
    const admin = await createUser({ role: 'admin' });
    const other = await createUser();
    await expectContract(
      'adminSuspendUser',
      await send('POST', `/v1/admin/users/${other.id}/suspend`, admin.token, {}),
      400,
    );
    await expectContract(
      'adminSuspendUser',
      await send('POST', `/v1/admin/users/${other.id}/suspend`, admin.token, { reason: '   ' }),
      400,
    );
    await expectContract(
      'adminSetUserRole',
      await send('PUT', `/v1/admin/users/${other.id}/role`, admin.token, { role: 'admin' }),
      400,
    );
    expect((await getUser(other.id))!.status).toBe('active');
  });

  it('an unknown user is 404 everywhere', async () => {
    const admin = await createUser({ role: 'admin' });
    await expectContract(
      'adminSetUserRole',
      await send('PUT', '/v1/admin/users/usr_missing/role', admin.token, {
        role: 'admin',
        reason: 'x',
      }),
      404,
    );
    await expectContract(
      'adminSuspendUser',
      await send('POST', '/v1/admin/users/usr_missing/suspend', admin.token, { reason: 'x' }),
      404,
    );
    await expectContract(
      'adminDeleteUser',
      await send('DELETE', '/v1/admin/users/usr_missing', admin.token, {
        reason: 'x',
        confirmEmail: 'a@b.c',
      }),
      404,
    );
  });
});

describe('admin accounts: the role', () => {
  it('sets the role in Clerk and on our row at once, and audits it', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser();
    // Not an admin yet.
    await expectContract(
      'adminFreeCreditStats',
      await call('/v1/admin/stats/free-credits', { token: user.token }),
      403,
    );
    const res = await expectContract<{ account: { role: string }; changed: boolean }>(
      'adminSetUserRole',
      await send('PUT', `/v1/admin/users/${user.id}/role`, admin.token, {
        role: 'admin',
        reason: 'joins the support team',
      }),
      200,
    );
    expect(res).toMatchObject({ account: { userId: user.id, role: 'admin' }, changed: true });
    expect(clerk.roles).toEqual([{ clerkId: user.clerkId, role: 'admin' }]);
    // The next request already sees it.
    await expectContract(
      'adminFreeCreditStats',
      await call('/v1/admin/stats/free-credits', { token: user.token }),
      200,
    );
    const [row] = await auditRows(user.id, 'role_changed');
    expect(row).toMatchObject({
      actor: 'admin',
      summary: 'An admin made this account an admin',
      details: { adminId: admin.id, reason: 'joins the support team', from: 'user', to: 'admin' },
    });

    // Clerk's webhook that follows carries the same role: it stays.
    const signed = signClerk({
      type: 'user.updated',
      data: {
        id: user.clerkId,
        primary_email_address_id: 'e1',
        email_addresses: [
          { id: 'e1', email_address: user.email, verification: { status: 'verified' } },
        ],
        public_metadata: { role: 'admin' },
      },
    });
    await call('/webhooks/clerk', { method: 'POST', body: signed.body, headers: signed.headers });
    await waitFor(async () => {
      const job = (await queue('system').getJobs(['completed'])).find(
        (j) => j.name === 'clerk-event',
      );
      return job;
    });
    expect((await getUser(user.id))!.role).toBe('admin');

    // The same role again: nothing happens, nothing is written.
    const again = await expectContract<{ changed: boolean }>(
      'adminSetUserRole',
      await send('PUT', `/v1/admin/users/${user.id}/role`, admin.token, {
        role: 'admin',
        reason: 'twice',
      }),
      200,
    );
    expect(again.changed).toBe(false);
    expect(clerk.roles).toHaveLength(1);
    expect(await auditRows(user.id, 'role_changed')).toHaveLength(1);

    // Taken away again.
    await expectContract(
      'adminSetUserRole',
      await send('PUT', `/v1/admin/users/${user.id}/role`, admin.token, {
        role: 'user',
        reason: 'left the team',
      }),
      200,
    );
    expect(clerk.roles.at(-1)).toEqual({ clerkId: user.clerkId, role: 'user' });
    await expectContract(
      'adminFreeCreditStats',
      await call('/v1/admin/stats/free-credits', { token: user.token }),
      403,
    );
  });

  it('an admin cannot remove their own admin role (409), and Clerk is not asked', async () => {
    const admin = await createUser({ role: 'admin' });
    const body = await expectContract<Err>(
      'adminSetUserRole',
      await send('PUT', `/v1/admin/users/${admin.id}/role`, admin.token, {
        role: 'user',
        reason: 'oops',
      }),
      409,
    );
    expect(body.error.code).toBe('conflict');
    expect(clerk.roles).toEqual([]);
    expect((await getUser(admin.id))!.role).toBe('admin');
    expect(await auditRows(admin.id, 'role_changed')).toHaveLength(0);
  });

  it('Clerk down or not set up: 503 and nothing changes', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser();
    clerk.fail = new ClerkAdminError('unavailable', 'Clerk could not be reached');
    await expectContract(
      'adminSetUserRole',
      await send('PUT', `/v1/admin/users/${user.id}/role`, admin.token, {
        role: 'admin',
        reason: 'x',
      }),
      503,
    );
    expect((await getUser(user.id))!.role).toBe('user');
    expect(await auditRows(user.id, 'role_changed')).toHaveLength(0);

    // The real Clerk client with no CLERK_SECRET_KEY (as in tests): refused before any call.
    setClerkAdmin(undefined);
    const body = await expectContract<Err>(
      'adminSetUserRole',
      await send('PUT', `/v1/admin/users/${user.id}/role`, admin.token, {
        role: 'admin',
        reason: 'x',
      }),
      503,
    );
    expect(body.error).toMatchObject({ code: 'unavailable' });
    expect(body.error.message).toContain('CLERK_SECRET_KEY');
    expect((await getUser(user.id))!.role).toBe('user');
  });
});

describe('admin accounts: suspend and unsuspend', () => {
  it('a suspended user is refused everywhere, and everything comes back on unsuspend', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await linkedUser();
    await ensureSandbox(user.id);
    const containerToken = vmFake.tokens.get(user.id)!;

    // Three automations: one on, one paused for credits, one the user paused.
    const on = await createAutomation({
      userId: user.id,
      title: 'Daily',
      instruction: 'say hi',
      sessionKey: 'web',
      cron: '0 9 * * *',
      timezone: 'UTC',
    });
    const forCredits = await createAutomation({
      userId: user.id,
      title: 'Weekly',
      instruction: 'say hi',
      sessionKey: 'web',
      cron: '0 9 * * 1',
      timezone: 'UTC',
    });
    await setEnabled(user.id, forCredits.id, false, 'out_of_credits');
    const mine = await createAutomation({
      userId: user.id,
      title: 'Mine',
      instruction: 'say hi',
      sessionKey: 'web',
      cron: '0 9 * * 2',
      timezone: 'UTC',
    });
    await setEnabled(user.id, mine.id, false, 'user');

    const res = await expectContract<{
      account: { status: string; suspendedAt: string | null };
      changed: boolean;
      automationsPaused: number;
      containerStopped: boolean;
    }>(
      'adminSuspendUser',
      await send('POST', `/v1/admin/users/${user.id}/suspend`, admin.token, {
        reason: 'spam reports from three people',
      }),
      200,
    );
    expect(res).toMatchObject({
      account: { userId: user.id, role: 'user', status: 'suspended' },
      changed: true,
      automationsPaused: 2,
      containerStopped: true,
    });
    expect(res.account.suspendedAt).not.toBeNull();

    // The container: stopped politely, through the vm-manager.
    expect(vmFake.stops).toEqual([{ userId: user.id, force: false, reason: 'account suspended' }]);

    // Automations: paused with the reason `admin`, the user's own pause kept, no timer left.
    expect((await getAutomation(user.id, on.id))!).toMatchObject({
      enabled: false,
      pausedReason: 'suspended',
    });
    expect((await getAutomation(user.id, forCredits.id))!.pausedReason).toBe('suspended');
    expect((await getAutomation(user.id, mine.id))!.pausedReason).toBe('user');
    expect(await queue('scheduled').getJobScheduler(`auto-${on.id}`)).toBeUndefined();

    // The audit row: the admin's id and the reason, in the details only.
    const [row] = await auditRows(user.id, 'account_suspended');
    expect(row).toMatchObject({
      actor: 'admin',
      summary: 'An admin suspended this account',
      details: { adminId: admin.id, reason: 'spam reports from three people' },
    });

    // Every signed-in call: 403 account_suspended, with the Error shape.
    await expectError(await call('/v1/me', { token: user.token }), 403, 'account_suspended');
    await expectError(
      await call('/v1/automations', { token: user.token }),
      403,
      'account_suspended',
    );
    await expectError(
      await send('POST', '/v1/messages', user.token, { text: 'hi', clientMessageId: 'c1' }),
      403,
      'account_suspended',
    );
    await expectError(
      await call(`/v1/stream?token=${encodeURIComponent(user.token)}`),
      403,
      'account_suspended',
    );
    // The container's own calls: the platform's tools and the git gateway.
    const tool = await mcpCall(containerToken, 'get_profile', {});
    expect(tool).toEqual({ isError: true, text: 'This account is suspended' });
    const git = await testApp().request('/git/acme/app/info/refs?service=git-upload-pack', {
      headers: {
        authorization: `Basic ${Buffer.from(`git:${containerToken}`).toString('base64')}`,
      },
    });
    expect(git.status).toBe(403);

    // Telegram: saved, not answered; one notice a day.
    await tgPost(telegramUpdate(user.chatId, 'are you there?'));
    await tgPost(telegramUpdate(user.chatId, 'hello??'));
    const saved = await waitFor(async () => {
      const rows = await db()
        .select()
        .from(messages)
        .where(and(eq(messages.userId, user.id), eq(messages.direction, 'in')));
      const texts = rows.filter((m) => m.status === 'delivered').map((m) => m.text);
      return texts.includes('are you there?') && texts.includes('hello??') ? texts : null;
    });
    expect(saved).toEqual(expect.arrayContaining(['are you there?', 'hello??']));
    await waitFor(async () => tg.sent.find((m) => m.text === SUSPENDED_TEXT));
    await new Promise((r) => setTimeout(r, 300));
    expect(
      tg.sent.filter((m) => m.chatId === String(user.chatId) && m.text === SUSPENDED_TEXT),
    ).toHaveLength(1);
    expect(vmFake.wakes).toEqual([]);
    expect(vmFake.deliveries).toEqual([]);

    // Work queued before the suspension (an automation's run, a web message): nothing runs.
    expect(
      await runTurn({
        userId: user.id,
        deliveryId: 'evt_before_suspension',
        kind: 'automation',
        sessionKey: 'web',
        channel: 'web',
        text: 'run',
      }),
    ).toBe('suspended');
    expect(vmFake.wakes).toEqual([]);

    // Suspending again: no second row, the stop is tried again.
    const again = await expectContract<{ changed: boolean; automationsPaused: number }>(
      'adminSuspendUser',
      await send('POST', `/v1/admin/users/${user.id}/suspend`, admin.token, { reason: 'again' }),
      200,
    );
    expect(again).toMatchObject({ changed: false, automationsPaused: 0 });
    expect(await auditRows(user.id, 'account_suspended')).toHaveLength(1);

    // Unsuspend: everything comes back.
    const back = await expectContract<{
      account: { status: string; suspendedAt: string | null };
      changed: boolean;
      automationsResumed: number;
      automationsWaitingForCredits: number;
    }>(
      'adminUnsuspendUser',
      await send('POST', `/v1/admin/users/${user.id}/unsuspend`, admin.token, {
        reason: 'appeal accepted',
      }),
      200,
    );
    expect(back).toEqual({
      account: { userId: user.id, role: 'user', status: 'active', suspendedAt: null },
      changed: true,
      automationsResumed: 2,
      automationsWaitingForCredits: 0,
    });
    expect((await getAutomation(user.id, on.id))!).toMatchObject({
      enabled: true,
      pausedReason: null,
    });
    expect((await getAutomation(user.id, forCredits.id))!.enabled).toBe(true);
    expect((await getAutomation(user.id, mine.id))!.pausedReason).toBe('user');
    expect(await queue('scheduled').getJobScheduler(`auto-${on.id}`)).toBeDefined();
    const [lifted] = await auditRows(user.id, 'account_unsuspended');
    expect(lifted).toMatchObject({
      actor: 'admin',
      details: { adminId: admin.id, reason: 'appeal accepted' },
    });

    await expectContract('getMe', await call('/v1/me', { token: user.token }), 200);
    expect((await mcpCall(containerToken, 'get_profile', {})).isError).toBeFalsy();
    // The next message wakes the container and is answered.
    await tgPost(telegramUpdate(user.chatId, 'back again'));
    // (The messages held during the suspension reach the agent only as earlier chat, never as
    // requests: the engine's recap of the conversation.)
    const reply = await waitFor(async () =>
      tg.sent.find((m) => m.text.startsWith('echo: ') && m.text.endsWith('back again')),
    );
    expect(reply.text).toContain('not new requests');
    expect(vmFake.wakes).toContain(user.id);

    // Unsuspending an active account: nothing changes, no row.
    const noop = await expectContract<{ changed: boolean }>(
      'adminUnsuspendUser',
      await send('POST', `/v1/admin/users/${user.id}/unsuspend`, admin.token, { reason: 'x' }),
      200,
    );
    expect(noop.changed).toBe(false);
    expect(await auditRows(user.id, 'account_unsuspended')).toHaveLength(1);
  });

  it('an automation that fires while suspended does nothing and goes back to paused', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser({ plan: 'max', credits: 1000 } as never);
    const a = await createAutomation({
      userId: user.id,
      title: 'Daily',
      instruction: 'say hi',
      sessionKey: 'web',
      cron: '0 9 * * *',
      timezone: 'UTC',
    });
    await send('POST', `/v1/admin/users/${user.id}/suspend`, admin.token, { reason: 'x' });
    // Switched on again behind the suspension's back (a race), then its timer fires.
    await setEnabled(user.id, a.id, true);
    await handleRunAutomation({
      id: 'timer-1',
      data: { automationId: a.id, userId: user.id },
      opts: {},
      timestamp: Date.now(),
    } as unknown as Job);
    await waitFor(async () => (await getAutomation(user.id, a.id))!.pausedReason === 'suspended');
    expect((await getAutomation(user.id, a.id))!).toMatchObject({ enabled: false, failCount: 0 });
    expect(vmFake.wakes).toEqual([]);
    expect(vmFake.deliveries).toEqual([]);
  });

  it('a web message sent before the suspension is not answered', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await chatUser();
    // Saved while active, its turn not started yet (no job here: the worker would race the
    // suspension); the turn starts only after the suspension.
    const { message } = await saveWebMessage({
      userId: user.id,
      text: 'late one',
      clientMessageId: 'w1',
    });
    expect(message.status).toBe('queued');
    await expectContract(
      'adminSuspendUser',
      await send('POST', `/v1/admin/users/${user.id}/suspend`, admin.token, { reason: 'x' }),
      200,
    );
    const outcome = await runTurn({
      userId: user.id,
      deliveryId: 'evt_web_before',
      kind: 'message',
      sessionKey: 'web',
      channel: 'web',
      text: 'late one',
      inboundMessageId: message.id,
    });
    expect(outcome).toBe('suspended');
    const [row] = await db().select().from(messages).where(eq(messages.id, message.id));
    expect(row!.status).toBe('delivered');
    expect(vmFake.deliveries.filter((d) => d.userId === user.id)).toEqual([]);
  });

  it('the vm-manager refuses the stop (a turn runs): containerStopped is false', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await chatUser();
    await ensureSandbox(user.id);
    vmFake.state.stopError = new ConnectError('turn in progress', Code.FailedPrecondition);
    const res = await expectContract<{ containerStopped: boolean; changed: boolean }>(
      'adminSuspendUser',
      await send('POST', `/v1/admin/users/${user.id}/suspend`, admin.token, { reason: 'x' }),
      200,
    );
    expect(res).toMatchObject({ changed: true, containerStopped: false });
    expect((await getUser(user.id))!.status).toBe('suspended');
    vmFake.state.stopError = null;
  });

  it('unsuspended at zero credits: the automations wait for credits', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser({ plan: 'max' } as never);
    const a = await createAutomation({
      userId: user.id,
      title: 'Daily',
      instruction: 'say hi',
      sessionKey: 'web',
      cron: '0 9 * * *',
      timezone: 'UTC',
    });
    await send('POST', `/v1/admin/users/${user.id}/suspend`, admin.token, { reason: 'x' });
    const back = await expectContract<{
      automationsResumed: number;
      automationsWaitingForCredits: number;
    }>(
      'adminUnsuspendUser',
      await send('POST', `/v1/admin/users/${user.id}/unsuspend`, admin.token, { reason: 'x' }),
      200,
    );
    expect(back).toMatchObject({ automationsResumed: 0, automationsWaitingForCredits: 1 });
    expect((await getAutomation(user.id, a.id))!).toMatchObject({
      enabled: false,
      pausedReason: 'out_of_credits',
    });
  });

  it('refuses suspending yourself or an admin (409)', async () => {
    const admin = await createUser({ role: 'admin' });
    const other = await createUser({ role: 'admin' });
    for (const id of [admin.id, other.id]) {
      const body = await expectContract<Err>(
        'adminSuspendUser',
        await send('POST', `/v1/admin/users/${id}/suspend`, admin.token, { reason: 'x' }),
        409,
      );
      expect(body.error.code).toBe('conflict');
      expect((await getUser(id))!.status).toBe('active');
    }
    expect(vmFake.stops).toEqual([]);
  });

  it('a suspended account cannot be made an admin', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser();
    await send('POST', `/v1/admin/users/${user.id}/suspend`, admin.token, { reason: 'x' });
    await expectContract(
      'adminSetUserRole',
      await send('PUT', `/v1/admin/users/${user.id}/role`, admin.token, {
        role: 'admin',
        reason: 'x',
      }),
      409,
    );
    expect(clerk.roles).toEqual([]);
  });
});

describe('admin accounts: delete', () => {
  it('refuses the wrong email, yourself and an admin; nothing is deleted', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser();
    const other = await createUser({ role: 'admin' });
    const wrong = await expectContract<Err>(
      'adminDeleteUser',
      await send('DELETE', `/v1/admin/users/${user.id}`, admin.token, {
        reason: 'asked by email',
        confirmEmail: 'someone.else@example.com',
      }),
      400,
    );
    expect(wrong.error).toMatchObject({
      code: 'invalid_request',
      details: { field: 'confirmEmail' },
    });
    await expectContract(
      'adminDeleteUser',
      await send('DELETE', `/v1/admin/users/${user.id}`, admin.token, { reason: 'x' }),
      400,
    );
    for (const target of [admin, other]) {
      await expectContract(
        'adminDeleteUser',
        await send('DELETE', `/v1/admin/users/${target.id}`, admin.token, {
          reason: 'x',
          confirmEmail: target.email,
        }),
        409,
      );
    }
    expect(clerk.deleted).toEqual([]);
    for (const u of [admin, user, other]) expect((await getUser(u.id))!.deletedAt).toBeNull();
  });

  it('deletes in Clerk, then runs the same deletion as the user’s own', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser();
    await ensureSandbox(user.id);
    expect(vmFake.tokens.has(user.id)).toBe(true);
    const res = await expectContract<{ userId: string; status: string }>(
      'adminDeleteUser',
      await send('DELETE', `/v1/admin/users/${user.id}`, admin.token, {
        reason: 'GDPR request by email',
        // Letter case and spaces around it don't matter.
        confirmEmail: `  ${user.email.toUpperCase()} `,
      }),
      202,
    );
    expect(res).toEqual({ userId: user.id, status: 'deleting' });
    expect(clerk.deleted).toEqual([user.clerkId]);
    expect((await getUser(user.id))!.deletedAt).not.toBeNull();
    // The deletion job: the container and the user's folder go through DeleteSandbox.
    await waitFor(async () => !vmFake.tokens.has(user.id));
    expect(await queue('system').getJob(`delete-${user.id}`)).toBeDefined();
    // Signed out for good.
    await expectContract('getMe', await call('/v1/me', { token: user.token }), 401);

    // The audit row keeps the admin's id, the user's id and the reason; nothing else.
    const [row] = await auditRows(user.id, 'account_deleted');
    expect(row).toMatchObject({ userId: user.id, actor: 'admin' });
    expect(row!.details).toEqual({ adminId: admin.id, reason: 'GDPR request by email' });
    expect(JSON.stringify(row)).not.toContain(user.email);

    // Clerk's webhook that follows adds nothing; a second delete is 404.
    const signed = signClerk({ type: 'user.deleted', data: { id: user.clerkId, deleted: true } });
    await expectContract(
      'webhookClerk',
      await call('/webhooks/clerk', { method: 'POST', body: signed.body, headers: signed.headers }),
      200,
    );
    await expectContract(
      'adminDeleteUser',
      await send('DELETE', `/v1/admin/users/${user.id}`, admin.token, {
        reason: 'x',
        confirmEmail: user.email,
      }),
      404,
    );
    expect(clerk.deleted).toHaveLength(1);
    expect(await auditRows(user.id, 'account_deleted')).toHaveLength(1);
  });

  it('Clerk down: 503 and nothing is deleted; Clerk already without the user: deleted here', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser();
    clerk.fail = new ClerkAdminError('unavailable', 'Clerk could not be reached');
    await expectContract(
      'adminDeleteUser',
      await send('DELETE', `/v1/admin/users/${user.id}`, admin.token, {
        reason: 'x',
        confirmEmail: user.email,
      }),
      503,
    );
    expect((await getUser(user.id))!.deletedAt).toBeNull();
    expect(await auditRows(user.id, 'account_deleted')).toHaveLength(0);

    clerk.fail = new ClerkAdminError('not_found', 'Clerk has no such user');
    await expectContract(
      'adminDeleteUser',
      await send('DELETE', `/v1/admin/users/${user.id}`, admin.token, {
        reason: 'x',
        confirmEmail: user.email,
      }),
      202,
    );
    const [row] = await db().select().from(users).where(eq(users.id, user.id));
    expect(row!.deletedAt).not.toBeNull();
    expect(await auditRows(user.id, 'account_deleted')).toHaveLength(1);
  });
});

describe('admin accounts: sign out everywhere', () => {
  it('ends the Clerk sessions and audits it', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser();
    clerk.sessions = 3;
    const res = await expectContract<{ revoked: number }>(
      'adminRevokeUserSessions',
      await send('POST', `/v1/admin/users/${user.id}/sessions/revoke`, admin.token, {
        reason: 'lost phone',
      }),
      200,
    );
    expect(res).toEqual({ revoked: 3 });
    expect(clerk.revoked).toEqual([user.clerkId]);
    const [row] = await auditRows(user.id, 'sessions_revoked');
    expect(row).toMatchObject({
      actor: 'admin',
      details: { adminId: admin.id, reason: 'lost phone', revoked: 3 },
    });
    // Not a suspension.
    expect((await getUser(user.id))!.status).toBe('active');
  });

  it('Clerk not set up: 503', async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser();
    setClerkAdmin(undefined);
    await expectContract(
      'adminRevokeUserSessions',
      await send('POST', `/v1/admin/users/${user.id}/sessions/revoke`, admin.token, {
        reason: 'x',
      }),
      503,
    );
    expect(await auditRows(user.id, 'sessions_revoked')).toHaveLength(0);
  });
});
