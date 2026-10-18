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
// The wake fee goes with it: the turn that started work in an awake period names that period
// (`wakePeriod`), and the job charges its fee first, keyed by the period (wake-fee.ts), so it is
// charged once however often the job runs and however many turns name the same period.
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
import { chargeWakeFee } from './wake-fee.ts';

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
  /**
   * The awake period whose wake fee this turn pays (it was the period's first work). Null or left
   * out: no fee (the container was already paid for, the turn ran no work, or it failed on our
   * side).
   */
  wakePeriod?: string | null;
}

/** The wake fee first, so it lands inside the usage period the sync then writes. */
async function billWakeFee(userId: string, turnId: string, period: string | null | undefined) {
  if (period) await chargeWakeFee(userId, { period, turnId });
}

/**
 * A turn not billed yet, in Redis: '1' or '0' (LiteLLM asked or not), then its wake fee's period
 * after a space when it pays one. A note from before the wake fee is just '1' or '0'.
 */
const unbilledValue = (turn: TurnToBill) =>
  `${turn.ai ? '1' : '0'}${turn.wakePeriod ? ` ${turn.wakePeriod}` : ''}`;
const parseUnbilled = (v: string) => {
  const [ai, period] = v.split(' ');
  return { ai: ai === '1', period: period ?? null };
};

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
      .hset(unbilledKey(userId), turn.turnId, unbilledValue(turn))
      .expire(unbilledKey(userId), UNBILLED_TTL_SECONDS)
      .exec();
    await addJob(
      'system',
      'bill-turn',
      {
        userId,
        turnId: turn.turnId,
        ai: turn.ai,
        ...(turn.wakePeriod ? { wakePeriod: turn.wakePeriod } : {}),
      },
      { jobId: billTurnJobId(turn.turnId) },
    );
  } catch (err) {
    logger().warn(
      { userId, turnId: turn.turnId, err: String(err) },
      'billing job not queued; billing the turn now',
    );
    await billWakeFee(userId, turn.turnId, turn.wakePeriod)
      .then(() => syncUsageForUser(userId, new Date(), { ai: turn.ai }))
      .catch((e: unknown) =>
        logger().warn({ userId, err: String(e) }, 'billing of the turn failed'),
      );
    await redis()
      .hdel(unbilledKey(userId), turn.turnId)
      .catch(() => {});
  }
}

/**
 * system/bill-turn: charges the turn's wake fee if it names one (once per awake period), then the
 * usage up to now (usage.ts), then tells listeners (the web app gets the new balance). Throws when
 * a charge fails, so the queue tries again.
 */
export async function handleBillTurn(job: Job): Promise<SyncResult> {
  const { userId, turnId, ai, wakePeriod } = job.data as {
    userId: string;
    turnId: string;
    ai?: boolean;
    wakePeriod?: string;
  };
  await billWakeFee(userId, turnId, wakePeriod);
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
  return Object.fromEntries(Object.entries(raw).map(([id, v]) => [id, parseUnbilled(v).ai]));
}

/**
 * Before a turn's credit check: when more turns than allowed still wait for their billing, bill
 * them now, so the check sees their charges. Usually one Redis read and nothing else. Never fails
 * the turn: a failure is logged and the turn goes on, as it did when the after-turn sync failed.
 */
export async function settleUnbilledTurns(userId: string): Promise<void> {
  let waiting: Record<string, { ai: boolean; period: string | null }>;
  try {
    const raw = await redis().hgetall(unbilledKey(userId));
    waiting = Object.fromEntries(Object.entries(raw).map(([id, v]) => [id, parseUnbilled(v)]));
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'turns waiting for billing not readable');
    return;
  }
  const ids = Object.keys(waiting);
  if (ids.length <= UNBILLED_TURNS_ALLOWED) return;
  try {
    // Turns run one at a time per user, so no turn can be added while this runs. Their wake fees
    // too (keyed by the period: their jobs charge nothing more later).
    for (const [id, t] of Object.entries(waiting)) await billWakeFee(userId, id, t.period);
    await syncUsageForUser(userId, new Date(), {
      ai: Object.values(waiting).some((t) => t.ai),
    });
    await redis().hdel(unbilledKey(userId), ...ids);
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'billing of earlier turns before a turn failed');
  }
}
