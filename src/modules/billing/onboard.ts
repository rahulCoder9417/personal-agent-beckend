// Account lifecycle hooks for billing (called by the orchestrator's onboard/delete jobs).
import { logger } from '../../shared/logger.ts';
import { db } from '../../shared/db/client.ts';
import { audit } from '../admin/audit.ts';
import { getActiveUser, getUser } from '../auth/users.ts';
import { createGrantInTx, ledgerKeyExists } from './credits.ts';
import { claimSignupEmail, rememberEmail } from './email-marks.ts';
import { polar } from './polar.ts';
import { freeCapAllows } from './free-credits.ts';
import { ensureLiteLLMKey, revokeLiteLLMKey, syncLiteLLMKey } from './litellm.ts';
import { SIGNUP_CREDITS, signupCreditExpiry } from './plans.ts';
import { getRenewingSubscription } from './subscriptions.ts';

/**
 * Idempotent onboarding: the 100 sign-up credits for 14 days (once per inbox: not when another
 * account, live or deleted, had the same email in its normal form; and not when the free-credit
 * monthly cap is reached) and the user's LiteLLM key with a budget equal to the balance.
 */
export async function onboardBilling(userId: string): Promise<{ signupGranted: boolean }> {
  const user = await getActiveUser(userId);
  if (!user) return { signupGranted: false };
  const key = `signup:${userId}`;
  const signupGranted = await db().transaction(async (tx) => {
    if (await ledgerKeyExists(tx, key)) return false; // already granted
    // The account is made as usual; only the free credits are held back.
    if ((await claimSignupEmail(tx, userId, user.email)) === 'taken') {
      await audit(
        {
          userId,
          actor: 'system',
          action: 'signup_credits_skipped',
          summary:
            'Sign-up credits not granted: another account had this email (or a spelling of the same inbox) before',
          details: { reason: 'email_seen_before' },
        },
        tx,
      );
      return false;
    }
    if (!(await freeCapAllows(tx, SIGNUP_CREDITS))) {
      await audit(
        {
          userId,
          actor: 'system',
          action: 'signup_credits_skipped',
          summary: 'Sign-up credits not granted: the free-credit monthly cap is reached',
          details: { reason: 'monthly_cap' },
        },
        tx,
      );
      return false;
    }
    const { created } = await createGrantInTx(tx, {
      userId,
      source: 'signup',
      amount: SIGNUP_CREDITS,
      expiresAt: signupCreditExpiry(),
      idempotencyKey: key,
      description: 'Sign-up credits',
    });
    return created;
  });
  await ensureLiteLLMKey(userId);
  await syncLiteLLMKey(userId);
  return { signupGranted };
}

/**
 * Account deletion: remember the inbox (so signing up again gives no new sign-up credits), revoke
 * the LiteLLM key (and the own key LiteLLM holds), stop renewals. Runs before the account row
 * loses its email.
 */
export async function offboardBilling(userId: string): Promise<void> {
  const user = await getUser(userId);
  if (user) await rememberEmail(userId, user.email);
  await revokeLiteLLMKey(userId);
  const sub = await getRenewingSubscription(userId);
  if (sub) {
    try {
      await polar().cancelAtPeriodEnd(sub.polarSubscriptionId);
    } catch (err) {
      logger().error(
        { userId, err: (err as Error).message },
        'could not cancel Polar subscription',
      );
      throw err;
    }
  }
}
