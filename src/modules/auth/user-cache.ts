// A short-lived copy of each user's row in Redis, for the reads made on almost every request: who
// is signed in (every web app call), whether the account is suspended (every turn, every tool
// call of the agent) and the plan (the queue's priority, the wake). Each was a database round trip,
// about 260 ms with the database on Neon in Ohio; Redis is on the same server.
//
// The rules, so the copy is never older than the database for long:
// - The copy lives 60 seconds at most.
// - Every change to a user's row (users.ts) drops the copy and, for the next 30 seconds, no new
//   copy is kept: reads go to the database. A change made inside a longer transaction is committed
//   within that time, so a read that saw the old row just before the commit can't keep it.
// - Redis unreachable: every read goes to the database, as before.
// Clerk's id for a user never changes, so which user a Clerk id belongs to is kept for a day.
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import type { users } from './schema.ts';

type UserRow = typeof users.$inferSelect;

/** The longest a copy is used. */
export const USER_COPY_SECONDS = 60;
/** After a change, how long no copy is kept. */
export const USER_CHANGED_SECONDS = 30;
const CLERK_ID_SECONDS = 24 * 3600;

const rowKey = (userId: string) => `user:row:${userId}`;
const changedKey = (userId: string) => `user:changed:${userId}`;
const clerkKey = (clerkId: string) => `user:clerk:${clerkId}`;

/** Saves the copy only when the user's row has not changed in the last 30 seconds. */
const SET_UNLESS_CHANGED = `
if redis.call('exists', KEYS[2]) == 0 then
  redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[2])
end
return 1`;

// Dates survive the trip through JSON as {"$date": "..."}.
function encode(row: UserRow): string {
  return JSON.stringify(row, function (this: Record<string, unknown>, key, value: unknown) {
    const raw = this[key];
    return raw instanceof Date ? { $date: raw.toISOString() } : value;
  });
}

function decode(raw: string): UserRow {
  return JSON.parse(raw, (_key, value: unknown) =>
    value && typeof value === 'object' && '$date' in value
      ? new Date((value as { $date: string }).$date)
      : value,
  ) as UserRow;
}

function warn(err: unknown, what: string) {
  logger().warn({ err: String(err) }, `user copy: ${what}`);
}

/** The user's row: the copy when there is a fresh one, else `load()` (which is then kept). */
export async function readUser(
  userId: string,
  load: () => Promise<UserRow | undefined>,
): Promise<UserRow | undefined> {
  try {
    const [raw, changed] = await redis().mget(rowKey(userId), changedKey(userId));
    if (raw && !changed) return decode(raw);
  } catch (err) {
    warn(err, 'not read');
    return load();
  }
  const row = await load();
  if (row) await keepUser(row);
  return row;
}

/** Keeps a copy of a row just read from the database (unless the row changed lately). */
export async function keepUser(row: UserRow): Promise<void> {
  try {
    await redis().eval(
      SET_UNLESS_CHANGED,
      2,
      rowKey(row.id),
      changedKey(row.id),
      encode(row),
      USER_COPY_SECONDS,
    );
  } catch (err) {
    warn(err, 'not kept');
  }
}

/**
 * The user's row changed (or is about to, inside a transaction): drop the copy and keep none for
 * the next 30 seconds. Never fails the change itself; if Redis can't be told, a copy lives at most
 * its 60 seconds.
 */
export async function forgetUser(userId: string): Promise<void> {
  try {
    await redis()
      .multi()
      .set(changedKey(userId), '1', 'EX', USER_CHANGED_SECONDS)
      .del(rowKey(userId))
      .exec();
  } catch (err) {
    logger().error({ userId, err: String(err) }, 'user copy: not dropped after a change');
  }
}

/** Our user id for a Clerk id, when it is known here. */
export async function knownUserId(clerkId: string): Promise<string | null> {
  try {
    return await redis().get(clerkKey(clerkId));
  } catch (err) {
    warn(err, 'Clerk id not read');
    return null;
  }
}

export async function keepUserId(clerkId: string, userId: string): Promise<void> {
  try {
    await redis().set(clerkKey(clerkId), userId, 'EX', CLERK_ID_SECONDS);
  } catch (err) {
    warn(err, 'Clerk id not kept');
  }
}
