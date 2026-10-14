// Admin changes to billing: credit adjustments (HLD 7.3 "Admin adjustment: any amount, expiry set
// by the admin") and a plan set by hand (docs/backend-report.md, "Moving between plans").
import { db } from '../../shared/db/client.ts';
import { audit } from '../admin/audit.ts';
import { setPlan, type PlanId } from '../auth/users.ts';
import { createGrantInTx, ledgerKeyExists, spendInTx } from './credits.ts';
import { afterCreditsAdded, afterCreditsRemoved } from './enforce.ts';
import { firePlanChanged } from './hooks.ts';
import { PLANS } from './plans.ts';

/**
 * Positive: a new `admin` grant. Negative: taken from the user's grants in the spending order
 * (any grant; an overrun becomes debt). Idempotent per key.
 */
export async function adjustCredits(input: {
  userId: string;
  amount: number;
  reason: string;
  expiresAt: Date | null;
  idempotencyKey: string;
  adminId: string;
}): Promise<void> {
  const key = `admin:${input.userId}:${input.idempotencyKey}`;
  const applied = await db().transaction(async (tx) => {
    if (await ledgerKeyExists(tx, key)) return false;
    if (input.amount > 0) {
      await createGrantInTx(tx, {
        userId: input.userId,
        source: 'admin',
        amount: input.amount,
        expiresAt: input.expiresAt,
        idempotencyKey: key,
        description: input.reason,
        meta: { adminId: input.adminId },
      });
    } else {
      await spendInTx(tx, input.userId, {
        restricted: 0,
        flexible: -input.amount,
        reason: 'adjust',
        idempotencyKey: key,
        description: input.reason,
        meta: { adminId: input.adminId },
      });
    }
    await audit(
      {
        userId: input.userId,
        actor: 'admin',
        action: 'credits_adjusted',
        summary: `${input.amount > 0 ? '+' : ''}${input.amount} credits: ${input.reason}`,
        details: { adminId: input.adminId, idempotencyKey: input.idempotencyKey },
      },
      tx,
    );
    return true;
  });
  if (!applied) return;
  if (input.amount > 0) await afterCreditsAdded(input.userId);
  else await afterCreditsRemoved(input.userId);
}

/**
 * Sets a user's plan by hand: the steps a paid change of plan takes (polar-events.ts,
 * subscriptions.ts), with no payment and no monthly grant. The plan; then the LiteLLM key's models
 * and budget and the balance listeners; then, when the plan changed, the plan-changed listeners
 * (Scout's browser switch, a system job the worker runs) and one activity-log entry with the
 * admin's id. The queue priority needs no step: each wake and each queued message reads the plan.
 * The same plan again changes nothing and writes nothing. Used by the admin api and the ops script.
 */
export async function setPlanByHand(input: {
  userId: string;
  /** The plan the user is on now (for the log). */
  from: PlanId;
  plan: PlanId;
  adminId: string;
  reason?: string;
}): Promise<{ changed: boolean }> {
  const changed = await setPlan(input.userId, input.plan);
  // Free comes from a subscription that ended; a paid plan from a new period or a change.
  if (input.plan === 'free') await afterCreditsRemoved(input.userId);
  else await afterCreditsAdded(input.userId);
  if (changed) {
    await firePlanChanged(input.userId);
    const why = input.reason?.trim();
    await audit({
      userId: input.userId,
      actor: 'admin',
      action: 'plan_changed',
      summary: `Plan set to ${PLANS[input.plan].name} by hand (no payment)${why ? `: ${why}` : ''}`,
      details: { from: input.from, to: input.plan, adminId: input.adminId },
    });
  }
  return { changed };
}
