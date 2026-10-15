// One connection per account (docs/composio.md, section 9, "Switching an app that people already
// use"): Tex uses the newest active connection of an app; when the same account of an app is
// connected again (to move to our own sign-in app, or after it expired), the user's app-event
// automations move to the new connection and the older one is removed at Composio and here. A
// second account of the same app ("Add account") is never removed. Every step is safe to re-run.
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createAutomation,
  getAutomation,
  moveAppTriggers,
} from '../src/modules/automations/automations.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import {
  connectionForToolkit,
  recheckConnection,
  refreshPendingConnections,
  setConnectionStatus,
} from '../src/modules/integrations/apps.ts';
import type { ComposioAccount } from '../src/modules/integrations/composio.ts';
import { settleConnection } from '../src/modules/integrations/connection-replace.ts';
import { handleSettleConnection } from '../src/modules/integrations/jobs.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { redis } from '../src/shared/redis.ts';
import { IGNORED } from '../src/worker/ignored.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm } from './fakes.ts';
import { chatUser } from './helpers.ts';

type Fake = Awaited<ReturnType<typeof installFakeComposio>>;
let composio: Fake;

beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(async () => {
  installFakeVm();
  composio = await installFakeComposio();
});

type Status = 'pending' | 'active' | 'expired' | 'error';

/** One of our connection rows, `minutesAgo` old, with the same account at Composio. */
async function connection(
  userId: string,
  input: {
    app?: string;
    status?: Status;
    label?: string | null;
    composioLabel?: string | null;
    minutesAgo: number;
  },
) {
  const app = input.app ?? 'gmail';
  const id = newId('con');
  const accountId = `ca_${id}`;
  const label = input.label === undefined ? null : input.label;
  await db()
    .insert(connections)
    .values({
      id,
      userId,
      app,
      composioAccountId: accountId,
      status: input.status ?? 'active',
      accountLabel: label,
      createdAt: new Date(Date.now() - input.minutesAgo * 60_000),
    });
  const acc: ComposioAccount = {
    id: accountId,
    toolkit: app,
    status: (input.status ?? 'active').toUpperCase(),
    label: input.composioLabel === undefined ? label : input.composioLabel,
  };
  composio.state.accounts.set(userId, [...(composio.state.accounts.get(userId) ?? []), acc]);
  return { id, accountId };
}

const rowsOf = (userId: string) =>
  db().select().from(connections).where(eq(connections.userId, userId));

const triggerOf = (triggerRef: string | null) =>
  composio.triggers.find((t) => t.triggerId === triggerRef);

async function emailAutomation(userId: string, event = 'GMAIL_NEW_GMAIL_MESSAGE') {
  return createAutomation({
    userId,
    title: 'boss mail',
    instruction: 'Tell me',
    sessionKey: 'web',
    trigger: { app: 'gmail', event, config: { query: 'from:boss' } },
  });
}

const jobFor = (userId: string, connectionId: string) =>
  ({ data: { userId, connectionId } }) as Job;

describe('Tex uses the newest active connection', () => {
  it('of two active accounts of an app, the newest; never a pending one', async () => {
    const user = await chatUser();
    await connection(user.id, { label: 'work@example.com', minutesAgo: 60 });
    const newer = await connection(user.id, { label: 'me@example.com', minutesAgo: 30 });
    await connection(user.id, { status: 'pending', minutesAgo: 1 });
    expect((await connectionForToolkit(user.id, 'gmail'))?.id).toBe(newer.id);
  });
});

describe('the same account connected again', () => {
  it('a new connection that becomes active queues the job, once', async () => {
    const user = await chatUser();
    const fresh = await connection(user.id, { status: 'pending', minutesAgo: 1 });
    composio.state.accounts.get(user.id)![0]!.label = 'me@example.com';
    composio.state.accounts.get(user.id)![0]!.status = 'ACTIVE';
    await refreshPendingConnections(user.id);
    await setConnectionStatus(fresh.accountId, 'active'); // the webhook too
    const jobs = (await queue('system').getJobs(['waiting', 'delayed', 'prioritized'])).filter(
      (j) => j.name === 'settle-connection' && j.data.connectionId === fresh.id,
    );
    expect(jobs.map((j) => [j.id, j.data])).toEqual([
      [`settle-conn-${fresh.id}`, { userId: user.id, connectionId: fresh.id }],
    ]);
    // A status other than active queues nothing.
    const other = await connection(user.id, { label: 'x@example.com', minutesAgo: 2 });
    await setConnectionStatus(other.accountId, 'expired');
    expect(await queue('system').getJob(`settle-conn-${other.id}`)).toBeUndefined();
  });

  it('the automations move to the new connection, then the old one is removed', async () => {
    const user = await chatUser({ plan: 'max' });
    const old = await connection(user.id, { label: 'me@example.com', minutesAgo: 60 });
    const a = await emailAutomation(user.id);
    expect(triggerOf(a.triggerRef)?.connectedAccountId).toBe(old.accountId);
    // Connected again, through our own sign-in app. Composio writes the email its own way.
    const fresh = await connection(user.id, { label: 'Me@Example.com ', minutesAgo: 1 });

    const result = await handleSettleConnection(jobFor(user.id, fresh.id));
    expect(result).toEqual({ replaced: [old.id], automationsMoved: 1 });

    const moved = await getAutomation(user.id, a.id);
    expect(moved?.triggerRef).not.toBe(a.triggerRef);
    expect(triggerOf(moved!.triggerRef)).toMatchObject({
      slug: 'GMAIL_NEW_GMAIL_MESSAGE',
      config: { query: 'from:boss' },
      connectedAccountId: fresh.accountId,
    });
    expect(triggerOf(a.triggerRef)).toBeUndefined(); // the old trigger is gone
    expect(composio.triggers).toHaveLength(1);
    expect(composio.state.deletedAccounts).toEqual([old.accountId]);
    expect((await rowsOf(user.id)).map((r) => r.id)).toEqual([fresh.id]);
  });

  it('an expired connection to the same account is replaced too, and its automation works again', async () => {
    const user = await chatUser({ plan: 'max' });
    const old = await connection(user.id, { label: 'me@example.com', minutesAgo: 60 });
    const a = await emailAutomation(user.id);
    await db().update(connections).set({ status: 'expired' }).where(eq(connections.id, old.id));
    const fresh = await connection(user.id, { label: 'me@example.com', minutesAgo: 1 });

    expect(await settleConnection(user.id, fresh.id)).toEqual({
      replaced: [old.id],
      automationsMoved: 1,
    });
    const moved = await getAutomation(user.id, a.id);
    expect(triggerOf(moved!.triggerRef)?.connectedAccountId).toBe(fresh.accountId);
  });

  it("a label we don't have is asked of Composio first", async () => {
    const user = await chatUser();
    const old = await connection(user.id, {
      label: null,
      composioLabel: 'me@example.com',
      minutesAgo: 60,
    });
    const fresh = await connection(user.id, {
      label: null,
      composioLabel: 'me@example.com',
      minutesAgo: 1,
    });
    expect((await settleConnection(user.id, fresh.id))?.replaced).toEqual([old.id]);
    expect((await rowsOf(user.id))[0]).toMatchObject({
      id: fresh.id,
      accountLabel: 'me@example.com', // kept
    });
  });
});

describe('what is never removed', () => {
  it('a second account of the same app ("Add account")', async () => {
    const user = await chatUser({ plan: 'max' });
    const work = await connection(user.id, { label: 'work@example.com', minutesAgo: 60 });
    const a = await emailAutomation(user.id);
    const personal = await connection(user.id, { label: 'me@example.com', minutesAgo: 1 });
    expect(await settleConnection(user.id, personal.id)).toEqual({
      replaced: [],
      automationsMoved: 0,
    });
    expect((await rowsOf(user.id)).map((r) => r.id).sort()).toEqual([work.id, personal.id].sort());
    expect(triggerOf((await getAutomation(user.id, a.id))!.triggerRef)?.connectedAccountId).toBe(
      work.accountId,
    );
    expect(composio.state.deletedAccounts).toEqual([]);
  });

  it('anything, when the account has no label anywhere: it could be a second account', async () => {
    const user = await chatUser();
    await connection(user.id, { label: null, minutesAgo: 60 });
    const fresh = await connection(user.id, { label: null, minutesAgo: 1 });
    expect(await settleConnection(user.id, fresh.id)).toEqual({
      replaced: [],
      automationsMoved: 0,
    });
    expect(await rowsOf(user.id)).toHaveLength(2);
  });

  it('a newer connection, a pending one, or another app', async () => {
    const user = await chatUser();
    const older = await connection(user.id, { label: 'me@example.com', minutesAgo: 60 });
    await connection(user.id, { label: 'me@example.com', minutesAgo: 1 }); // newer
    await connection(user.id, { status: 'pending', label: 'me@example.com', minutesAgo: 90 });
    await connection(user.id, { app: 'googlecalendar', label: 'me@example.com', minutesAgo: 90 });
    // The older one's job (late, or run again) removes nothing: only connections older than it.
    expect((await settleConnection(user.id, older.id))?.replaced).toEqual([]);
    expect(await rowsOf(user.id)).toHaveLength(4);
  });

  it('nothing at all when the new connection is gone or not active', async () => {
    const user = await chatUser();
    await connection(user.id, { label: 'me@example.com', minutesAgo: 60 });
    const failed = await connection(user.id, {
      status: 'error',
      label: 'me@example.com',
      minutesAgo: 1,
    });
    expect(await handleSettleConnection(jobFor(user.id, failed.id))).toBe(IGNORED);
    expect(await handleSettleConnection(jobFor(user.id, 'con_gone'))).toBe(IGNORED);
    expect(await rowsOf(user.id)).toHaveLength(2);
  });
});

describe('safe to re-run', () => {
  it('a second run finds nothing to do', async () => {
    const user = await chatUser({ plan: 'max' });
    await connection(user.id, { label: 'me@example.com', minutesAgo: 60 });
    await emailAutomation(user.id);
    const fresh = await connection(user.id, { label: 'me@example.com', minutesAgo: 1 });
    await settleConnection(user.id, fresh.id);
    const triggersAfterFirst = composio.triggers.map((t) => t.triggerId);
    expect(await settleConnection(user.id, fresh.id)).toEqual({
      replaced: [],
      automationsMoved: 0,
    });
    expect(composio.triggers.map((t) => t.triggerId)).toEqual(triggersAfterFirst);
  });

  it('Composio refusing to remove the old account: the job fails, and the next try finishes', async () => {
    const user = await chatUser({ plan: 'max' });
    const old = await connection(user.id, { label: 'me@example.com', minutesAgo: 60 });
    const a = await emailAutomation(user.id);
    const fresh = await connection(user.id, { label: 'me@example.com', minutesAgo: 1 });
    composio.state.deleteAccountError = new Error('composio is down');
    await expect(settleConnection(user.id, fresh.id)).rejects.toThrow('composio is down');
    // The automation already moved; the old connection is still here.
    const moved = (await getAutomation(user.id, a.id))!.triggerRef;
    expect(triggerOf(moved)?.connectedAccountId).toBe(fresh.accountId);
    expect(await rowsOf(user.id)).toHaveLength(2);

    expect(await settleConnection(user.id, fresh.id)).toEqual({
      replaced: [old.id],
      automationsMoved: 0, // nothing left on the old account
    });
    expect((await getAutomation(user.id, a.id))!.triggerRef).toBe(moved);
    expect(composio.triggers).toHaveLength(1);
  });

  it('an account Composio no longer has counts as removed', async () => {
    const user = await chatUser();
    const old = await connection(user.id, { label: 'me@example.com', minutesAgo: 60 });
    const fresh = await connection(user.id, { label: 'me@example.com', minutesAgo: 1 });
    composio.state.deleteAccountError = Object.assign(new Error('not found'), { status: 404 });
    expect((await settleConnection(user.id, fresh.id))?.replaced).toEqual([old.id]);
  });

  it('a trigger made by a run that stopped half-way is used, not made twice', async () => {
    const user = await chatUser({ plan: 'max' });
    const old = await connection(user.id, { label: 'me@example.com', minutesAgo: 60 });
    const a = await emailAutomation(user.id);
    const fresh = await connection(user.id, { label: 'me@example.com', minutesAgo: 1 });
    // The earlier run made the new trigger, then stopped before saving it. Composio adds a
    // default of its own to the trigger's settings.
    const { createTrigger } = await import('../src/modules/integrations/composio.ts').then((m) =>
      m.composio(),
    );
    const left = await createTrigger(user.id, 'GMAIL_NEW_GMAIL_MESSAGE', fresh.accountId, {
      query: 'from:boss',
    });
    triggerOf(left.triggerId)!.config = { query: 'from:boss', interval: 1 };

    expect(
      await moveAppTriggers({
        userId: user.id,
        toolkit: 'gmail',
        from: old.accountId,
        to: fresh.accountId,
      }),
    ).toBe(1);
    expect((await getAutomation(user.id, a.id))!.triggerRef).toBe(left.triggerId);
    expect(composio.triggers.map((t) => t.triggerId)).toEqual([left.triggerId]);
  });

  it('one run per user at a time', async () => {
    const user = await chatUser();
    const fresh = await connection(user.id, { label: 'me@example.com', minutesAgo: 1 });
    const key = `lock:settle-connection:${user.id}`;
    await redis().set(key, 'someone-else', 'PX', 60_000);
    await expect(settleConnection(user.id, fresh.id)).rejects.toThrow(/being settled/);
    await redis().del(key);
    expect(await settleConnection(user.id, fresh.id)).toEqual({
      replaced: [],
      automationsMoved: 0,
    });
    expect(await redis().exists(key)).toBe(0); // given back
  });
});

describe('an admin recheck that finds the connection active', () => {
  it('queues the job too', async () => {
    const user = await chatUser();
    const conn = await connection(user.id, {
      status: 'pending',
      composioLabel: 'me@example.com',
      minutesAgo: 1,
    });
    composio.state.accounts.get(user.id)![0]!.status = 'ACTIVE';
    await recheckConnection(user.id, conn.id);
    expect(await queue('system').getJob(`settle-conn-${conn.id}`)).toBeTruthy();
    const [row] = await db()
      .select()
      .from(connections)
      .where(and(eq(connections.userId, user.id), eq(connections.id, conn.id)));
    expect(row?.status).toBe('active');
  });
});
