// A new account's first moments: Clerk's webhook creates the account (usually a moment before the
// web app's first page opens), or the first calls of a session do it when they arrive first. With
// the database on Neon in Ohio every round trip costs about 260 ms from Mumbai, so the calls of
// the first page should find the user in its copy in Redis (user-cache.ts) instead of each looking
// it up, and Clerk saying again what we already have must not drop that copy.
//
// `PERF_RTT_MS=260 pnpm vitest run test/new-account-sign-in.test.ts` makes every query wait 260 ms
// and prints what the first page cost.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { provisionUser } from '../src/modules/auth/provision.ts';
import { users } from '../src/modules/auth/schema.ts';
import type * as Users from '../src/modules/auth/users.ts';
import { getUserCached, type ClerkUserData } from '../src/modules/auth/users.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { db, pingDb } from '../src/shared/db/client.ts';
import { redis } from '../src/shared/redis.ts';
import { installDbMeter, meter, setDbDelays } from './db-meter.ts';
import { installFakeVm } from './fakes.ts';
import { call, sessionToken } from './helpers.ts';

/** What Clerk's Backend API answers for a user, and how often it was asked. */
const clerk = vi.hoisted(() => ({ users: new Map<string, unknown>(), asked: 0 }));

vi.mock('../src/modules/auth/users.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Users>();
  return {
    ...real,
    fetchClerkUser: async (clerkId: string) => {
      clerk.asked++;
      // Clerk is far away too.
      await new Promise((r) => setTimeout(r, 50));
      return clerk.users.get(clerkId);
    },
  };
});

const RTT_MS = Number(process.env.PERF_RTT_MS ?? 0);
const report: string[] = [];

beforeAll(() => {
  installDbMeter();
  installFakeVm();
});
beforeEach(async () => {
  clerk.asked = 0;
  await pingDb();
});
afterAll(async () => {
  await closeQueues();
  if (RTT_MS) {
    console.log(
      [
        `A new account's first calls (each query waits ${RTT_MS} ms)`,
        '| What | Queries | Time |',
        '|---|---|---|',
        ...report,
      ].join('\n'),
    );
  }
});

function newClerkUser(): ClerkUserData {
  const clerkId = `user_${randomUUID()}`;
  return {
    clerkId,
    email: `${clerkId}@example.com`,
    emailVerified: true,
    name: 'New Person',
    role: 'user',
  };
}

const changedMark = (userId: string) => redis().exists(`user:changed:${userId}`);

async function ok(path: string, token: string): Promise<void> {
  const res = await call(path, { token });
  expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
  await res.arrayBuffer();
}

/** What the welcome flow asks for when it opens: the account, the chats, the apps, the AI. */
const WELCOME_PAGE = ['/v1/me', '/v1/channels', '/v1/apps', '/v1/agent/settings'];
/** Their own queries, the user aside (see read-round-trips.test.ts): 1 + 1 + 2 + 2. */
const WELCOME_PAGE_QUERIES = 6;

async function measured(what: string, fn: () => Promise<unknown>) {
  const m = await meter(async () => {
    setDbDelays({ rttMs: RTT_MS });
    try {
      await fn();
    } finally {
      setDbDelays({});
    }
  });
  report.push(`| ${what} | ${m.queries} | ${(m.ms / 1000).toFixed(2)} s |`);
  return m;
}

describe('the account made by the webhook', () => {
  it('has its copy ready, so the first calls do not look the user up', async () => {
    const data = newClerkUser();
    // What the worker's clerk-event job does for `user.created`.
    const user = await provisionUser(data);
    const token = await sessionToken(data.clerkId);

    // /v1/crew makes no query of its own: anything counted here would be the user's look-up.
    const first = await meter(() => ok('/v1/crew', token));
    expect(first.queries, first.sql.join('\n')).toBe(0);
    expect((await getUserCached(user.id))?.id).toBe(user.id);
  });

  it('opens the welcome flow with the page’s own queries only', async () => {
    const data = newClerkUser();
    await provisionUser(data);
    const token = await sessionToken(data.clerkId);
    const m = await measured('Welcome flow, account made by the webhook (4 calls at once)', () =>
      Promise.all(WELCOME_PAGE.map((path) => ok(path, token))),
    );
    expect(m.queries, m.sql.join('\n')).toBeLessThanOrEqual(WELCOME_PAGE_QUERIES);
  });
});

describe('Clerk saying it again', () => {
  it('the same details again (a later "user updated", or the webhook after the first calls) keep the copy', async () => {
    const data = newClerkUser();
    const user = await provisionUser(data);
    const token = await sessionToken(data.clerkId);

    const again = await meter(() => provisionUser({ ...data, name: 'A New Name At Clerk' }));
    // One try at the insert, one read of the row: nothing written.
    expect(again.queries, again.sql.join('\n')).toBe(2);
    expect(again.sql.some((line) => /\bupdate\b/i.test(line))).toBe(false);
    expect(await changedMark(user.id)).toBe(0);

    const next = await meter(() => ok('/v1/crew', token));
    expect(next.queries, next.sql.join('\n')).toBe(0);
  });

  it('a real change still counts from the very next call', async () => {
    const data = newClerkUser();
    const user = await provisionUser(data);
    expect((await getUserCached(user.id))?.role).toBe('user');

    await provisionUser({ ...data, role: 'admin' });
    expect((await getUserCached(user.id))?.role).toBe('admin');
    expect(await changedMark(user.id)).toBe(1);

    await provisionUser({
      ...data,
      role: 'admin',
      email: 'moved@example.com',
      emailVerified: false,
    });
    const row = await getUserCached(user.id);
    expect(row?.email).toBe('moved@example.com');
    expect(row?.emailVerified).toBe(false);
  });
});

describe('the first calls arriving before the webhook', () => {
  it('share one look-up at Clerk and one new row, and leave the copy usable', async () => {
    const data = newClerkUser();
    clerk.users.set(data.clerkId, data);
    const token = await sessionToken(data.clerkId);

    const burst = await measured('Chat page before the webhook (8 calls at once)', () =>
      Promise.all(
        [
          '/v1/me',
          '/v1/crew',
          '/v1/agent/status',
          '/v1/approvals?status=pending&limit=50',
          '/v1/channels',
          '/v1/conversations?limit=30&kind=chat',
          '/v1/conversations?limit=1&kind=automations',
          '/v1/automations',
        ].map((path) => ok(path, token)),
      ),
    );
    expect(clerk.asked).toBe(1);
    const rows = await db().select().from(users).where(eq(users.clerkId, data.clerkId));
    expect(rows).toHaveLength(1);
    // Nobody wrote the row a second time, so nothing dropped the copy.
    expect(burst.sql.filter((line) => /^\d+ms update "users"/i.test(line))).toHaveLength(0);
    expect(await changedMark(rows[0]!.id)).toBe(0);

    // Clerk's webhook comes after, with the same details: still nothing to write.
    await provisionUser(data);
    expect(await changedMark(rows[0]!.id)).toBe(0);
    const next = await meter(() => ok('/v1/crew', token));
    expect(next.queries, next.sql.join('\n')).toBe(0);
  });

  it('an account Clerk doesn’t know is refused, and asked about again next time', async () => {
    const token = await sessionToken(`user_${randomUUID()}`);
    const res = await Promise.all([call('/v1/crew', { token }), call('/v1/me', { token })]);
    expect(res.map((r) => r.status)).toEqual([401, 401]);
    expect(clerk.asked).toBe(1);
    expect((await call('/v1/crew', { token })).status).toBe(401);
    expect(clerk.asked).toBe(2);
  });
});
