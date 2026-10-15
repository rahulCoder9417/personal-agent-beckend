// The short-lived copy of each user's row (src/modules/auth/user-cache.ts): read on every signed-in
// call, every turn and every tool call, and dropped by every change to the row, so a suspension, a
// plan change or a deletion counts from the next request on.
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { users } from '../src/modules/auth/schema.ts';
import { forgetUser } from '../src/modules/auth/user-cache.ts';
import {
  getUserCached,
  isSuspended,
  markUserDeleted,
  setAccountStatus,
  setPlan,
  upsertUserFromClerk,
} from '../src/modules/auth/users.ts';
import {
  deleteSandboxRecord,
  ensureSandbox,
  userIdForMcpToken,
} from '../src/modules/orchestrator/sandbox.ts';
import { db } from '../src/shared/db/client.ts';
import { redis } from '../src/shared/redis.ts';
import { installDbMeter, meter } from './db-meter.ts';
import { installFakeVm, mcpCall } from './fakes.ts';
import { call, createUser, expectContract } from './helpers.ts';

beforeAll(() => installDbMeter());
afterEach(() => vi.restoreAllMocks());

/** Changes the row behind the app's back (no copy dropped), as only a test would. */
const pokeName = (userId: string, name: string) =>
  db().update(users).set({ name }).where(eq(users.id, userId));

describe('the copy is used', () => {
  it('a signed-in call reads the user from the database once, then from the copy', async () => {
    const u = await createUser();
    const first = await meter(() => call('/v1/crew', { token: u.token }));
    expect(first.queries).toBe(1);
    const second = await meter(() => call('/v1/crew', { token: u.token }));
    expect(second.result.status).toBe(200);
    expect(second.queries).toBe(0);
  });

  it('a row changed without telling the copy shows only once the copy is dropped', async () => {
    const u = await createUser();
    expect((await getUserCached(u.id))?.name).toBe('Test User');
    await pokeName(u.id, 'Changed Behind');
    expect((await getUserCached(u.id))?.name).toBe('Test User');
    await forgetUser(u.id);
    expect((await getUserCached(u.id))?.name).toBe('Changed Behind');
  });

  it('dates come back as dates', async () => {
    const u = await createUser();
    await getUserCached(u.id);
    const copy = await getUserCached(u.id);
    expect(copy?.createdAt).toBeInstanceOf(Date);
    expect(copy?.createdAt.getTime()).toBe(u.createdAt.getTime());
    expect(copy?.deletedAt).toBeNull();
  });

  it('Redis unreachable: the database answers, as before', async () => {
    const u = await createUser();
    vi.spyOn(redis(), 'mget').mockRejectedValue(new Error('redis down'));
    const m = await meter(() => getUserCached(u.id));
    expect(m.result?.id).toBe(u.id);
    expect(m.queries).toBe(1);
  });
});

describe('every change drops the copy', () => {
  it('a suspension refuses the very next call, and lifting it lets the next one in', async () => {
    const u = await createUser();
    expect((await call('/v1/crew', { token: u.token })).status).toBe(200);
    await setAccountStatus(u.id, 'suspended');
    const refused = await call('/v1/crew', { token: u.token });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
      'account_suspended',
    );
    expect(await isSuspended(u.id)).toBe(true);
    await setAccountStatus(u.id, 'active');
    expect((await call('/v1/crew', { token: u.token })).status).toBe(200);
  });

  it('a change inside a transaction: a read before the commit keeps no old copy', async () => {
    const u = await createUser();
    await getUserCached(u.id);
    await db().transaction(async (tx) => {
      await setAccountStatus(u.id, 'suspended', tx);
      // Not committed yet: a read from outside still sees the account active...
      expect(await isSuspended(u.id)).toBe(false);
    });
    // ... but did not keep that as the copy.
    expect(await isSuspended(u.id)).toBe(true);
  });

  it('a plan change shows in the next call', async () => {
    const u = await createUser();
    const before = await expectContract<{ plan: string }>(
      'getMe',
      await call('/v1/me', { token: u.token }),
      200,
    );
    expect(before.plan).toBe('free');
    await setPlan(u.id, 'pro');
    const after = await expectContract<{ plan: string }>(
      'getMe',
      await call('/v1/me', { token: u.token }),
      200,
    );
    expect(after.plan).toBe('pro');
  });

  it('a new name or time zone shows in the next call', async () => {
    const u = await createUser();
    await call('/v1/me', { token: u.token });
    await call('/v1/me', {
      method: 'PATCH',
      token: u.token,
      body: { name: 'New Name', timezone: 'Asia/Kolkata' },
    });
    const me = await expectContract<{ name: string; timezone: string }>(
      'getMe',
      await call('/v1/me', { token: u.token }),
      200,
    );
    expect(me).toMatchObject({ name: 'New Name', timezone: 'Asia/Kolkata' });
  });

  it("the first-run marks show in the next call: the user's own, and an admin's reset", async () => {
    const u = await createUser();
    const admin = await createUser({ role: 'admin' });
    const me = async () =>
      expectContract<{ onboardingCompletedAt: string | null }>(
        'getMe',
        await call('/v1/me', { token: u.token }),
        200,
      );
    expect((await me()).onboardingCompletedAt).toBeNull();
    await call('/v1/me', { method: 'PATCH', token: u.token, body: { onboardingCompleted: true } });
    expect((await me()).onboardingCompletedAt).not.toBeNull();
    const reset = await call(`/v1/admin/users/${u.id}/onboarding/reset`, {
      method: 'POST',
      token: admin.token,
      body: { reason: 'support' },
    });
    expect(reset.status).toBe(200);
    expect((await me()).onboardingCompletedAt).toBeNull();
  });

  it("Clerk's update (a new role) shows in the next call", async () => {
    const u = await createUser();
    await call('/v1/me', { token: u.token });
    await upsertUserFromClerk({
      clerkId: u.clerkId,
      email: u.email,
      emailVerified: true,
      name: u.name,
      role: 'admin',
    });
    const me = await expectContract<{ role: string }>(
      'getMe',
      await call('/v1/me', { token: u.token }),
      200,
    );
    expect(me.role).toBe('admin');
  });

  it('a deleted account is refused at the next call', async () => {
    const u = await createUser();
    expect((await call('/v1/crew', { token: u.token })).status).toBe(200);
    await markUserDeleted(u.clerkId);
    expect((await call('/v1/crew', { token: u.token })).status).toBe(401);
  });
});

describe("the container token's owner", () => {
  it('is read from the database once, then from Redis; removing the record stops the token at once', async () => {
    const vm = installFakeVm();
    const u = await createUser();
    await ensureSandbox(u.id);
    const token = vm.tokens.get(u.id)!;
    const first = await meter(() => userIdForMcpToken(token));
    expect(first).toMatchObject({ result: u.id, queries: 1 });
    const second = await meter(() => userIdForMcpToken(token));
    expect(second).toMatchObject({ result: u.id, queries: 0 });
    expect((await mcpCall(token, 'get_profile', {})).isError).toBe(false);

    await deleteSandboxRecord(u.id);
    expect(await userIdForMcpToken(token)).toBeNull();
    const refused = await mcpCall(token, 'get_profile', {});
    expect(refused).toMatchObject({ isError: true, text: 'Unauthorized' });
  });

  it('a made-up token is refused and nothing is kept for it', async () => {
    const m = await meter(() => userIdForMcpToken('not-a-real-token'));
    expect(m.result).toBeNull();
    expect((await meter(() => userIdForMcpToken('not-a-real-token'))).queries).toBe(1);
  });
});
