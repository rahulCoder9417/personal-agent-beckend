// App connections must not stay "pending" (HLD 5.1 + 5.2 check-connection). A connect link saves
// the connection as pending; the server then asks Composio itself a few times over the next
// minutes, so it finishes with no webhook and no web app listing the apps.
import type { Job, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { devUser } from '../scripts/dev-user.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import {
  CONNECTION_CHECK_DELAYS_MS,
  disconnect,
  startConnect,
} from '../src/modules/integrations/apps.ts';
import { handleCheckConnection } from '../src/modules/integrations/jobs.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { IGNORED } from '../src/worker/ignored.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakeComposio, installFakeVm } from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({ gmail: 'ac_gmail', github: 'ac_github' });
resetConfig();

let composio: Awaited<ReturnType<typeof installFakeComposio>>;

beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(async () => {
  installFakeVm();
  composio = await installFakeComposio();
});

const rowsOf = (userId: string) =>
  db().select().from(connections).where(eq(connections.userId, userId));

/** The queued (delayed) check jobs of one connection, oldest first. */
async function checkJobs(connectionId: string): Promise<Job[]> {
  const jobs = await queue('system').getJobs(['delayed', 'waiting', 'active', 'completed']);
  return jobs
    .filter((j) => j.name === 'check-connection' && j.data.connectionId === connectionId)
    .sort((a, b) => a.data.attempt - b.data.attempt);
}

/** A user who just got a Gmail connect link. */
async function connecting() {
  const user = await chatUser();
  await startConnect(user.id, user.plan, 'gmail');
  const [conn] = await rowsOf(user.id);
  const says = (status: string, label: string | null = 'work@acme.com') =>
    composio.state.accounts.set(user.id, [
      { id: conn!.composioAccountId, toolkit: 'gmail', status, label },
    ]);
  return { user, conn: conn!, says };
}

/** Runs the newest queued check the way the worker would. */
async function runLatestCheck(connectionId: string): Promise<unknown> {
  const jobs = await checkJobs(connectionId);
  return handleCheckConnection(jobs[jobs.length - 1]!);
}

describe('app connections: the server finishes the job itself', () => {
  it('a connect link saves the connection as pending and queues the first check', async () => {
    const { user, conn } = await connecting();
    expect(conn.status).toBe('pending');
    const jobs = await checkJobs(conn.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toMatchObject({ userId: user.id, connectionId: conn.id, attempt: 0 });
    expect(jobs[0]!.opts.delay).toBe(15_000);
    expect(await jobs[0]!.getState()).toBe('delayed');
  });

  it('becomes active once Composio says so, with no webhook and no app list', async () => {
    const { user, conn, says } = await connecting();
    says('ACTIVE');
    expect(await runLatestCheck(conn.id)).toEqual({ status: 'active' });
    const [row] = await rowsOf(user.id);
    expect(row).toMatchObject({ status: 'active', accountLabel: 'work@acme.com' });
    expect(await checkJobs(conn.id)).toHaveLength(1); // resolved: no further check
  });

  it("copies Composio's other outcomes too (expired, failed)", async () => {
    const a = await connecting();
    a.says('EXPIRED');
    expect(await runLatestCheck(a.conn.id)).toEqual({ status: 'expired' });
    const b = await connecting();
    b.says('FAILED');
    expect(await runLatestCheck(b.conn.id)).toEqual({ status: 'error' });
    expect((await rowsOf(b.user.id))[0]!.status).toBe('error');
  });

  it('keeps checking while it is pending, then stops after six checks', async () => {
    const { user, conn, says } = await connecting();
    says('INITIATED');
    for (let attempt = 0; attempt < CONNECTION_CHECK_DELAYS_MS.length; attempt++) {
      const jobs = await checkJobs(conn.id);
      expect(jobs).toHaveLength(attempt + 1);
      expect(jobs[attempt]!.opts.delay).toBe(CONNECTION_CHECK_DELAYS_MS[attempt]);
      const last = attempt === CONNECTION_CHECK_DELAYS_MS.length - 1;
      expect(await handleCheckConnection(jobs[attempt]!)).toEqual({
        status: 'pending',
        nextCheck: !last,
      });
    }
    expect(CONNECTION_CHECK_DELAYS_MS).toEqual([15_000, 30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(await checkJobs(conn.id)).toHaveLength(6);
    expect((await rowsOf(user.id))[0]!.status).toBe('pending'); // left as it is
    // Each check asks Composio about this connection's own account.
    expect(composio.state.accountGets.filter((id) => id === conn.composioAccountId)).toHaveLength(
      6,
    );
  });

  it('a check that finds it later in the series resolves it', async () => {
    const { conn, says } = await connecting();
    says('INITIATED');
    await runLatestCheck(conn.id);
    await runLatestCheck(conn.id);
    says('ACTIVE');
    expect(await runLatestCheck(conn.id)).toEqual({ status: 'active' });
    expect(await checkJobs(conn.id)).toHaveLength(3);
  });

  it('re-running a check is safe: the next check is queued once', async () => {
    const { conn, says } = await connecting();
    says('INITIATED');
    const [first] = await checkJobs(conn.id);
    await handleCheckConnection(first!);
    await handleCheckConnection(first!);
    expect(await checkJobs(conn.id)).toHaveLength(2);
  });

  it('Composio being down during a check just means the next check', async () => {
    const { user, conn, says } = await connecting();
    says('ACTIVE');
    composio.state.accountsError = new Error('composio is down');
    expect(await runLatestCheck(conn.id)).toEqual({ status: 'pending', nextCheck: true });
    expect((await rowsOf(user.id))[0]!.status).toBe('pending');
    expect(await runLatestCheck(conn.id)).toEqual({ status: 'active' });
  });

  it('does nothing once the webhook got there first, or after a disconnect', async () => {
    const a = await connecting();
    await call('/webhooks/composio', {
      method: 'POST',
      body: { kind: 'connection', accountId: a.conn.composioAccountId, status: 'active' },
      headers: {
        'webhook-signature': 'valid',
        'webhook-id': `w-${a.conn.id}`,
        'webhook-timestamp': '1',
      },
    });
    const { handleComposioEvent } = await import('../src/modules/integrations/jobs.ts');
    const evt = (await queue('system').getJobs(['waiting'])).find(
      (j) => j.name === 'composio-event',
    );
    await handleComposioEvent(evt!);
    expect((await rowsOf(a.user.id))[0]!.status).toBe('active');
    expect(await runLatestCheck(a.conn.id)).toBe(IGNORED);

    const b = await connecting();
    await disconnect(b.user.id, b.conn.id);
    expect(await runLatestCheck(b.conn.id)).toBe(IGNORED);
    expect(composio.state.accountGets).toEqual([]); // Composio wasn't asked either time
    expect(await checkJobs(b.conn.id)).toHaveLength(1);
  });

  it('connecting the same app again starts a new series of checks', async () => {
    const { user, conn } = await connecting();
    // Composio hands back the same account for the second link.
    const { setComposioApi, composio: api } =
      await import('../src/modules/integrations/composio.ts');
    setComposioApi({
      ...api(),
      connectLink: async () => ({
        accountId: conn.composioAccountId,
        redirectUrl: 'https://x.test',
      }),
    });
    await new Promise((r) => setTimeout(r, 5));
    await startConnect(user.id, user.plan, 'gmail');
    expect(await rowsOf(user.id)).toHaveLength(1);
    const jobs = await checkJobs(conn.id);
    expect(jobs.map((j) => j.data.attempt)).toEqual([0, 0]);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(2);
  });

  it('GET /v1/apps still refreshes, and shows the connection once it is active', async () => {
    const { user, says } = await connecting();
    const before = await expectContract<{
      items: Array<{ slug: string; connections: Array<{ status: string }> }>;
    }>('listApps', await call('/v1/apps', { token: user.token }), 200);
    expect(before.items.find((a) => a.slug === 'gmail')!.connections).toEqual([]);
    says('ACTIVE');
    const after = await expectContract<typeof before>(
      'listApps',
      await call('/v1/apps', { token: user.token }),
      200,
    );
    expect(after.items.find((a) => a.slug === 'gmail')!.connections).toMatchObject([
      { status: 'active' },
    ]);
  });

  it('dev-user: connect-app queues the check, status shows the refreshed state', async () => {
    const userId = (await devUser(['create', '--email', 'apps@example.com']))[0]!.split(' ')[1]!;
    const out = await devUser(['connect-app', '--user', userId, '--app', 'github']);
    expect(out[0]).toMatch(/^open https:\/\/composio\.test\//);
    expect(out[1]).toBe("sign-in: Composio's connect page first, then the provider's");
    const [conn] = await rowsOf(userId);
    expect(await checkJobs(conn!.id)).toHaveLength(1);
    expect((await devUser(['status', '--user', userId])).join('\n')).toContain(
      'apps github:pending',
    );

    composio.state.accounts.set(userId, [
      { id: conn!.composioAccountId, toolkit: 'github', status: 'ACTIVE', label: null },
    ]);
    expect((await devUser(['status', '--user', userId])).join('\n')).toContain(
      'apps github:active',
    );
  });
});

describe('app connections: the worker runs the check', () => {
  let workers: Worker[];
  beforeAll(() => {
    workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
  });
  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close()));
  });

  it('check-connection is a registered system job: when it is due the connection turns active', async () => {
    const { user, conn, says } = await connecting();
    says('ACTIVE');
    const [job] = await checkJobs(conn.id);
    await job!.promote(); // "15 seconds later"
    await waitFor(async () => (await rowsOf(user.id))[0]!.status === 'active');
    // The row is written before the job is marked done: wait for that too.
    await waitFor(async () => (await job!.getState()) === 'completed');
  });
});
