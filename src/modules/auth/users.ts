import { createClerkClient } from '@clerk/backend';
import { and, eq, isNull } from 'drizzle-orm';
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

export async function updateProfile(
  userId: string,
  patch: { name?: string; timezone?: string },
): Promise<User> {
  const [row] = await db().update(users).set(patch).where(eq(users.id, userId)).returning();
  return row!;
}

export async function setPlan(userId: string, plan: PlanId, tx: Tx = db()): Promise<void> {
  await tx.update(users).set({ plan }).where(eq(users.id, userId));
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
