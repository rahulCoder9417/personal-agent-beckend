// The wake fee (decided 18 Oct 2026): 1 credit each time the agent's container wakes from sleep
// to do work, on top of its awake time. It is charged once per awake period that runs work: the
// orchestrator names the period (orchestrator/awake-periods.ts, from the vm-manager's
// `was_stopped`), the turn passes it to its billing job, and the charge is keyed by it, so a
// second turn in the same period, a re-run job or a second job of the same turn charges nothing
// more. Like app actions it is its own ledger row (`meta.kind = wake`), so the usage report and
// the admin can show it apart from awake time. Any grant may pay it, like awake time.
import { db } from '../../shared/db/client.ts';
import { getBalance, spendInTx } from './credits.ts';
import { maybeQueueAutoTopUp } from './auto-topup.ts';
import { afterCreditsRemoved } from './enforce.ts';
import { itemCreditsFor, listItemCharges } from './item-charges.ts';

/** `meta.kind` of a wake-fee charge in the ledger. */
export const WAKE_KIND = 'wake';
/** 1 credit each time the container wakes to do work. */
export const WAKE_FEE_CREDITS = 1;
export const WAKE_FEE_DESCRIPTION = 'Waking your agent';

const wakeKey = (userId: string, period: string) => `wake:${userId}:${period}`;

/**
 * Charges the wake fee of one awake period, once. `turnId`: the turn that started work in it (kept
 * in the ledger row's meta). Returns what was charged (0 if this period paid it before).
 */
export async function chargeWakeFee(
  userId: string,
  input: { period: string; turnId: string },
  now = new Date(),
): Promise<{ charged: number }> {
  const { charged } = await db().transaction((tx) =>
    spendInTx(
      tx,
      userId,
      {
        restricted: 0,
        flexible: WAKE_FEE_CREDITS,
        idempotencyKey: wakeKey(userId, input.period),
        reason: 'charge',
        description: WAKE_FEE_DESCRIPTION,
        meta: { kind: WAKE_KIND, turnId: input.turnId },
      },
      now,
    ),
  );
  if (charged > 0) {
    const balance = await getBalance(userId);
    // The last credit went: close the AI budget and pause automations (HLD 7.5).
    if (balance <= 0) await afterCreditsRemoved(userId);
    await maybeQueueAutoTopUp(userId, balance);
  }
  return { charged };
}

/** Wake-fee credits per usage period, for `GET /v1/usage` (`wakeCredits`). */
export function wakeCreditsFor<P extends { periodStart: Date; periodEnd: Date }>(
  userId: string,
  periods: P[],
): Promise<number[]> {
  return itemCreditsFor(userId, WAKE_KIND, periods);
}

/** Wake-fee credits charged in [from, to) (the admin's "today"). */
export async function wakeCreditsBetween(userId: string, from: Date, to: Date): Promise<number> {
  const charges = await listItemCharges(userId, WAKE_KIND, from, to);
  return charges.reduce((n, c) => n + c.credits, 0);
}
