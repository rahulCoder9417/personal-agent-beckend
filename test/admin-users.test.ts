// The admin panel's endpoints: the overview, the user list and one user's details, and the plan set
// by hand. Admins only; counts and metadata only, never a message, a memory, a key or a token.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { allRoutes } from '../src/api/app.ts';
import { getOperation } from '../src/api/openapi/spec.ts';
import { auditLog } from '../src/modules/admin/schema.ts';
import { channelLinks, users, waitlistEntries } from '../src/modules/auth/schema.ts';
import { getActiveUser } from '../src/modules/auth/users.ts';
import { automations, crewJobs } from '../src/modules/automations/schema.ts';
import { charge, createGrant } from '../src/modules/billing/credits.ts';
import { keyModelsForPlan } from '../src/modules/billing/plans.ts';
import { subscriptions } from '../src/modules/billing/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { byokKeys } from '../src/modules/integrations/schema.ts';
import { connections, userMcpServers } from '../src/modules/integrations/tables.ts';
import {
  agentSettings,
  approvals,
  memories,
  turnTimings,
} from '../src/modules/orchestrator/schema.ts';
import { SandboxState, setVmClient, type VmClient } from '../src/modules/orchestrator/vm.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { installFakes, member } from './billing-fakes.ts';
import { DAY } from './billing-helpers.ts';
import { call, createUser, expectContract, webConversationId } from './helpers.ts';

afterAll(closeQueues);
const { llm, vm } = installFakes();

/** The vm-manager as the admin endpoints ask it: the awake list and one container's state. */
let awakeNow: string[] = [];
let vmDown = false;
beforeEach(() => {
  awakeNow = [];
  vmDown = false;
  setVmClient({
    ...vm.client(),
    listSandboxes: async () => {
      if (vmDown) throw new Error('vm-manager unreachable');
      return { sandboxes: awakeNow.map((userId) => ({ userId, state: SandboxState.AWAKE })) };
    },
    getSandbox: async (req: { userId: string }) => {
      if (vmDown) throw new Error('vm-manager unreachable');
      return {
        userId: req.userId,
        state: SandboxState.BUSY,
        lastActiveAtUnixMs: BigInt(Date.parse('2026-10-14T09:30:00Z')),
      };
    },
  } as unknown as VmClient);
});

type Err = { error: { code: string; message: string } };
type Overview = {
  users: { total: number; newToday: number; new7d: number; active7d: number; deleted: number };
  plans: { free: number; pro: number; max: number };
  turns: { today: number; last7d: number; failedToday: number; failed7d: number };
  containers: { awake: number | null };
  credits: { month: string; granted: number; spent: number };
  approvals: { open: number };
  jobs: { failed: number | null };
  waitlist: { total: number; pending: number };
};
type AdminUser = {
  id: string;
  email: string;
  name: string;
  plan: string;
  status: string;
  credits: number;
  engine: string;
  channels: string[];
  connectedApps: number;
  lastActiveAt: string | null;
  deletedAt: string | null;
};
type Page = { items: AdminUser[]; nextCursor: string | null };

const admin = () => createUser({ role: 'admin' });
const patch = (token: string, body: unknown) => ({ method: 'PATCH', token, body });

/** A user with a name and an email that tests can search for. */
async function named(
  name: string,
  email: string,
  overrides: Parameters<typeof createUser>[0] = {},
) {
  const u = await createUser(overrides);
  await db().update(users).set({ name, email }).where(eq(users.id, u.id));
  return { ...u, name, email };
}

async function inbound(userId: string, text: string, at = new Date()) {
  await db()
    .insert(messages)
    .values({
      id: newId('msg'),
      userId,
      conversationId: await webConversationId(userId),
      channel: 'web',
      direction: 'in',
      text,
      status: 'delivered',
      createdAt: at,
    });
}

async function turn(userId: string, outcome: string, startedAt: Date) {
  await db()
    .insert(turnTimings)
    .values({
      deliveryId: newId('evt'),
      userId,
      kind: 'message',
      channel: 'web',
      route: 'task',
      engine: 'hermes',
      wake: 'cold',
      outcome,
      startedAt,
      stages: {
        queued: 0,
        picked_up: 40,
        turn_started: 60,
        routed: 900,
        woken: 4200,
        deliver_sent: 4300,
        accepted: 4400,
        answered: 9800,
      },
      details: {},
    });
}

describe('contract: admin panel operations', () => {
  it('are mounted, in openapi.yaml and tagged admin', () => {
    const mounted = new Set(allRoutes.map((r) => r.operationId));
    for (const op of ['adminOverview', 'adminListUsers', 'adminGetUser', 'adminUpdateUser']) {
      expect(mounted.has(op as never), op).toBe(true);
      expect(getOperation(op).tags).toContain('admin');
    }
  });

  it('answer 401 without a session and 403 to a user who is not an admin', async () => {
    const u = await createUser();
    const target = await createUser();
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['adminOverview', '/v1/admin/overview', {}],
      ['adminListUsers', '/v1/admin/users', {}],
      ['adminGetUser', `/v1/admin/users/${target.id}`, {}],
      [
        'adminUpdateUser',
        `/v1/admin/users/${target.id}`,
        { method: 'PATCH', body: { plan: 'max' } },
      ],
    ];
    for (const [op, path, init] of cases) {
      await expectContract(op, await call(path, init), 401);
      const res = await expectContract<Err>(op, await call(path, { ...init, token: u.token }), 403);
      expect(res.error).toEqual({ code: 'forbidden', message: 'Admins only' });
    }
    // The refused plan change changed nothing.
    expect((await getActiveUser(target.id))!.plan).toBe('free');
  });
});

describe('GET /v1/admin/overview', () => {
  it('counts users, plans, turns, containers, credits, approvals, jobs and the waitlist', async () => {
    const a = await admin();
    const get = () =>
      call('/v1/admin/overview', { token: a.token }).then((r) =>
        expectContract<Overview>('adminOverview', r, 200),
      );
    const before = await get();

    const now = new Date();
    const pro = await named('Pro Person', `pro-${randomUUID()}@example.com`, { plan: 'pro' });
    const max = await named('Max Person', `max-${randomUUID()}@example.com`, { plan: 'max' });
    const gone = await createUser({ plan: 'pro' });
    await db().update(users).set({ deletedAt: now }).where(eq(users.id, gone.id));
    const old = await createUser();
    await db()
      .update(users)
      .set({ createdAt: new Date(now.getTime() - 10 * DAY) })
      .where(eq(users.id, old.id));

    // Active: sent a message in the last 7 days (the agent's answers don't count).
    await inbound(pro.id, 'hello');
    await inbound(pro.id, 'again');
    await inbound(old.id, 'long ago', new Date(now.getTime() - 9 * DAY));
    await db()
      .insert(messages)
      .values({
        id: newId('msg'),
        userId: max.id,
        conversationId: await webConversationId(max.id),
        channel: 'web',
        direction: 'out',
        text: 'an answer',
      });

    await turn(pro.id, 'done', now);
    await turn(pro.id, 'failed', now);
    await turn(max.id, 'error', new Date(now.getTime() - 3 * DAY));
    await turn(max.id, 'simple', new Date(now.getTime() - 3 * DAY));
    await turn(max.id, 'done', new Date(now.getTime() - 9 * DAY));

    await createGrant({
      userId: pro.id,
      source: 'admin',
      amount: 500,
      expiresAt: null,
      idempotencyKey: `t:${pro.id}`,
      description: 'test',
    });
    await charge(
      pro.id,
      { cheapAi: 30, otherAi: 0, awake: 0, browser: 0, tools: 0 },
      { idempotencyKey: `c:${pro.id}`, description: 'Usage' },
    );

    const approval = (status: 'pending' | 'approved', expiresAt: Date) => ({
      id: newId('apr'),
      userId: pro.id,
      summary: 'Send an email',
      sessionKey: 'web',
      status,
      expiresAt,
    });
    await db()
      .insert(approvals)
      .values([
        approval('pending', new Date(now.getTime() + DAY)),
        approval('pending', new Date(now.getTime() - 1000)),
        approval('approved', new Date(now.getTime() + DAY)),
      ]);

    await db()
      .insert(waitlistEntries)
      .values(
        (['pending', 'invited'] as const).map((status) => ({
          id: newId('wle'),
          email: `${status}-${randomUUID()}@example.com`,
          emailNormalized: `${status}-${randomUUID()}@example.com`,
          status,
          ip: '10.0.0.1',
        })),
      );
    awakeNow = [pro.id, max.id];

    const after = await get();
    const delta = (pick: (o: Overview) => number | null) =>
      (pick(after) ?? 0) - (pick(before) ?? 0);
    // The admin made by `get` was counted in `before`; four more accounts since, one deleted.
    expect(delta((o) => o.users.total)).toBe(3);
    expect(delta((o) => o.users.deleted)).toBe(1);
    expect(delta((o) => o.users.newToday)).toBe(3);
    expect(delta((o) => o.users.new7d)).toBe(3);
    expect(delta((o) => o.users.active7d)).toBe(1);
    expect(delta((o) => o.plans.free)).toBe(1);
    expect(delta((o) => o.plans.pro)).toBe(1);
    expect(delta((o) => o.plans.max)).toBe(1);
    expect(delta((o) => o.turns.today)).toBe(2);
    expect(delta((o) => o.turns.failedToday)).toBe(1);
    expect(delta((o) => o.turns.last7d)).toBe(4);
    expect(delta((o) => o.turns.failed7d)).toBe(2);
    expect(after.containers.awake).toBe(2);
    expect(delta((o) => o.credits.granted)).toBe(500);
    expect(delta((o) => o.credits.spent)).toBe(30);
    expect(after.credits.month).toBe(now.toISOString().slice(0, 7));
    expect(delta((o) => o.approvals.open)).toBe(1);
    expect(after.jobs.failed).toBe(0);
    expect(delta((o) => o.waitlist.total)).toBe(2);
    expect(delta((o) => o.waitlist.pending)).toBe(1);

    // Only numbers: no id, email or name of anyone.
    const text = JSON.stringify(after);
    for (const leak of [pro.id, pro.email, max.name, 'hello']) expect(text).not.toContain(leak);
  });

  it('still answers when the vm-manager is down: the awake count is null', async () => {
    const a = await admin();
    vmDown = true;
    const body = await expectContract<Overview>(
      'adminOverview',
      await call('/v1/admin/overview', { token: a.token }),
      200,
    );
    expect(body.containers.awake).toBeNull();
    expect(body.users.total).toBeGreaterThan(0);
  });
});

describe('GET /v1/admin/users', () => {
  it('lists users newest first, page by page, with what each module knows of them', async () => {
    const a = await admin();
    const tag = randomUUID().slice(0, 8);
    const first = await named(`First ${tag}`, `first-${tag}@example.com`);
    const second = await named(`Second ${tag}`, `second-${tag}@Example.com`, { plan: 'max' });
    const third = await named(`Third ${tag}`, `third-${tag}@example.com`);
    await db().update(users).set({ deletedAt: new Date() }).where(eq(users.id, third.id));
    const suspendedAt = new Date(Date.now() - 60_000);
    await db()
      .update(users)
      .set({ status: 'suspended', suspendedAt })
      .where(eq(users.id, first.id));

    // Second: 120 credits, less 20 charged; Telegram linked; Claude Code; two apps, one active.
    await createGrant({
      userId: second.id,
      source: 'monthly',
      amount: 120,
      expiresAt: new Date(Date.now() + 30 * DAY),
      idempotencyKey: `m:${second.id}`,
      description: 'monthly',
    });
    await charge(
      second.id,
      { cheapAi: 0, otherAi: 20, awake: 0, browser: 0, tools: 0 },
      { idempotencyKey: `c:${second.id}`, description: 'Usage' },
    );
    await db()
      .insert(channelLinks)
      .values({
        id: newId('lnk'),
        userId: second.id,
        channel: 'telegram',
        externalId: `chat-${tag}`,
        displayId: `@secret_handle_${tag}`,
      });
    await db().insert(agentSettings).values({ userId: second.id, runtime: 'claude_code' });
    await db()
      .insert(connections)
      .values([
        {
          id: newId('con'),
          userId: second.id,
          app: 'gmail',
          composioAccountId: `ca_${tag}_1`,
          status: 'active',
          accountLabel: `inbox-${tag}@acme.com`,
        },
        {
          id: newId('con'),
          userId: second.id,
          app: 'github',
          composioAccountId: `ca_${tag}_2`,
          status: 'expired',
        },
      ]);
    const sentAt = new Date(Date.now() - 3600_000);
    await inbound(second.id, `private words ${tag}`, sentAt);

    const list = (q: string) =>
      call(`/v1/admin/users${q}`, { token: a.token }).then((r) =>
        expectContract<Page>('adminListUsers', r, 200),
      );

    // Search by part of the name, any letter case: newest first, two to a page.
    const p1 = await list(`?query=${tag.toUpperCase()}&limit=2`);
    expect(p1.items.map((u) => u.id)).toEqual([third.id, second.id]);
    expect(p1.nextCursor).toBe(second.id);
    const p2 = await list(`?query=${tag}&limit=2&cursor=${p1.nextCursor}`);
    expect(p2.items.map((u) => u.id)).toEqual([first.id]);
    expect(p2.nextCursor).toBeNull();

    const s = p1.items[1]!;
    expect(s).toEqual({
      id: second.id,
      email: `second-${tag}@Example.com`,
      emailVerified: true,
      name: `Second ${tag}`,
      timezone: 'UTC',
      plan: 'max',
      role: 'user',
      status: 'active',
      suspendedAt: null,
      flagged: false,
      createdAt: expect.any(String),
      deletedAt: null,
      lastActiveAt: sentAt.toISOString(),
      credits: 100,
      engine: 'claude_code',
      channels: ['telegram'],
      connectedApps: 1,
      onboardingCompletedAt: null,
      gettingStartedDismissedAt: null,
    });
    expect(p1.items[0]).toMatchObject({ id: third.id, status: 'deleted', engine: 'hermes' });
    expect(p1.items[0]!.deletedAt).not.toBeNull();
    expect(p2.items[0]).toMatchObject({
      credits: 0,
      channels: [],
      connectedApps: 0,
      status: 'suspended',
      suspendedAt: suspendedAt.toISOString(),
    });
    expect(p2.items[0]!.lastActiveAt).toBeNull();

    // By part of an email, in another case; by a whole id; nothing for a part of an id.
    expect((await list(`?query=SECOND-${tag}@example`)).items.map((u) => u.id)).toEqual([
      second.id,
    ]);
    expect((await list(`?query=${first.id}`)).items.map((u) => u.id)).toEqual([first.id]);
    expect((await list(`?query=${first.id.slice(0, -2)}`)).items).toEqual([]);
    // `%` and `_` are letters, not wildcards.
    expect((await list(`?query=${encodeURIComponent('%')}`)).items).toEqual([]);
    expect((await list(`?query=_${tag}`)).items).toEqual([]);

    // Without a query: every user, newest first.
    const all = await list('?limit=100');
    expect(all.items.length).toBeGreaterThanOrEqual(4);
    expect(all.items.map((u) => u.id)).toEqual([...all.items.map((u) => u.id)].sort().reverse());

    // Nothing private: no chat handle, app account, message text or Clerk id.
    const text = JSON.stringify(p1);
    for (const leak of [`@secret_handle_${tag}`, `inbox-${tag}`, `ca_${tag}`, 'private words'])
      expect(text).not.toContain(leak);
    expect(text).not.toContain(second.clerkId);
    expect(text).not.toContain('clerkId');
  });

  it('refuses a bad query or limit', async () => {
    const a = await admin();
    await expectContract(
      'adminListUsers',
      await call(`/v1/admin/users?query=${'x'.repeat(201)}`, { token: a.token }),
      400,
    );
    await expectContract(
      'adminListUsers',
      await call('/v1/admin/users?limit=500', { token: a.token }),
      400,
    );
  });
});

describe('GET /v1/admin/users/{userId}', () => {
  it("shows one user's details and nothing they or the agent wrote", async () => {
    const a = await admin();
    const u = await member(300, 'pro');
    const key = [...llm.keys.values()].find((k) => k.userId === u.id)!.key;
    const secret = (what: string) => `SECRET-${what}-${u.id}`;

    await db()
      .insert(subscriptions)
      .values({
        id: newId('sub'),
        userId: u.id,
        plan: 'pro',
        polarSubscriptionId: `polar-${u.id}`,
        status: 'active',
        periodStart: new Date(Date.now() - DAY),
        periodEnd: new Date(Date.now() + 29 * DAY),
      });
    await charge(
      u.id,
      { cheapAi: 0, otherAi: 7, awake: 1, browser: 0, tools: 0 },
      { idempotencyKey: `c:${u.id}`, description: 'Usage: AI 7, awake time 1' },
    );
    await inbound(u.id, secret('message'));
    await db()
      .insert(memories)
      .values({ id: newId('mem'), userId: u.id, content: secret('memory') });
    await db()
      .insert(byokKeys)
      .values({
        id: newId('byok'),
        userId: u.id,
        provider: 'anthropic',
        keyEncrypted: secret('byok'),
        last4: 'Z9Q8',
      });
    await db()
      .insert(userMcpServers)
      .values({
        id: newId('mcp'),
        userId: u.id,
        name: 'notes',
        url: 'https://mcp.example.com',
        domain: 'mcp.example.com',
        authSecret: secret('mcp'),
      });
    await db()
      .insert(connections)
      .values({
        id: newId('con'),
        userId: u.id,
        app: 'gmail',
        composioAccountId: secret('composio'),
        status: 'active',
        accountLabel: secret('label'),
      });
    await db()
      .insert(automations)
      .values({
        id: newId('aut'),
        userId: u.id,
        kind: 'repeat',
        title: 'Morning brief',
        instruction: secret('instruction'),
        cron: '0 8 * * 1-5',
        timezone: 'UTC',
        sessionKey: 'web',
        nextRunAt: new Date('2026-10-15T08:00:00Z'),
      });
    await db()
      .insert(crewJobs)
      .values({
        id: newId('crj'),
        userId: u.id,
        member: 'byte',
        status: 'done',
        source: 'app',
        owner: 'acme',
        repo: 'web',
        instructions: secret('brief'),
        report: secret('report'),
        sessionKey: 'web',
        finishedAt: new Date(),
      });
    await turn(u.id, 'done', new Date());
    await db()
      .insert(auditLog)
      .values({
        id: newId('aud'),
        userId: u.id,
        actor: 'agent',
        action: 'send_message',
        summary: 'Sent a message (12 chars)',
        details: { args: { text: secret('args') } },
      });

    const body = await expectContract<{
      user: AdminUser;
      subscription: { plan: string; status: string };
      credits: { balance: number; grants: Array<{ remaining: number }> };
      ledger: Array<{ delta: number; description: string }>;
      apps: unknown[];
      automations: unknown[];
      crewJobs: unknown[];
      turns: Array<{ outcome: string; answeredMs: number; stages: Array<{ name: string }> }>;
      activity: Array<{ action: string; summary: string }>;
      agent: unknown;
      container: unknown;
    }>('adminGetUser', await call(`/v1/admin/users/${u.id}`, { token: a.token }), 200);

    expect(body.user).toMatchObject({ id: u.id, plan: 'pro', credits: 292, status: 'active' });
    expect(body.subscription).toMatchObject({ plan: 'pro', status: 'active' });
    expect(body.credits.balance).toBe(292);
    expect(body.ledger[0]).toMatchObject({ delta: -8, description: 'Usage: AI 7, awake time 1' });
    expect(body.apps).toEqual([
      { app: 'gmail', name: 'Gmail', status: 'active', connectedAt: expect.any(String) },
    ]);
    expect(body.automations).toEqual([
      {
        id: expect.any(String),
        title: 'Morning brief',
        kind: 'repeat',
        preset: null,
        enabled: true,
        pausedReason: null,
        nextRunAt: '2026-10-15T08:00:00.000Z',
        lastRunAt: null,
        createdAt: expect.any(String),
      },
    ]);
    expect(body.crewJobs).toEqual([
      {
        id: expect.any(String),
        member: 'byte',
        status: 'done',
        source: 'app',
        repo: 'acme/web',
        createdAt: expect.any(String),
        finishedAt: expect.any(String),
      },
    ]);
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0]).toMatchObject({ outcome: 'done', answeredMs: 9800 });
    expect(body.turns[0]!.stages.map((s) => s.name)).toEqual([
      'queue',
      'prepare',
      'route',
      'wake',
      'context',
      'handover',
    ]);
    expect(body.activity).toContainEqual(
      expect.objectContaining({ action: 'send_message', summary: 'Sent a message (12 chars)' }),
    );
    expect(body.agent).toEqual({
      runtime: 'hermes',
      effectiveRuntime: 'hermes',
      aiAccess: 'own_key',
      claudeConnected: false,
    });
    expect(body.container).toEqual({ state: 'busy', lastActiveAt: '2026-10-14T09:30:00.000Z' });

    // Nothing written by the user or the agent, no key, no token, no secret, no account name.
    const text = JSON.stringify(body);
    expect(text).not.toContain('SECRET-');
    // (The test user's email is made from its Clerk id, so the field's name is checked.)
    for (const leak of [key, 'Z9Q8', 'clerkId', 'details', 'instruction', 'report'])
      expect(text).not.toContain(leak);
  });

  it('shows the container as null when the vm-manager is down, and 404 for no such user', async () => {
    const a = await admin();
    const u = await createUser();
    vmDown = true;
    const body = await expectContract<{ container: unknown }>(
      'adminGetUser',
      await call(`/v1/admin/users/${u.id}`, { token: a.token }),
      200,
    );
    expect(body.container).toBeNull();
    await expectContract(
      'adminGetUser',
      await call('/v1/admin/users/usr_missing', { token: a.token }),
      404,
    );
  });
});

describe('PATCH /v1/admin/users/{userId}: the plan by hand', () => {
  it('moves the user the way a paid change does, once, in the log with the admin and the reason', async () => {
    const a = await admin();
    const u = await member(100, 'pro');
    const keyOf = () => [...llm.keys.values()].find((k) => k.userId === u.id)!;
    await db()
      .insert(subscriptions)
      .values({
        id: newId('sub'),
        userId: u.id,
        plan: 'pro',
        polarSubscriptionId: `polar-${u.id}`,
        status: 'active',
      });

    const res = await expectContract<{
      plan: string;
      previousPlan: string;
      changed: boolean;
      subscription: { plan: string; status: string };
    }>(
      'adminUpdateUser',
      await call(
        `/v1/admin/users/${u.id}`,
        patch(a.token, { plan: 'max', reason: 'Testing Scout' }),
      ),
      200,
    );
    expect(res).toEqual({
      userId: u.id,
      plan: 'max',
      previousPlan: 'pro',
      changed: true,
      // The Polar subscription is still Pro: its next event can set the plan again.
      subscription: expect.objectContaining({ plan: 'pro', status: 'active' }),
    });
    expect((await getActiveUser(u.id))!.plan).toBe('max');
    expect(keyOf().models).toEqual(keyModelsForPlan('max'));
    const log = () =>
      db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, 'plan_changed')));
    expect((await log()).map((e) => [e.actor, e.summary, e.details])).toEqual([
      [
        'admin',
        'Plan set to Max by hand (no payment): Testing Scout',
        { from: 'pro', to: 'max', adminId: a.id },
      ],
    ]);

    // The same plan again changes nothing and writes nothing.
    const again = await expectContract<{ changed: boolean }>(
      'adminUpdateUser',
      await call(`/v1/admin/users/${u.id}`, patch(a.token, { plan: 'max' })),
      200,
    );
    expect(again.changed).toBe(false);
    expect(await log()).toHaveLength(1);

    // Down to Free: the cheap model only.
    await call(`/v1/admin/users/${u.id}`, patch(a.token, { plan: 'free' }));
    expect(keyOf().models).toEqual(keyModelsForPlan('free'));
  });

  it('refuses a bad plan, an unknown field, a missing user and a deleted account', async () => {
    const a = await admin();
    const u = await createUser();
    const send = (id: string, body: unknown) => call(`/v1/admin/users/${id}`, patch(a.token, body));
    await expectContract('adminUpdateUser', await send(u.id, { plan: 'gold' }), 400);
    await expectContract('adminUpdateUser', await send(u.id, { plan: 'max', role: 'admin' }), 400);
    await expectContract('adminUpdateUser', await send(u.id, {}), 400);
    await expectContract('adminUpdateUser', await send('usr_missing', { plan: 'max' }), 404);
    await db().update(users).set({ deletedAt: new Date() }).where(eq(users.id, u.id));
    await expectContract('adminUpdateUser', await send(u.id, { plan: 'max' }), 409);
    const [row] = await db().select().from(users).where(eq(users.id, u.id));
    expect(row!.plan).toBe('free');
    expect(row!.role).toBe('user');
  });
});
