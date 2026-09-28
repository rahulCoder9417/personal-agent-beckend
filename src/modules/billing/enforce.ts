// Balance enforcement after credits change (HLD 7.5): keep the LiteLLM budget equal to the
// balance and tell listeners (e.g. automations) when a user hits zero or gets credits back.
import { getBalance } from './credits.ts';
import { fireBalanceDepleted, fireCreditsAdded } from './hooks.ts';
import { refreshBudgetQuietly } from './litellm.ts';

/** After credits were added (payment, coupon, monthly grant, admin, reversal). */
export async function afterCreditsAdded(userId: string): Promise<void> {
  await refreshBudgetQuietly(userId);
  if ((await getBalance(userId)) > 0) await fireCreditsAdded(userId);
  else await fireBalanceDepleted(userId);
}

/** After credits were removed (charge, expiry, refund, revoke). */
export async function afterCreditsRemoved(userId: string): Promise<void> {
  await refreshBudgetQuietly(userId);
  if ((await getBalance(userId)) <= 0) await fireBalanceDepleted(userId);
}
