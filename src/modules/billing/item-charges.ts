// Charges made when something runs, apart from the usage sync: app actions and paid tools
// (HLD 7.4). Each is its own ledger row, marked with `meta.kind`, so what users see about them
// is read back from the ledger.
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { restoreChargesInTx } from './credits.ts';
import { creditLedger } from './schema.ts';

export interface ItemCharge {
  /** The charge's idempotency key (what a reversal refers to). */
  chargeKey: string;
  credits: number;
  createdAt: Date;
}

/** The ledger rows of one kind of charge (`meta.kind`). */
export const isChargeOfKind = (kind: string) =>
  and(eq(creditLedger.reason, 'charge'), sql`${creditLedger.meta}->>'kind' = ${kind}`);

/** A user's charges of one kind made in [from, to), oldest first. */
export async function listItemCharges(
  userId: string,
  kind: string,
  from: Date,
  to: Date,
  tx: Tx = db(),
): Promise<ItemCharge[]> {
  const rows = await tx
    .select({
      chargeKey: sql<string>`${creditLedger.meta}->>'chargeKey'`,
      delta: creditLedger.delta,
      createdAt: creditLedger.createdAt,
    })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.userId, userId),
        isChargeOfKind(kind),
        gte(creditLedger.createdAt, from),
        lt(creditLedger.createdAt, to),
      ),
    )
    .orderBy(creditLedger.createdAt, creditLedger.id);
  return rows.map((r) => ({ chargeKey: r.chargeKey, credits: -r.delta, createdAt: r.createdAt }));
}

/**
 * HLD 7.2: a turn that failed because of us isn't charged. Gives back the credits of one kind
 * charged during the turn, to the grants they came from. Call inside a transaction; idempotent
 * per `idempotencyKey`. Inbound work holds the user's lock, so every such charge in the turn's
 * window belongs to that turn.
 */
export async function restoreItemChargesInTx(
  tx: Tx,
  userId: string,
  kind: string,
  turn: { startedAt: Date; endedAt: Date; idempotencyKey: string },
  description: string,
): Promise<number> {
  const charges = await listItemCharges(userId, kind, turn.startedAt, turn.endedAt, tx);
  const { restored } = await restoreChargesInTx(tx, userId, {
    chargeKeys: charges.map((c) => c.chargeKey),
    amount: charges.reduce((n, c) => n + c.credits, 0),
    idempotencyKey: turn.idempotencyKey,
    description,
  });
  return restored;
}

/**
 * Credits of one kind per usage period, for `GET /v1/usage`. A charge belongs to the period it
 * was made in. Like the other usage numbers, this is what was used: a later refund of a failed
 * turn shows in the credit history, not here.
 */
export async function itemCreditsFor<P extends { periodStart: Date; periodEnd: Date }>(
  userId: string,
  kind: string,
  periods: P[],
): Promise<number[]> {
  if (!periods.length) return [];
  const first = Math.min(...periods.map((p) => p.periodStart.getTime()));
  const last = Math.max(...periods.map((p) => p.periodEnd.getTime()));
  const charges = await listItemCharges(userId, kind, new Date(first), new Date(last));
  return periods.map((p) =>
    charges
      .filter((c) => c.createdAt >= p.periodStart && c.createdAt < p.periodEnd)
      .reduce((n, c) => n + c.credits, 0),
  );
}
