// A turn's billing (HLD 7.4): a job of its own on the system queue, so the user's lock is given
// back as soon as the reply is out and the next message never waits for the charge. The turn only
// adds the job (Redis, no database trip) before it ends, so the job exists before the lock goes.
//
// The job is the usage sync for that user (usage.ts): one charge for everything since the last
// charged period, keyed by (user, period start). So it can run any number of times: a second run
// finds the period charged and covers only what came after. The job id, one per turn, keeps a
// second add from queueing it twice; a failed run is retried by the queue. Should it never run
// (the worker died first, Redis lost it), the 5-minute sync charges the same usage: usage is
// charged by period, never by turn, so nothing is lost and nothing is charged twice.
//
// The turns not billed yet are noted in Redis, so the check before a turn can see them. A turn
// may start while the one before it is still being billed (the usual case: a second message sent
// right after a reply), but not while two are: it then bills them itself first. So a user is
// never more than one turn ahead of their charges, even when the system queue is slow or stopped.
import type { Job } from 'bullmq';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { addJob } from '../events/queues.ts';
import { fireTurnBilled } from './hooks.ts';
import { syncUsageForUser, type SyncResult } from './usage.ts';

/** How many turns may still wait for their billing when the next one starts. */
export const UNBILLED_TURNS_ALLOWED = 1;
/** A note left by a job that never ran goes after this; the 5-minute sync charges its usage. */
export const UNBILLED_TTL_SECONDS = 60 * 60;
const unbilledKey = (userId: string) => `unbilled-turns:${userId}`;

export interface TurnToBill {
  /** The turn's delivery id (its event id): one billing job per turn. */
  turnId: string;
  /** `false`: the turn ran on the user's Claude plan, so LiteLLM is not asked (usage.ts). */
  ai: boolean;
}

/** BullMQ ids can't hold ':'. */
export const billTurnJobId = (turnId: string) => `bill-turn-${turnId.replaceAll(':', '-')}`;

/**
 * Notes the turn as not billed yet and adds its billing job. Quick: two Redis writes. If Redis
 * refuses, the turn is billed here instead, as before this job existed (never fails the turn).
 */
export async function queueTurnBilling(userId: string, turn: TurnToBill): Promise<void> {
  try {
    await redis()
      .multi()
      .hset(unbilledKey(userId), turn.turnId, turn.ai ? '1' : '0')
      .expire(unbilledKey(userId), UNBILLED_TTL_SECONDS)
      .exec();
    await addJob(
      'system',
      'bill-turn',
      { userId, turnId: turn.turnId, ai: turn.ai },
      { jobId: billTurnJobId(turn.turnId) },
    );
  } catch (err) {
    logger().warn(
      { userId, turnId: turn.turnId, err: String(err) },
      'billing job not queued; billing the turn now',
    );
    await syncUsageForUser(userId, new Date(), { ai: turn.ai }).catch((e: unknown) =>
      logger().warn({ userId, err: String(e) }, 'billing of the turn failed'),
    );
    await redis()
      .hdel(unbilledKey(userId), turn.turnId)
      .catch(() => {});
  }
}

/**
 * system/bill-turn: charges the usage up to now (usage.ts), then tells listeners (the web app gets
 * the new balance). Throws when the sync fails, so the queue tries again.
 */
export async function handleBillTurn(job: Job): Promise<SyncResult> {
  const { userId, turnId, ai } = job.data as { userId: string; turnId: string; ai?: boolean };
  const result = await syncUsageForUser(userId, new Date(), { ai: ai !== false });
  await redis()
    .hdel(unbilledKey(userId), turnId)
    .catch(() => {});
  await fireTurnBilled(userId);
  return result;
}

/** The turns of this user whose billing has not run yet (turn id → whether LiteLLM is asked). */
export async function unbilledTurns(userId: string): Promise<Record<string, boolean>> {
  const raw = await redis().hgetall(unbilledKey(userId));
  return Object.fromEntries(Object.entries(raw).map(([id, ai]) => [id, ai === '1']));
}

/**
 * Before a turn's credit check: when more turns than allowed still wait for their billing, bill
 * them now, so the check sees their charges. Usually one Redis read and nothing else. Never fails
 * the turn: a failure is logged and the turn goes on, as it did when the after-turn sync failed.
 */
export async function settleUnbilledTurns(userId: string): Promise<void> {
  let waiting: Record<string, boolean>;
  try {
    waiting = await unbilledTurns(userId);
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'turns waiting for billing not readable');
    return;
  }
  const ids = Object.keys(waiting);
  if (ids.length <= UNBILLED_TURNS_ALLOWED) return;
  try {
    // Turns run one at a time per user, so no turn can be added while this runs.
    await syncUsageForUser(userId, new Date(), { ai: Object.values(waiting).some(Boolean) });
    await redis().hdel(unbilledKey(userId), ...ids);
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'billing of earlier turns before a turn failed');
  }
}
