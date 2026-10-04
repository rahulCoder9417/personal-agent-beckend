// App actions (HLD 7.2, 7.4): 1 credit for each successful app action that changes something.
// They are charged when the action runs, as their own ledger rows (`meta.kind = app_action`),
// so what users see about them is read back from the ledger.
import { db, type Tx } from '../../shared/db/client.ts';
import { getBalance, spendInTx } from './credits.ts';
import { afterCreditsRemoved } from './enforce.ts';
import { itemCreditsFor, restoreItemChargesInTx } from './item-charges.ts';

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

/** A failed turn caused by us: gives back the app-action credits charged during it (HLD 7.2). */
export function restoreAppActionChargesInTx(
  tx: Tx,
  userId: string,
  turn: { startedAt: Date; endedAt: Date; idempotencyKey: string },
): Promise<number> {
  return restoreItemChargesInTx(
    tx,
    userId,
    APP_ACTION_KIND,
    turn,
    'Failed turn refunded (app actions)',
  );
}

/** App-action credits per usage period, for `GET /v1/usage`. */
export function appActionCreditsFor<P extends { periodStart: Date; periodEnd: Date }>(
  userId: string,
  periods: P[],
): Promise<number[]> {
  return itemCreditsFor(userId, APP_ACTION_KIND, periods);
}
