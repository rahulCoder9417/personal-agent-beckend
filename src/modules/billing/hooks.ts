// In-process listeners for balance and plan changes (HLD 7.5, 11.3). Other modules register here,
// e.g. the automations module pauses a user's automations at zero and un-pauses them when credits
// arrive, and the orchestrator switches Scout's browser on or off when the plan changes.
import { logger } from '../../shared/logger.ts';

export type BalanceListener = (userId: string) => void | Promise<void>;

const depleted = new Set<BalanceListener>();
const added = new Set<BalanceListener>();
const planChanged = new Set<BalanceListener>();
const turnBilled = new Set<BalanceListener>();

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

/**
 * Called after a user's plan changed: an upgrade, a downgrade, or a cancelled subscription
 * reaching its end. Not called when a renewal keeps the plan.
 */
export function onPlanChanged(fn: BalanceListener): () => void {
  planChanged.add(fn);
  return () => planChanged.delete(fn);
}

/**
 * Called after a turn's billing job has run (charged or not), e.g. to send the web app the new
 * balance. Returns an unsubscribe function.
 */
export function onTurnBilled(fn: BalanceListener): () => void {
  turnBilled.add(fn);
  return () => turnBilled.delete(fn);
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
export const firePlanChanged = (userId: string) => fire(planChanged, userId, 'plan_changed');
export const fireTurnBilled = (userId: string) => fire(turnBilled, userId, 'turn_billed');
