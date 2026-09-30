// Billing's system jobs and their schedules (HLD 5.2).
import type { Job } from 'bullmq';
import { queue } from '../events/queues.ts';
import { expireDueGrants } from './credits.ts';
import { afterCreditsRemoved } from './enforce.ts';
import { endLapsedSubscriptions } from './subscriptions.ts';
import { syncAllUsage, syncUsageForUser } from './usage.ts';

export { handlePolarEvent } from './polar-events.ts';

export const SYNC_USAGE_EVERY_MS = 5 * 60 * 1000;
export const EXPIRE_CREDITS_EVERY_MS = 60 * 60 * 1000;

/** system/sync-usage: every 5 min for everyone, or `{ userId }` for one user (after a turn). */
export async function handleSyncUsage(job: Job): Promise<unknown> {
  const userId = (job.data as { userId?: string }).userId;
  if (userId) return syncUsageForUser(userId);
  return syncAllUsage();
}

/** system/expire-credits (hourly): expire grants past their end date and end lapsed plans. */
export async function handleExpireCredits(_job: Job): Promise<unknown> {
  const now = new Date();
  const users = await expireDueGrants(now);
  for (const userId of users) await afterCreditsRemoved(userId);
  const ended = await endLapsedSubscriptions(now);
  return { expiredUsers: users.length, endedSubscriptions: ended };
}

/** Repeatable jobs; safe to call on every worker start (schedulers are upserted by id). */
export async function registerBillingSchedules(): Promise<void> {
  const system = queue('system');
  await system.upsertJobScheduler(
    'sync-usage',
    { every: SYNC_USAGE_EVERY_MS },
    { name: 'sync-usage', data: {} },
  );
  await system.upsertJobScheduler(
    'expire-credits',
    { every: EXPIRE_CREDITS_EVERY_MS },
    { name: 'expire-credits', data: {} },
  );
}
