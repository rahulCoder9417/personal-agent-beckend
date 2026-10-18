// Which awake period a user's container is in, for the wake fee (billing/wake-fee.ts: 1 credit
// each time the container wakes to do work, once per awake period).
//
// The vm-manager's WakeSandbox answers `was_stopped` when that call woke a sleeping container: a
// new awake period starts there. Every wake the backend asks for notes it (a turn, the web app's
// prewarm, an admin's wake) under a name of its own. The first turn that runs work in the period
// takes the name to its billing job, which charges the fee keyed by it; the period is then marked
// paid, so the turns after it in the same period pay none. A turn's own wake is named after the
// turn, so a job tried again (even after the container slept meanwhile) names the same period.
//
// Kept in Redis for a day. Redis down or the note lost: no fee (never a fee twice). A wake the
// vm-manager makes by itself (a Claude sign-in or sign-out) is not noted: a turn in such a period
// pays the fee only if the period before it ended unpaid; never twice.
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';

const PERIOD_TTL_SECONDS = 24 * 3600;
const currentKey = (userId: string) => `awake-period:${userId}`;
const paidKey = (userId: string) => `awake-period-paid:${userId}`;

/** After a WakeSandbox: if it woke a sleeping container, a new awake period called `name` began. */
export async function noteWake(userId: string, wasStopped: boolean, name: string): Promise<void> {
  if (!wasStopped) return;
  try {
    await redis().set(currentKey(userId), name, 'EX', PERIOD_TTL_SECONDS);
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'awake period not noted; its wake fee is skipped');
  }
}

/** The current awake period if its wake fee is not paid yet, else null. Never throws. */
export async function unpaidAwakePeriod(userId: string): Promise<string | null> {
  try {
    const [current, paid] = await redis().mget(currentKey(userId), paidKey(userId));
    return current && current !== paid ? current : null;
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'awake period not read; no wake fee');
    return null;
  }
}

/** The period's fee is on its way (its billing job is queued). Never throws. */
export async function markAwakePeriodPaid(userId: string, name: string): Promise<void> {
  try {
    await redis().set(paidKey(userId), name, 'EX', PERIOD_TTL_SECONDS);
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'awake period not marked paid');
  }
}
