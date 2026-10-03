// App actions (HLD 7.2, 7.4): 1 credit for each successful app action that changes something.
// They are charged when the action runs, as their own ledger rows (`meta.kind = app_action`),
// so what users see about them is read back from the ledger.
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { db, type Tx } from '../../shared/db/client.ts';
import { getBalance, restoreChargesInTx, spendInTx } from './credits.ts';
import { afterCreditsRemoved } from './enforce.ts';
import { creditLedger } from './schema.ts';

/** `meta.kind` of an app-action charge in the ledger. */
export const APP_ACTION_KIND = 'app_action';
/** HLD 7.2: 1 credit per successful app action that changes something. */
export const APP_ACTION_CREDITS = 1;

const appActionKey = (ref: string) => `app-action:${ref}`;

/**
 * Charges one successful app action, once per `ref`: the approval id when the action was
 * approved (an approval is single use), otherwise an id made for that one run.
 * Any grant may pay it, cheap-model-only ones too (HLD 7.7), like awake time. Returns what was
 * charged (0 if this `ref` was charged before).
 */
export async function chargeAppAction(
  userId: string,
  input: { action: string; ref: string },
  now = new Date(),
): Promise<{ charged: number; balance: number }> {
  const { charged } = await db().transaction((tx) =>
    spendInTx(
      tx,
      userId,
      {
        restricted: 0,
        flexible: APP_ACTION_CREDITS,
        idempotencyKey: appActionKey(input.ref),
        reason: 'charge',
        description: `App action: ${input.action}`,
        meta: { kind: APP_ACTION_KIND, action: input.action },
      },
      now,
    ),
  );
  const balance = await getBalance(userId);
  // The last credit went: close the AI budget and pause automations (HLD 7.5).
  if (charged > 0 && balance <= 0) await afterCreditsRemoved(userId);
  return { charged, balance };
}

/**
 * HLD 7.2: a turn that failed because of us isn't charged. Gives back the app-action credits
 * charged during the turn, to the grants they came from. Call inside a transaction; idempotent
 * per `idempotencyKey`. Inbound work holds the user's lock, so every app action in the turn's
 * window belongs to that turn.
 */
export async function restoreAppActionChargesInTx(
  tx: Tx,
  userId: string,
  turn: { startedAt: Date; endedAt: Date; idempotencyKey: string },
): Promise<number> {
  const charges = await listAppActionCharges(userId, turn.startedAt, turn.endedAt, tx);
  const { restored } = await restoreChargesInTx(tx, userId, {
    chargeKeys: charges.map((c) => c.chargeKey),
    amount: charges.reduce((n, c) => n + c.credits, 0),
    idempotencyKey: turn.idempotencyKey,
    description: 'Failed turn refunded (app actions)',
  });
  return restored;
}

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
