// Billing's system jobs and their schedules (HLD 5.2).
import type { Job } from 'bullmq';
import { addJob, queue } from '../events/queues.ts';
import { expireDueGrants } from './credits.ts';
import { afterCreditsRemoved } from './enforce.ts';
import { endLapsedSubscriptions } from './subscriptions.ts';
import { reverseTurn, syncAllUsage, syncUsageForUser } from './usage.ts';

export { handlePolarEvent } from './polar-events.ts';

export const SYNC_USAGE_EVERY_MS = 5 * 60 * 1000;
export const EXPIRE_CREDITS_EVERY_MS = 60 * 60 * 1000;

/** system/sync-usage: every 5 min for everyone, or `{ userId }` for one user (after a turn). */
export async function handleSyncUsage(job: Job): Promise<unknown> {
  const userId = (job.data as { userId?: string }).userId;
  if (userId) return syncUsageForUser(userId);
  return syncAllUsage();
}

// --- refund of a turn that failed on our side (HLD 7.2) --------------------------------------
// The turn only adds this job; the user is told at once and never waits for it. It runs a little
// later, so LiteLLM has written the turn's spend log (it writes in batches, every 10 to 15 s).
// The job id dedupes a second add; the idempotency keys and one transaction make a re-run give
// nothing twice; the queue's retries (5 tries, about 13 minutes) cover a failure.

export interface FailedTurn {
  startedAt: Date;
  endedAt: Date;
  /** `fault:<event id>`: one refund per turn. */
  idempotencyKey: string;
}

let refundDelayMs = 30_000;

/** Tests: run the refund at once. */
export function setTurnRefundDelay(ms: number): void {
  refundDelayMs = ms;
}

export async function queueTurnRefund(userId: string, turn: FailedTurn): Promise<void> {
  await addJob(
    'system',
    'refund-turn',
    {
      userId,
      startedAt: turn.startedAt.toISOString(),
      endedAt: turn.endedAt.toISOString(),
      idempotencyKey: turn.idempotencyKey,
    },
    // BullMQ ids can't hold ':'.
    { jobId: `refund-${turn.idempotencyKey.replaceAll(':', '-')}`, delay: refundDelayMs },
  );
}

/**
 * system/refund-turn. Each try works it out again. On the last try, if LiteLLM still can't say what
 * the AI cost, everything else is given back (awake and browser time, app actions, paid tools).
 */
export async function handleRefundTurn(job: Job): Promise<unknown> {
  const d = job.data as {
    userId: string;
    startedAt: string;
    endedAt: string;
    idempotencyKey: string;
  };
  const lastTry = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  return reverseTurn(
    d.userId,
    {
      startedAt: new Date(d.startedAt),
      endedAt: new Date(d.endedAt),
      idempotencyKey: d.idempotencyKey,
    },
    { withoutAiIfUnknown: lastTry },
  );
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
