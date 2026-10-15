import { addJob } from '../events/queues.ts';
import {
  fetchClerkUser,
  getUserByClerkIdCached,
  upsertUserFromClerk,
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

/** Creates/updates the user from Clerk data; onboards only on the call that created it. */
export async function provisionUser(data: ClerkUserData): Promise<User> {
  const { user, created } = await upsertUserFromClerk(data);
  if (created) await enqueueOnboarding(user.id);
  return user;
}

/**
 * The user behind a verified session. If the session arrives before Clerk's `user.created`
 * webhook, the user is provisioned from Clerk's API (same idempotent path as the webhook).
 */
export async function resolveSessionUser(clerkId: string): Promise<User | undefined> {
  const existing = await getUserByClerkIdCached(clerkId);
  if (existing) return existing.deletedAt ? undefined : existing;
  const data = await fetchClerkUser(clerkId).catch(() => undefined);
  if (!data) return undefined;
  return provisionUser(data);
}
