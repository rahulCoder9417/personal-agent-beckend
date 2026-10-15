// The web app's first-run marks on GET/PATCH /v1/me: when the welcome steps were finished or
// skipped, and when the "Getting started" checklist was closed. No backfill: accounts made before
// the columns existed start with both empty, like new ones. An admin can clear both for one user.
import { readFileSync } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { users } from '../src/modules/auth/schema.ts';
import { getUser } from '../src/modules/auth/users.ts';
import { db } from '../src/shared/db/client.ts';
import { call, createUser, expectContract, sessionToken } from './helpers.ts';

type Me = {
  id: string;
  name: string;
  onboardingCompletedAt: string | null;
  gettingStartedDismissedAt: string | null;
};

const getMe = async (token: string) =>
  expectContract<Me>('getMe', await call('/v1/me', { token }), 200);
const patchMe = async (token: string, body: unknown, status = 200) =>
  expectContract<Me>('updateMe', await call('/v1/me', { method: 'PATCH', token, body }), status);
const pause = () => new Promise((r) => setTimeout(r, 20));

const MIGRATION = new URL('../migrations/0023_onboarding_marks.sql', import.meta.url);

describe('first-run marks: GET /v1/me', () => {
  it('a new user has both marks empty', async () => {
    const u = await createUser();
    const me = await getMe(u.token);
    expect(me.onboardingCompletedAt).toBeNull();
    expect(me.gettingStartedDismissedAt).toBeNull();
  });

  it('an account made before the change has both marks empty after the migration (no backfill)', async () => {
    const migration = readFileSync(MIGRATION, 'utf8');
    // Only new columns, no default and no UPDATE: existing rows stay empty.
    expect(migration).not.toMatch(/^\s*UPDATE\b/im);
    expect(migration).not.toMatch(/DEFAULT/i);

    // Put the table back as it was before the change, add an account the old way, then run the
    // migration file itself on it.
    await db().execute(
      sql.raw(
        'ALTER TABLE "users" DROP COLUMN "onboarding_completed_at", DROP COLUMN "getting_started_dismissed_at"',
      ),
    );
    const clerkId = `user_old_${Date.now()}`;
    await db().execute(sql`
      INSERT INTO "users" ("id", "clerk_id", "email", "email_verified", "name")
      VALUES (${`usr_old_${Date.now()}`}, ${clerkId}, ${`${clerkId}@example.com`}, true, 'Old User')`);
    for (const statement of migration.split('--> statement-breakpoint')) {
      await db().execute(sql.raw(statement));
    }

    const me = await getMe(await sessionToken(clerkId));
    expect(me.name).toBe('Old User');
    expect(me.onboardingCompletedAt).toBeNull();
    expect(me.gettingStartedDismissedAt).toBeNull();
  });
});

describe('first-run marks: PATCH /v1/me', () => {
  it('true sets the time, a second true keeps the first time, false clears it', async () => {
    const u = await createUser();
    const before = Date.now();

    const done = await patchMe(u.token, { onboardingCompleted: true });
    expect(done.onboardingCompletedAt).not.toBeNull();
    const first = done.onboardingCompletedAt!;
    expect(Date.parse(first)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(first)).toBeLessThanOrEqual(Date.now() + 1000);
    // Only the mark that was sent changes.
    expect(done.gettingStartedDismissedAt).toBeNull();

    await pause();
    const again = await patchMe(u.token, { onboardingCompleted: true });
    expect(again.onboardingCompletedAt).toBe(first);
    expect((await getMe(u.token)).onboardingCompletedAt).toBe(first);

    const cleared = await patchMe(u.token, { onboardingCompleted: false });
    expect(cleared.onboardingCompletedAt).toBeNull();
    expect((await getUser(u.id))!.onboardingCompletedAt).toBeNull();

    // Set again after a clear: a new time.
    await pause();
    const redone = await patchMe(u.token, { onboardingCompleted: true });
    expect(Date.parse(redone.onboardingCompletedAt!)).toBeGreaterThan(Date.parse(first));
  });

  it('the checklist mark works the same way, on its own', async () => {
    const u = await createUser();
    const closed = await patchMe(u.token, { gettingStartedDismissed: true });
    expect(closed.gettingStartedDismissedAt).not.toBeNull();
    expect(closed.onboardingCompletedAt).toBeNull();
    const first = closed.gettingStartedDismissedAt!;

    await pause();
    expect(
      (await patchMe(u.token, { gettingStartedDismissed: true })).gettingStartedDismissedAt,
    ).toBe(first);
    expect(
      (await patchMe(u.token, { gettingStartedDismissed: false })).gettingStartedDismissedAt,
    ).toBeNull();
  });

  it('both marks and the name in one call; leaving a mark out keeps it', async () => {
    const u = await createUser();
    const me = await patchMe(u.token, {
      name: 'Priya',
      onboardingCompleted: true,
      gettingStartedDismissed: true,
    });
    expect(me.name).toBe('Priya');
    expect(me.onboardingCompletedAt).not.toBeNull();
    expect(me.gettingStartedDismissedAt).not.toBeNull();

    const renamed = await patchMe(u.token, { name: 'Priya S' });
    expect(renamed.onboardingCompletedAt).toBe(me.onboardingCompletedAt);
    expect(renamed.gettingStartedDismissedAt).toBe(me.gettingStartedDismissedAt);
  });

  it("changes only the signed-in user's marks", async () => {
    const a = await createUser();
    const b = await createUser();
    await patchMe(b.token, { onboardingCompleted: true, gettingStartedDismissed: true });
    const bBefore = await getMe(b.token);

    await patchMe(a.token, { onboardingCompleted: true, gettingStartedDismissed: true });
    await patchMe(a.token, { onboardingCompleted: false, gettingStartedDismissed: false });

    expect(await getMe(b.token)).toEqual(bBefore);
    const c = await createUser();
    await patchMe(a.token, { onboardingCompleted: true });
    expect(await getMe(c.token)).toMatchObject({
      onboardingCompletedAt: null,
      gettingStartedDismissedAt: null,
    });
  });

  it('a mark that is not true or false is refused (400) and changes nothing', async () => {
    const u = await createUser();
    await patchMe(u.token, { onboardingCompleted: 'yes' }, 400);
    await patchMe(u.token, { gettingStartedDismissed: null }, 400);
    expect(await getMe(u.token)).toMatchObject({
      onboardingCompletedAt: null,
      gettingStartedDismissedAt: null,
    });
  });
});

describe('first-run marks: an admin shows the welcome steps again', () => {
  type Err = { error: { code: string; message: string; details?: Record<string, unknown> } };
  type Reset = {
    userId: string;
    onboardingCompletedAt: null;
    gettingStartedDismissedAt: null;
    changed: boolean;
  };
  const OP = 'adminResetUserOnboarding';
  const path = (userId: string) => `/v1/admin/users/${userId}/onboarding/reset`;
  const reset = (
    userId: string,
    token: string | undefined,
    body: unknown = { reason: 'support' },
  ) => call(path(userId), { method: 'POST', ...(token ? { token } : {}), body });
  const auditRows = (userId: string) =>
    db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'onboarding_reset')));

  /** A user who finished the welcome steps and closed the checklist. */
  async function onboardedUser() {
    const u = await createUser();
    await patchMe(u.token, { onboardingCompleted: true, gettingStartedDismissed: true });
    return u;
  }

  it('is admin-only: 403 in the Error shape for a user, 401 with no session; nothing changes', async () => {
    const user = await createUser();
    const target = await onboardedUser();
    const before = await getMe(target.token);

    const body = await expectContract<Err>(OP, await reset(target.id, user.token), 403);
    expect(body.error).toMatchObject({ code: 'forbidden', message: 'Admins only' });
    // Not even on their own account.
    await expectContract(OP, await reset(user.id, user.token), 403);
    await expectContract(OP, await reset(target.id, undefined), 401);

    expect(await getMe(target.token)).toEqual(before);
    expect(await auditRows(target.id)).toEqual([]);
  });

  it("clears both marks, writes one audit row, and leaves other users' marks alone", async () => {
    const admin = await createUser({ role: 'admin' });
    const target = await onboardedUser();
    const other = await onboardedUser();
    const otherBefore = await getMe(other.token);
    const before = await getMe(target.token);

    const res = await expectContract<Reset>(
      OP,
      await reset(target.id, admin.token, { reason: 'wants the tour again' }),
      200,
    );
    expect(res).toEqual({
      userId: target.id,
      onboardingCompletedAt: null,
      gettingStartedDismissedAt: null,
      changed: true,
    });
    expect(await getMe(target.token)).toMatchObject({
      onboardingCompletedAt: null,
      gettingStartedDismissedAt: null,
    });
    expect(await getMe(other.token)).toEqual(otherBefore);

    const rows = await auditRows(target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor: 'admin',
      summary: 'An admin set this account to show the welcome steps again',
      details: {
        adminId: admin.id,
        reason: 'wants the tour again',
        onboardingCompletedAt: before.onboardingCompletedAt,
        gettingStartedDismissedAt: before.gettingStartedDismissedAt,
      },
    });
    // The user's own activity list shows the plain line, never the reason.
    const activity = await (await call('/v1/activity', { token: target.token })).text();
    expect(activity).toContain('An admin set this account to show the welcome steps again');
    expect(activity).not.toContain('wants the tour again');

    // Again: nothing to clear, no second row.
    const again = await expectContract<Reset>(OP, await reset(target.id, admin.token), 200);
    expect(again.changed).toBe(false);
    expect(await auditRows(target.id)).toHaveLength(1);
  });

  it('one mark set is enough to clear; an admin may do it on their own account', async () => {
    const admin = await createUser({ role: 'admin' });
    await patchMe(admin.token, { gettingStartedDismissed: true });
    const res = await expectContract<Reset>(OP, await reset(admin.id, admin.token), 200);
    expect(res.changed).toBe(true);
    expect((await getMe(admin.token)).gettingStartedDismissedAt).toBeNull();
    expect(await auditRows(admin.id)).toHaveLength(1);
  });

  it('needs a reason (400), and an unknown or deleted account is 404', async () => {
    const admin = await createUser({ role: 'admin' });
    const target = await onboardedUser();
    await expectContract(OP, await reset(target.id, admin.token, {}), 400);
    await expectContract(OP, await reset(target.id, admin.token, { reason: '   ' }), 400);
    expect((await getUser(target.id))!.onboardingCompletedAt).not.toBeNull();

    await expectContract<Err>(OP, await reset('usr_missing', admin.token), 404);
    await db().update(users).set({ deletedAt: new Date() }).where(eq(users.id, target.id));
    await expectContract<Err>(OP, await reset(target.id, admin.token), 404);
    expect(await auditRows(target.id)).toEqual([]);
  });
});

describe("first-run marks: the admin's user view shows them", () => {
  type Err = { error: { code: string; message: string } };
  type Marks = {
    id: string;
    onboardingCompletedAt: string | null;
    gettingStartedDismissedAt: string | null;
  };

  /** The marks as an admin sees them, on one user's page and in the user list (the same). */
  async function adminSees(userId: string, token: string) {
    const detail = await expectContract<{ user: Marks }>(
      'adminGetUser',
      await call(`/v1/admin/users/${userId}`, { token }),
      200,
    );
    const list = await expectContract<{ items: Marks[] }>(
      'adminListUsers',
      await call(`/v1/admin/users?query=${userId}`, { token }),
      200,
    );
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: userId,
      onboardingCompletedAt: detail.user.onboardingCompletedAt,
      gettingStartedDismissedAt: detail.user.gettingStartedDismissedAt,
    });
    return detail.user;
  }

  it('null for a new user, the same time as on /v1/me once set, null again after the reset', async () => {
    const admin = await createUser({ role: 'admin' });
    const u = await createUser();

    expect(await adminSees(u.id, admin.token)).toMatchObject({
      onboardingCompletedAt: null,
      gettingStartedDismissedAt: null,
    });

    const done = await patchMe(u.token, { onboardingCompleted: true });
    expect(done.onboardingCompletedAt).not.toBeNull();
    expect(await adminSees(u.id, admin.token)).toMatchObject({
      onboardingCompletedAt: done.onboardingCompletedAt,
      gettingStartedDismissedAt: null,
    });

    const closed = await patchMe(u.token, { gettingStartedDismissed: true });
    expect(closed.gettingStartedDismissedAt).not.toBeNull();
    expect(await adminSees(u.id, admin.token)).toMatchObject({
      onboardingCompletedAt: done.onboardingCompletedAt,
      gettingStartedDismissedAt: closed.gettingStartedDismissedAt,
    });

    await expectContract(
      'adminResetUserOnboarding',
      await call(`/v1/admin/users/${u.id}/onboarding/reset`, {
        method: 'POST',
        token: admin.token,
        body: { reason: 'support' },
      }),
      200,
    );
    expect(await adminSees(u.id, admin.token)).toMatchObject({
      onboardingCompletedAt: null,
      gettingStartedDismissedAt: null,
    });
  });

  it('a user who is not an admin still gets 403 in the Error shape, with no marks', async () => {
    const user = await createUser();
    const target = await createUser();
    await patchMe(target.token, { onboardingCompleted: true });
    for (const [op, path] of [
      ['adminGetUser', `/v1/admin/users/${target.id}`],
      ['adminListUsers', `/v1/admin/users?query=${target.id}`],
    ] as const) {
      const body = await expectContract<Err>(op, await call(path, { token: user.token }), 403);
      expect(body.error).toMatchObject({ code: 'forbidden', message: 'Admins only' });
      expect(JSON.stringify(body)).not.toContain('onboardingCompletedAt');
    }
  });
});
