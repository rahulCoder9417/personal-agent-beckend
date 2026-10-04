// Paid tools (HLD 7.2, 7.4): pay-per-use APIs such as Scout's web search, charged at their real
// cost × 2.5 when they run. Each successful call is its own ledger row (`meta.kind = paid_tool`)
// that also records what the call cost us, so the running total needs no counter of its own.
import { and, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { getBalance, ledgerKeyExists, lockUserCredits, spendInTx } from './credits.ts';
import { afterCreditsRemoved } from './enforce.ts';
import { isChargeOfKind, itemCreditsFor, restoreItemChargesInTx } from './item-charges.ts';
import { MICRO_USD_PER_CREDIT } from './plans.ts';
import { creditLedger } from './schema.ts';

/** `meta.kind` of a paid-tool charge in the ledger. */
export const PAID_TOOL_KIND = 'paid_tool';

const paidToolKey = (ref: string) => `paid-tool:${ref}`;

/**
 * What this user's paid-tool calls have cost us so far, and the credits charged for them. A charge
 * paid from two grants is two ledger rows carrying the same cost, so the cost is taken once per
 * charge. Call under the user's credit lock.
 */
async function runningTotals(
  tx: Tx,
  userId: string,
): Promise<{ costMicroUsd: number; credits: number }> {
  const perCharge = tx
    .select({
      cost: sql<string>`max((${creditLedger.meta}->>'costMicroUsd')::bigint)`.as('cost'),
      credits: sql<string>`sum(-${creditLedger.delta})`.as('credits'),
    })
    .from(creditLedger)
    .where(and(eq(creditLedger.userId, userId), isChargeOfKind(PAID_TOOL_KIND)))
    .groupBy(sql`${creditLedger.meta}->>'chargeKey'`)
    .as('per_charge');
  const [row] = await tx
    .select({
      cost: sql<string>`coalesce(sum(${perCharge.cost}), 0)`,
      credits: sql<string>`coalesce(sum(${perCharge.credits}), 0)`,
    })
    .from(perCharge);
  return { costMicroUsd: Number(row?.cost ?? 0), credits: Number(row?.credits ?? 0) };
}

/**
 * Charges one successful paid-tool call, once per `ref`. The price is the cost × 2.5. Credits are
 * whole numbers, so fractions carry over (like awake time): the charge is what the user's total
 * cost has reached in whole credits, minus what was charged before, and never less than 1.
 * At $0.005 a search that is 1, 1, 1, 2: 5 credits for 4 searches.
 * Only normal grants pay (HLD 7.7). A cost of 0 is not charged. Returns what was charged (0 if
 * this `ref` was charged before).
 */
export async function chargePaidTool(
  userId: string,
  input: { tool: string; costMicroUsd: number; ref: string; description: string },
  now = new Date(),
): Promise<{ charged: number; balance: number }> {
  const cost = Math.round(input.costMicroUsd);
  if (!(cost > 0)) return { charged: 0, balance: await getBalance(userId) };
  const key = paidToolKey(input.ref);
  const { charged } = await db().transaction(async (tx) => {
    await lockUserCredits(tx, userId);
    if (await ledgerKeyExists(tx, key)) return { charged: 0 };
    const before = await runningTotals(tx, userId);
    const reached = Math.floor((before.costMicroUsd + cost) / MICRO_USD_PER_CREDIT);
    return spendInTx(
      tx,
      userId,
      {
        restricted: Math.max(1, reached - before.credits),
        flexible: 0,
        idempotencyKey: key,
        reason: 'charge',
        description: input.description,
        meta: { kind: PAID_TOOL_KIND, tool: input.tool, costMicroUsd: cost },
      },
      now,
    );
  });
  const balance = await getBalance(userId);
  // The last credit went: close the AI budget and pause automations (HLD 7.5).
  if (charged > 0 && balance <= 0) await afterCreditsRemoved(userId);
  return { charged, balance };
}

/** A failed turn caused by us: gives back the paid-tool credits charged during it (HLD 7.2). */
export function restorePaidToolChargesInTx(
  tx: Tx,
  userId: string,
  turn: { startedAt: Date; endedAt: Date; idempotencyKey: string },
): Promise<number> {
  return restoreItemChargesInTx(
    tx,
    userId,
    PAID_TOOL_KIND,
    turn,
    'Failed turn refunded (paid tools)',
  );
}

/** Paid-tool credits per usage period, for `GET /v1/usage` (`toolCredits`). */
export function paidToolCreditsFor<P extends { periodStart: Date; periodEnd: Date }>(
  userId: string,
  periods: P[],
): Promise<number[]> {
  return itemCreditsFor(userId, PAID_TOOL_KIND, periods);
}
