// What the privacy page promises about keeping data (backend-report.md, section 33, "What stays
// after a deletion"): saved events go after 30 days whatever their state, and a deleted account's
// row keeps no email, name or time zone. Both are safe to run again. The archives of users' files
// are deleted by the vm-manager (its DeleteSandbox and SNAPSHOT_KEEP_DAYS), tested there.
import type { Job } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { markUserDeleted, upsertUserFromClerk } from '../src/modules/auth/users.ts';
import { users } from '../src/modules/auth/schema.ts';
import { cleanupEvents } from '../src/modules/events/cleanup.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { events } from '../src/modules/events/schema.ts';
import { handleDeleteUser } from '../src/modules/orchestrator/lifecycle.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm } from './fakes.ts';
import { chatUser } from './helpers.ts';

beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(async () => {
  installFakeVm();
  await installFakeComposio();
});

const DAY = 86400_000;

describe('raw events are kept 30 days, whatever their state', () => {
  async function event(status: (typeof events.$inferSelect)['status'], ageDays: number) {
    const id = newId('evt');
    await db()
      .insert(events)
      .values({
        id,
        source: 'telegram',
        externalId: id,
        type: 'message',
        payload: { text: 'hello' },
        status,
        createdAt: new Date(Date.now() - ageDays * DAY),
      });
    return id;
  }
  const left = async (ids: string[]) =>
    (await db().select({ id: events.id }).from(events).where(inArray(events.id, ids)))
      .map((r) => r.id)
      .sort();

  it('removes old failed, waiting and finished events, and keeps recent ones', async () => {
    const old = [
      await event('failed', 31),
      await event('received', 40),
      await event('queued', 31),
      await event('done', 31),
      await event('ignored', 60),
    ];
    const recent = [await event('failed', 29), await event('done', 1), await event('received', 0)];

    await cleanupEvents();
    expect(await left([...old, ...recent])).toEqual([...recent].sort());

    await cleanupEvents(); // a second run removes nothing more
    expect(await left(recent)).toEqual([...recent].sort());
  });
});

describe('a deleted account’s row', () => {
  const deleteUser = (userId: string) => handleDeleteUser({ data: { userId } } as Job);
  const rowOf = async (userId: string) =>
    (await db().select().from(users).where(eq(users.id, userId)))[0]!;

  it('keeps its id, Clerk id and deletion time, but no email, name or time zone', async () => {
    const user = await chatUser({ timezone: 'Asia/Kolkata', timezoneSet: true });
    const other = await chatUser();
    const marked = await markUserDeleted(user.clerkId);
    expect(marked?.deletedAt).toBeTruthy();

    await deleteUser(user.id);
    const row = await rowOf(user.id);
    expect(row).toMatchObject({
      id: user.id,
      clerkId: user.clerkId,
      email: `deleted-${user.id}@deleted.invalid`,
      emailVerified: false,
      name: 'Deleted user',
      timezone: 'UTC',
      timezoneSet: false,
    });
    expect(row.deletedAt).toEqual(marked!.deletedAt);
    expect(JSON.stringify(row)).not.toContain(user.email);

    // Another user is untouched.
    expect(await rowOf(other.id)).toMatchObject({ email: other.email, name: other.name });
  });

  it('is safe to run again, and a late Clerk update or deletion does not bring the email back', async () => {
    const user = await chatUser();
    await markUserDeleted(user.clerkId);
    await deleteUser(user.id);
    const first = await rowOf(user.id);

    await expect(deleteUser(user.id)).resolves.toBeNull();
    expect(await rowOf(user.id)).toEqual(first);

    // Clerk's "user updated" arriving after the deletion.
    await upsertUserFromClerk({
      clerkId: user.clerkId,
      email: user.email,
      emailVerified: true,
      name: user.name,
      role: 'user',
    });
    // Clerk's "user deleted" arriving after an admin's deletion: nothing to mark again.
    expect(await markUserDeleted(user.clerkId)).toBeUndefined();
    expect(await rowOf(user.id)).toEqual(first);
  });
});
