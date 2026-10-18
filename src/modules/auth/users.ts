import { createClerkClient } from '@clerk/backend';
import { and, asc, desc, eq, ilike, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { config } from '../../shared/config.ts';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { users } from './schema.ts';
import { forgetUser, keepUser, keepUserId, knownUserId, readUser } from './user-cache.ts';

export type User = typeof users.$inferSelect;
export type PlanId = User['plan'];

/** The fields we take from a Clerk user (webhook payload or Backend API). */
export interface ClerkUserData {
  clerkId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  role: 'user' | 'admin';
}

type ClerkEmail = {
  id?: string;
  email_address?: string;
  emailAddress?: string;
  verification?: { status?: string } | null;
};

/** Maps a Clerk user object (snake_case webhook JSON or camelCase SDK object). */
export function clerkUserFromPayload(u: Record<string, unknown>): ClerkUserData {
  const emails = ((u.email_addresses ?? u.emailAddresses) as ClerkEmail[] | undefined) ?? [];
  const primaryId = (u.primary_email_address_id ?? u.primaryEmailAddressId) as string | undefined;
  const primary = emails.find((e) => e.id === primaryId) ?? emails[0];
  const first = (u.first_name ?? u.firstName ?? '') as string;
  const last = (u.last_name ?? u.lastName ?? '') as string;
  const meta =
    ((u.public_metadata ?? u.publicMetadata) as Record<string, unknown> | undefined) ?? {};
  return {
    clerkId: u.id as string,
    email: primary?.email_address ?? primary?.emailAddress ?? '',
    emailVerified: primary?.verification?.status === 'verified',
    name: [first, last].filter(Boolean).join(' '),
    role: meta.role === 'admin' ? 'admin' : 'user',
  };
}

export async function getUser(userId: string, tx: Tx = db()): Promise<User | undefined> {
  const [row] = await tx.select().from(users).where(eq(users.id, userId));
  return row;
}

export async function getActiveUser(userId: string, tx: Tx = db()): Promise<User | undefined> {
  const [row] = await tx
    .select()
    .from(users)
    .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  return row;
}

/**
 * Every account not deleted, oldest first: only its id and email. For billing's marks of the
 * inboxes that had an account (billing/email-marks.ts), made once for the accounts from before.
 */
export async function listLiveUserEmails(): Promise<Array<{ id: string; email: string }>> {
  return db()
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(isNull(users.deletedAt))
    .orderBy(asc(users.createdAt), asc(users.id));
}

/** Users (not deleted) with this email, in any letter case. For the ops script only. */
export async function findActiveUsersByEmail(email: string): Promise<User[]> {
  return db()
    .select()
    .from(users)
    .where(
      and(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`, isNull(users.deletedAt)),
    );
}

export async function getUserByClerkId(clerkId: string): Promise<User | undefined> {
  const [row] = await db().select().from(users).where(eq(users.clerkId, clerkId));
  return row;
}

// --- reads from the short-lived copy (user-cache.ts) --------------------------------------------
// For the reads made on almost every request. Every change below drops the copy, so these are as
// fresh as a database read except for a moment around a change; anything that changes a user's
// row reads it with the functions above.

/** The user's row (deleted ones too), from the copy when there is a fresh one. */
export async function getUserCached(userId: string): Promise<User | undefined> {
  return readUser(userId, () => getUser(userId));
}

/** The user, unless deleted, from the copy when there is a fresh one. */
export async function getActiveUserCached(userId: string): Promise<User | undefined> {
  const user = await getUserCached(userId);
  return user && !user.deletedAt ? user : undefined;
}

/** The user signed in with this Clerk id (deleted ones too), from the copy when there is one. */
export async function getUserByClerkIdCached(clerkId: string): Promise<User | undefined> {
  const known = await knownUserId(clerkId);
  if (known) {
    const user = await getUserCached(known);
    if (user?.clerkId === clerkId) return user;
  }
  const row = await getUserByClerkId(clerkId);
  if (row) await Promise.all([keepUserId(clerkId, row.id), keepUser(row)]);
  return row;
}

/**
 * Creates the user row (idempotent on clerk_id). `created` is true only for the call that
 * inserted it, so the caller can run one-time onboarding (sign-up grant, sandbox).
 *
 * When the row exists, it is written only if Clerk's email, its check or the role differ from
 * ours. Clerk says "user updated" for many changes we don't keep (a picture, a name, metadata),
 * and the first calls of a new account may race its webhook; a write each time would drop the
 * user's copy and keep none for 30 seconds (user-cache.ts), so every call in that time would
 * read the row from the database again.
 */
export async function upsertUserFromClerk(
  data: ClerkUserData,
): Promise<{ user: User; created: boolean }> {
  const [inserted] = await db()
    .insert(users)
    .values({
      id: newId('usr'),
      clerkId: data.clerkId,
      email: data.email,
      emailVerified: data.emailVerified,
      name: data.name,
      role: data.role,
    })
    .onConflictDoNothing({ target: users.clerkId })
    .returning();
  if (inserted) return { user: inserted, created: true };
  const current = await getUserByClerkId(data.clerkId);
  // A deleted account is never written again: a late "user updated" from Clerk would put back the
  // email and name its deletion removed (scrubDeletedUser).
  if (current?.deletedAt) return { user: current, created: false };
  if (
    current &&
    current.email === data.email &&
    current.emailVerified === data.emailVerified &&
    current.role === data.role
  ) {
    return { user: current, created: false };
  }
  const [updated] = await db()
    .update(users)
    .set({ email: data.email, emailVerified: data.emailVerified, role: data.role })
    .where(and(eq(users.clerkId, data.clerkId), isNull(users.deletedAt)))
    .returning();
  // Deleted between the read and the write: left as the deletion made it.
  if (!updated) return { user: (await getUserByClerkId(data.clerkId))!, created: false };
  await forgetUser(updated.id);
  return { user: updated, created: false };
}

/** The values a deleted account's row keeps instead of the person's own (scrubDeletedUser). */
export const DELETED_USER_NAME = 'Deleted user';
export const deletedUserEmail = (userId: string) => `deleted-${userId}@deleted.invalid`;

/**
 * The last step of an account's deletion: the row stays, so its id, Clerk id and `deletedAt` keep
 * the credit records, a late webhook and the deletion job's own re-runs working, but nothing in it
 * names the person any more. The email becomes an address that can never be delivered (`.invalid`
 * is reserved for that), the name "Deleted user", the time zone UTC. Marks the row deleted if it
 * was not yet. Safe to run again.
 */
export async function scrubDeletedUser(userId: string): Promise<boolean> {
  const [row] = await db()
    .update(users)
    .set({
      email: deletedUserEmail(userId),
      emailVerified: false,
      name: DELETED_USER_NAME,
      timezone: 'UTC',
      timezoneSet: false,
      deletedAt: sql`coalesce(${users.deletedAt}, now())`,
    })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  await forgetUser(userId);
  return Boolean(row);
}

export async function markUserDeleted(clerkId: string): Promise<User | undefined> {
  const [row] = await db()
    .update(users)
    .set({ deletedAt: new Date() })
    .where(and(eq(users.clerkId, clerkId), isNull(users.deletedAt)))
    .returning();
  if (row) await forgetUser(row.id);
  return row;
}

/** What the user is told on Telegram (backend-report.md, "Notices on Telegram"). */
export interface NotificationSettings {
  crewJobs: boolean;
  prReviews: boolean;
  automationRuns: boolean;
  /** An approval asked by an automation's run goes to Telegram too. */
  automationApprovals: boolean;
  quietHours: { enabled: boolean; start: string; end: string };
}

/** A change to some of them: only the fields given change. */
export interface NotificationSettingsPatch {
  crewJobs?: boolean;
  prReviews?: boolean;
  automationRuns?: boolean;
  automationApprovals?: boolean;
  quietHours?: { enabled?: boolean; start?: string; end?: string };
}

/**
 * The user's notice settings. A copy of the row kept from before these columns existed (for a
 * minute after the update reaches the server) has none of them: the defaults then.
 */
export function notificationSettingsOf(user: User): NotificationSettings {
  const u = user as Partial<User>;
  return {
    crewJobs: u.notifyCrewJobs ?? true,
    prReviews: u.notifyPrReviews ?? true,
    automationRuns: u.notifyAutomationRuns ?? false,
    automationApprovals: u.notifyAutomationApprovals ?? true,
    quietHours: {
      enabled: u.quietHoursOn ?? true,
      start: u.quietHoursStart ?? '22:00',
      end: u.quietHoursEnd ?? '08:00',
    },
  };
}

function notificationColumns(patch: NotificationSettingsPatch | undefined) {
  if (!patch) return {};
  const q = patch.quietHours;
  return {
    ...(patch.crewJobs !== undefined ? { notifyCrewJobs: patch.crewJobs } : {}),
    ...(patch.prReviews !== undefined ? { notifyPrReviews: patch.prReviews } : {}),
    ...(patch.automationRuns !== undefined ? { notifyAutomationRuns: patch.automationRuns } : {}),
    ...(patch.automationApprovals !== undefined
      ? { notifyAutomationApprovals: patch.automationApprovals }
      : {}),
    ...(q?.enabled !== undefined ? { quietHoursOn: q.enabled } : {}),
    ...(q?.start !== undefined ? { quietHoursStart: q.start } : {}),
    ...(q?.end !== undefined ? { quietHoursEnd: q.end } : {}),
  };
}

/** True stamps the time now, keeping a time already there; false clears it. */
const firstRunMark = (column: AnyPgColumn, on: boolean) =>
  on ? sql`coalesce(${column}, now())` : null;

/**
 * A time zone given here counts as set: the web app never replaces it with the browser's.
 * `onboardingCompleted` and `gettingStartedDismissed` set or clear the web app's first-run marks.
 * `notifications` changes only the notice settings it names.
 */
export async function updateProfile(
  userId: string,
  patch: {
    name?: string;
    timezone?: string;
    onboardingCompleted?: boolean;
    gettingStartedDismissed?: boolean;
    notifications?: NotificationSettingsPatch;
  },
  tx: Tx = db(),
): Promise<User> {
  const { onboardingCompleted, gettingStartedDismissed, notifications, ...profile } = patch;
  const [row] = await tx
    .update(users)
    .set({
      ...profile,
      ...notificationColumns(notifications),
      ...(profile.timezone !== undefined ? { timezoneSet: true } : {}),
      ...(onboardingCompleted !== undefined
        ? { onboardingCompletedAt: firstRunMark(users.onboardingCompletedAt, onboardingCompleted) }
        : {}),
      ...(gettingStartedDismissed !== undefined
        ? {
            gettingStartedDismissedAt: firstRunMark(
              users.gettingStartedDismissedAt,
              gettingStartedDismissed,
            ),
          }
        : {}),
    })
    .where(eq(users.id, userId))
    .returning();
  await forgetUser(userId);
  return row!;
}

/** Sets the user's plan. True: it changed (the user was on another plan). */
export async function setPlan(userId: string, plan: PlanId, tx: Tx = db()): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({ plan })
    .where(and(eq(users.id, userId), ne(users.plan, plan)))
    .returning({ id: users.id });
  if (rows.length) await forgetUser(userId);
  return rows.length > 0;
}

/**
 * Sets the role on our row. The admin tool sets Clerk's copy first (clerk-admin.ts); Clerk's next
 * `user.updated` webhook then carries the same role. True: it changed.
 */
export async function setRole(userId: string, role: User['role'], tx: Tx = db()): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({ role })
    .where(and(eq(users.id, userId), ne(users.role, role)))
    .returning({ id: users.id });
  if (rows.length) await forgetUser(userId);
  return rows.length > 0;
}

export type AccountStatus = User['status'];

/**
 * Suspends an account or makes it active again (an admin's decision). `changed` is false when it
 * already had that status. Undefined: no such account, or it is deleted.
 */
export async function setAccountStatus(
  userId: string,
  status: AccountStatus,
  tx: Tx = db(),
): Promise<{ user: User; changed: boolean } | undefined> {
  const [row] = await tx
    .update(users)
    .set({ status, suspendedAt: status === 'suspended' ? new Date() : null })
    .where(and(eq(users.id, userId), isNull(users.deletedAt), ne(users.status, status)))
    .returning();
  if (row) {
    await forgetUser(userId);
    return { user: row, changed: true };
  }
  const user = await getActiveUser(userId, tx);
  return user ? { user, changed: false } : undefined;
}

/**
 * An admin suspended this account: no signed-in call, no answer, no wake until it is lifted. From
 * the copy (suspending drops it, so the answer changes at once).
 */
export async function isSuspended(userId: string): Promise<boolean> {
  return (await getUserCached(userId))?.status === 'suspended';
}

export async function flagUser(userId: string): Promise<void> {
  await db().update(users).set({ flagged: true }).where(eq(users.id, userId));
  await forgetUser(userId);
}

// --- admin reads (counts and lists; never anything a user wrote) ------------------------------

/** Midnight UTC of the given moment's day: where "today" starts in the admin numbers. */
export function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export interface UserCounts {
  /** Accounts that are not deleted. */
  total: number;
  deleted: number;
  /** Sign-ups since midnight UTC, and in the last 7 days (deleted ones too: they signed up). */
  newToday: number;
  new7d: number;
  /** Accounts that are not deleted, by plan. */
  plans: Record<PlanId, number>;
}

export async function userCounts(now = new Date()): Promise<UserCounts> {
  const day = utcDayStart(now);
  const week = new Date(now.getTime() - 7 * 86400_000);
  const n = (where: SQL) => sql<number>`count(*) filter (where ${where})`.mapWith(Number);
  const alive = sql`${users.deletedAt} is null`;
  const [row] = await db()
    .select({
      total: n(alive),
      deleted: n(sql`${users.deletedAt} is not null`),
      newToday: n(sql`${users.createdAt} >= ${day}`),
      new7d: n(sql`${users.createdAt} >= ${week}`),
      free: n(sql`${alive} and ${users.plan} = 'free'`),
      pro: n(sql`${alive} and ${users.plan} = 'pro'`),
      max: n(sql`${alive} and ${users.plan} = 'max'`),
    })
    .from(users);
  return {
    total: row?.total ?? 0,
    deleted: row?.deleted ?? 0,
    newToday: row?.newToday ?? 0,
    new7d: row?.new7d ?? 0,
    plans: { free: row?.free ?? 0, pro: row?.pro ?? 0, max: row?.max ?? 0 },
  };
}

/** `%` and `_` typed by the admin are letters, not wildcards. */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/**
 * Users newest first, deleted ones too. `query`: part of an email or a name (any letter case), or
 * a whole user id. The cursor is the last id of the page before.
 */
export async function searchUsers(opts: {
  query?: string;
  cursor?: string;
  limit: number;
}): Promise<{ items: User[]; nextCursor: string | null }> {
  const where: SQL[] = [];
  const q = opts.query?.trim();
  if (q) {
    const like = likePattern(q);
    where.push(or(eq(users.id, q), ilike(users.email, like), ilike(users.name, like))!);
  }
  if (opts.cursor) where.push(lt(users.id, opts.cursor));
  const rows = await db()
    .select()
    .from(users)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(users.id))
    .limit(opts.limit + 1);
  const items = rows.slice(0, opts.limit);
  return { items, nextCursor: rows.length > opts.limit ? items[items.length - 1]!.id : null };
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Fetches a user from Clerk's Backend API (used when a session arrives before the webhook). */
export async function fetchClerkUser(clerkId: string): Promise<ClerkUserData | undefined> {
  const secretKey = config().CLERK_SECRET_KEY;
  if (!secretKey) return undefined;
  const clerk = createClerkClient({ secretKey });
  const u = await clerk.users.getUser(clerkId);
  return clerkUserFromPayload(u as unknown as Record<string, unknown>);
}
