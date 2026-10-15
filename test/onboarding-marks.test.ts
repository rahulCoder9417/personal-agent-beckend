// The web app's first-run marks on GET/PATCH /v1/me: when the welcome steps were finished or
// skipped, and when the "Getting started" checklist was closed. No backfill: accounts made before
// the columns existed start with both empty, like new ones.
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
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
