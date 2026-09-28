// In-process listeners for balance changes (HLD 7.5). Other modules register here, e.g. the
// automations module pauses a user's automations at zero and un-pauses them when credits arrive.
import { logger } from '../../shared/logger.ts';

export type BalanceListener = (userId: string) => void | Promise<void>;

const depleted = new Set<BalanceListener>();
const added = new Set<BalanceListener>();

/** Called when a sync leaves the balance at or below zero. Returns an unsubscribe function. */
export function onBalanceDepleted(fn: BalanceListener): () => void {
  depleted.add(fn);
  return () => depleted.delete(fn);
}

/** Called after credits are added (payment, coupon, monthly grant, admin, reversal). */
export function onCreditsAdded(fn: BalanceListener): () => void {
  added.add(fn);
  return () => added.delete(fn);
}

async function fire(listeners: Set<BalanceListener>, userId: string, hook: string): Promise<void> {
  for (const fn of [...listeners]) {
    try {
      await fn(userId);
    } catch (err) {
      logger().error({ hook, userId, err: (err as Error).message }, 'billing hook failed');
    }
  }
}

export const fireBalanceDepleted = (userId: string) => fire(depleted, userId, 'balance_depleted');
export const fireCreditsAdded = (userId: string) => fire(added, userId, 'credits_added');
