// App actions (HLD 7.2, 7.4): 1 credit for each successful app action that changes something.
// They are charged when the action runs, as their own ledger rows (`meta.kind = app_action`),
// so what users see about them is read back from the ledger.
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { creditLedger } from './schema.ts';

/** `meta.kind` of an app-action charge in the ledger. */
export const APP_ACTION_KIND = 'app_action';

const isAppActionCharge = and(
  eq(creditLedger.reason, 'charge'),
  sql`${creditLedger.meta}->>'kind' = ${APP_ACTION_KIND}`,
);

export interface AppActionCharge {
  /** The charge's idempotency key (what a reversal refers to). */
  chargeKey: string;
  credits: number;
  createdAt: Date;
}

/** A user's app-action charges made in [from, to), oldest first. */
export async function listAppActionCharges(
  userId: string,
  from: Date,
  to: Date,
  tx: Tx = db(),
): Promise<AppActionCharge[]> {
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
        isAppActionCharge,
        gte(creditLedger.createdAt, from),
        lt(creditLedger.createdAt, to),
      ),
    )
    .orderBy(creditLedger.createdAt, creditLedger.id);
  return rows.map((r) => ({ chargeKey: r.chargeKey, credits: -r.delta, createdAt: r.createdAt }));
}

/**
 * App-action credits per usage period, for `GET /v1/usage`. A charge belongs to the period it
 * was made in. Like the other usage numbers, this is what was used: a later refund of a failed
 * turn shows in the credit history, not here.
 */
export async function appActionCreditsFor<P extends { periodStart: Date; periodEnd: Date }>(
  userId: string,
  periods: P[],
): Promise<number[]> {
  if (!periods.length) return [];
  const first = Math.min(...periods.map((p) => p.periodStart.getTime()));
  const last = Math.max(...periods.map((p) => p.periodEnd.getTime()));
  const charges = await listAppActionCharges(userId, new Date(first), new Date(last));
  return periods.map((p) =>
    charges
      .filter((c) => c.createdAt >= p.periodStart && c.createdAt < p.periodEnd)
      .reduce((n, c) => n + c.credits, 0),
  );
}
