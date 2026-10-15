// Balance enforcement after credits change (HLD 7.5): keep the LiteLLM budget equal to the
// balance and tell listeners (e.g. automations) when a user hits zero or gets credits back.
import { getBalance } from './credits.ts';
import { fireBalanceDepleted, fireCreditsAdded } from './hooks.ts';
import { syncLiteLLMKeyQuietly } from './litellm.ts';

/**
 * After credits were added (payment, coupon, monthly grant, admin, reversal). `litellm: false`
 * (a refund of a turn on the user's Claude plan): the key's budget is left to the 5-minute sync,
 * so LiteLLM is not asked; Claude Code never uses that key.
 */
export async function afterCreditsAdded(
  userId: string,
  opts: { litellm?: boolean } = {},
): Promise<void> {
  if (opts.litellm !== false) await syncLiteLLMKeyQuietly(userId);
  if ((await getBalance(userId)) > 0) await fireCreditsAdded(userId);
  else await fireBalanceDepleted(userId);
}

/** After credits were removed (charge, expiry, refund, revoke). */
export async function afterCreditsRemoved(userId: string): Promise<void> {
  await syncLiteLLMKeyQuietly(userId);
  if ((await getBalance(userId)) <= 0) await fireBalanceDepleted(userId);
}
