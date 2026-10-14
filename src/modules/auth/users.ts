import { createClerkClient } from '@clerk/backend';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { db, type Tx } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { users } from './schema.ts';

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

/**
 * Creates the user row (idempotent on clerk_id). `created` is true only for the call that
 * inserted it, so the caller can run one-time onboarding (sign-up grant, sandbox).
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
  const [updated] = await db()
    .update(users)
    .set({ email: data.email, emailVerified: data.emailVerified, role: data.role })
    .where(eq(users.clerkId, data.clerkId))
    .returning();
  return { user: updated!, created: false };
}

export async function markUserDeleted(clerkId: string): Promise<User | undefined> {
  const [row] = await db()
    .update(users)
    .set({ deletedAt: new Date() })
    .where(and(eq(users.clerkId, clerkId), isNull(users.deletedAt)))
    .returning();
  return row;
}

/** A time zone given here counts as set: the web app never replaces it with the browser's. */
export async function updateProfile(
  userId: string,
  patch: { name?: string; timezone?: string },
): Promise<User> {
  const [row] = await db()
    .update(users)
    .set({ ...patch, ...(patch.timezone !== undefined ? { timezoneSet: true } : {}) })
    .where(eq(users.id, userId))
    .returning();
  return row!;
}

/** Sets the user's plan. True: it changed (the user was on another plan). */
export async function setPlan(userId: string, plan: PlanId, tx: Tx = db()): Promise<boolean> {
  const rows = await tx
    .update(users)
    .set({ plan })
    .where(and(eq(users.id, userId), ne(users.plan, plan)))
    .returning({ id: users.id });
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
  if (row) return { user: row, changed: true };
  const user = await getActiveUser(userId, tx);
  return user ? { user, changed: false } : undefined;
}

/** An admin suspended this account: no signed-in call, no answer, no wake until it is lifted. */
export async function isSuspended(userId: string): Promise<boolean> {
  const [row] = await db().select({ status: users.status }).from(users).where(eq(users.id, userId));
  return row?.status === 'suspended';
}

export async function flagUser(userId: string): Promise<void> {
  await db().update(users).set({ flagged: true }).where(eq(users.id, userId));
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
