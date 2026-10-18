import { notifyFounder } from '../admin/ops-alerts.ts';
import { addJob } from '../events/queues.ts';
import { keepUser, keepUserId } from './user-cache.ts';
import {
  fetchClerkUser,
  getUserByClerkIdCached,
  upsertUserFromClerk,
  userCounts,
  type ClerkUserData,
  type User,
} from './users.ts';

/** One-time onboarding (sign-up grant, LiteLLM key, sandbox) runs as a system job. */
export async function enqueueOnboarding(userId: string): Promise<void> {
  await addJob('system', 'onboard-user', { userId }, { jobId: `onboard-${userId}` });
}

export async function enqueueUserDeletion(userId: string): Promise<void> {
  await addJob('system', 'delete-user', { userId }, { jobId: `delete-${userId}` });
}

/**
 * Creates/updates the user from Clerk data; onboards only on the call that created it. Then keeps
 * the user's copy in Redis (user-cache.ts) ready: a new account's first page sends a dozen calls
 * at once, and without the copy each of them would first look the user up in the database (about
 * 260 ms at Neon's distance). Usually Clerk's webhook creates the account a moment before that
 * page opens. A row that has just changed gets no copy, by the copy's own rule.
 */
export async function provisionUser(data: ClerkUserData): Promise<User> {
  const { user, created } = await upsertUserFromClerk(data);
  if (created) {
    await enqueueOnboarding(user.id);
    await notifySignUp(user, data.via);
  }
  await Promise.all([keepUserId(user.clerkId, user.id), keepUser(user)]);
  return user;
}

/** Tells the founder about a new account, once per user. Never throws. */
async function notifySignUp(user: User, via: ClerkUserData['via']): Promise<void> {
  try {
    const total = (await userCounts()).total;
    await notifyFounder(
      'signup',
      `New sign-up: ${user.name || '(no name)'} ${user.email}, via ${via ?? 'email'}, total users: ${total}`,
      `signup:${user.id}`,
    );
  } catch {
    // an alert must never break sign-up
  }
}

/** Accounts being created from a session in this process, by Clerk id (resolveSessionUser). */
const provisioning = new Map<string, Promise<User | undefined>>();

async function provisionFromClerk(clerkId: string): Promise<User | undefined> {
  const data = await fetchClerkUser(clerkId).catch(() => undefined);
  if (!data) return undefined;
  return provisionUser(data);
}

/**
 * The user behind a verified session. If the session arrives before Clerk's `user.created`
 * webhook, the user is provisioned from Clerk's API (same idempotent path as the webhook). The
 * calls of a new account's first page arrive together: they share one look-up at Clerk and one
 * insert, instead of each making its own.
 */
export async function resolveSessionUser(clerkId: string): Promise<User | undefined> {
  const existing = await getUserByClerkIdCached(clerkId);
  if (existing) return existing.deletedAt ? undefined : existing;
  let pending = provisioning.get(clerkId);
  if (!pending) {
    pending = provisionFromClerk(clerkId).finally(() => provisioning.delete(clerkId));
    provisioning.set(clerkId, pending);
  }
  return pending;
}
