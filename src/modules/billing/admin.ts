// Admin credit adjustments (HLD 7.3 "Admin adjustment: any amount, expiry set by the admin").
import { db } from '../../shared/db/client.ts';
import { audit } from '../admin/audit.ts';
import { createGrantInTx, ledgerKeyExists, spendInTx } from './credits.ts';
import { afterCreditsAdded, afterCreditsRemoved } from './enforce.ts';

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
