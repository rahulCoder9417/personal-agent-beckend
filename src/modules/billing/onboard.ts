// Account lifecycle hooks for billing (called by the orchestrator's onboard/delete jobs).
import { logger } from '../../shared/logger.ts';
import { db } from '../../shared/db/client.ts';
import { audit } from '../admin/audit.ts';
import { getActiveUser } from '../auth/users.ts';
import { createGrantInTx, ledgerKeyExists } from './credits.ts';
import { dodo } from './dodo.ts';
import { freeCapAllows } from './free-credits.ts';
import { ensureLiteLLMKey, refreshBudget, revokeLiteLLMKey } from './litellm.ts';
import { SIGNUP_CREDITS, creditExpiry } from './plans.ts';
import { getRenewingSubscription } from './subscriptions.ts';

/**
 * Idempotent onboarding: the 100 sign-up credits (once ever, unless the free-credit monthly cap
 * is reached) and the user's LiteLLM key with a budget equal to the balance.
 */
export async function onboardBilling(userId: string): Promise<{ signupGranted: boolean }> {
  const user = await getActiveUser(userId);
  if (!user) return { signupGranted: false };
  const key = `signup:${userId}`;
  const signupGranted = await db().transaction(async (tx) => {
    if (await ledgerKeyExists(tx, key)) return false; // already granted
    if (!(await freeCapAllows(tx, SIGNUP_CREDITS))) {
      await audit(
        {
          userId,
          actor: 'system',
          action: 'signup_credits_skipped',
          summary: 'Sign-up credits not granted: the free-credit monthly cap is reached',
        },
        tx,
      );
      return false;
    }
    const { created } = await createGrantInTx(tx, {
      userId,
      source: 'signup',
      amount: SIGNUP_CREDITS,
      expiresAt: creditExpiry(),
      idempotencyKey: key,
      description: 'Sign-up credits',
    });
    return created;
  });
  await ensureLiteLLMKey(userId);
  await refreshBudget(userId);
  return { signupGranted };
}

/** Account deletion: revoke the LiteLLM key and stop the subscription renewing. */
export async function offboardBilling(userId: string): Promise<void> {
  await revokeLiteLLMKey(userId);
  const sub = await getRenewingSubscription(userId);
  if (sub) {
    try {
      await dodo().cancelAtPeriodEnd(sub.polarSubscriptionId);
    } catch (err) {
      logger().error({ userId, err: (err as Error).message }, 'could not cancel Dodo subscription');
      throw err;
    }
  }
}
