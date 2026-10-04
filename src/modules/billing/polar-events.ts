// system/polar-event: turns a saved Polar webhook into plan and credit changes (HLD 7.6).
// Exactly once: the event is unique on its webhook-id, and every grant has an idempotency key
// derived from Polar's ids (order, refund, subscription + period), so a re-run changes nothing.
import type { Job } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { config } from '../../shared/config.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { IGNORED } from '../../worker/runner.ts';
import { audit } from '../admin/audit.ts';
import { flagUser, getUser, setPlan } from '../auth/users.ts';
import { findWaitlistOffer, markWaitlistOfferUsed } from '../auth/waitlist.ts';
import { getEvent } from '../events/intake.ts';
import { createGrantInTx } from './credits.ts';
import { afterCreditsAdded, afterCreditsRemoved } from './enforce.ts';
import { firePlanChanged } from './hooks.ts';
import { PLANS, TOP_UPS, PLAN_IDS, creditExpiry, type PlanId } from './plans.ts';
import { isTopUpProduct, planForProduct, type PolarWebhook } from './polar.ts';
import { creditGrants, payments } from './schema.ts';
import {
  endSubscription,
  getSubscriptionByPolarId,
  upsertSubscriptionInTx,
  type SubscriptionStatus,
} from './subscriptions.ts';

type Data = Record<string, unknown>;
type Handler = (data: Data, event: PolarWebhook) => Promise<unknown>;

/**
 * Polar event → action. Event names are Polar's (polar.sh/docs/integrate/webhooks/events).
 * Anything not listed is saved and marked "ignored". Polar has no dispute webhook: a refund it
 * makes to head off a chargeback arrives as a refund with `dispute` set (or reason
 * `dispute_prevention`), and that is treated as a chargeback.
 */
export const POLAR_EVENT_ACTIONS = {
  'order.paid':
    'Record the order. Top-up: +800 credits (90 days). First or renewal subscription order: that period’s monthly grant',
  'subscription.active': 'Set the plan → monthly grant → raise the budget; waitlist offer used',
  'subscription.updated': 'Sync status, period dates and plan changes',
  'subscription.canceled': 'Cancel at period end: the plan stays until the period is over',
  'subscription.uncanceled': 'Back to active',
  'subscription.past_due': 'Mark past due (plan kept until revoked)',
  'subscription.revoked': 'Access ends now → Free; credits keep their own 90-day expiry',
  'refund.created':
    'Succeeded refund → negative grant for the refunded share; dispute refund → take back all + flag',
  'refund.updated': 'Same as refund.created (a pending refund that has now succeeded)',
} satisfies Record<string, string>;

// --- payload helpers --------------------------------------------------------------------------

const str = (d: Data, k: string): string | undefined =>
  typeof d[k] === 'string' && d[k] ? (d[k] as string) : undefined;
const num = (d: Data, k: string): number | undefined => {
  const v = d[k];
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const date = (d: Data, k: string): Date | undefined => {
  const s = str(d, k);
  const t = s ? new Date(s) : undefined;
  return t && !Number.isNaN(t.getTime()) ? t : undefined;
};
const obj = (d: Data, k: string): Data | undefined =>
  d[k] && typeof d[k] === 'object' && !Array.isArray(d[k]) ? (d[k] as Data) : undefined;
const meta = (d: Data): Record<string, string> =>
  (obj(d, 'metadata') ?? {}) as Record<string, string>;

/** The user: Polar's customer.external_id (set from our user id at checkout), then our metadata. */
async function resolveUserId(
  d: Data,
  ids: { subscriptionId?: string | null; orderId?: string } = {},
): Promise<string | undefined> {
  for (const candidate of [str(obj(d, 'customer') ?? {}, 'external_id'), meta(d).user_id]) {
    if (candidate && (await getUser(candidate))) return candidate;
  }
  if (ids.subscriptionId) {
    const sub = await getSubscriptionByPolarId(ids.subscriptionId);
    if (sub) return sub.userId;
  }
  if (ids.orderId) return (await getPayment(ids.orderId))?.userId;
  return undefined;
}

/** Orders and subscriptions carry `product_id`. Falls back to our metadata. */
function planOf(d: Data): PlanId | undefined {
  const p = planForProduct(str(d, 'product_id')) ?? (meta(d).plan_id as PlanId | undefined);
  return p && PLAN_IDS.includes(p) && p !== 'free' ? p : undefined;
}

/** Polar's subscription state in our words. */
function statusOf(s: Data): SubscriptionStatus {
  const status = str(s, 'status');
  if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired') {
    return 'cancelled';
  }
  if (str(s, 'ended_at')) return 'cancelled';
  if (status === 'past_due') return 'past_due';
  return s.cancel_at_period_end === true ? 'cancel_at_period_end' : 'active';
}

async function getPayment(polarOrderId: string) {
  const [row] = await db().select().from(payments).where(eq(payments.polarOrderId, polarOrderId));
  return row;
}

const DAY = 24 * 3600 * 1000;

// --- handlers ---------------------------------------------------------------------------------

/**
 * A paid period starts: set the plan and grant this period's credits. Called for
 * subscription.active (with the subscription) and for order.paid on a subscription order (with
 * the order's copy of the subscription). Both use the same key, so the period is granted once.
 */
async function startPeriod(
  s: Data,
  event: PolarWebhook,
  kind: 'activated' | 'renewed',
  customer?: Data,
) {
  const subId = str(s, 'id');
  const userId = await resolveUserId(customer ? { ...s, customer } : s, { subscriptionId: subId });
  const plan = planOf(s);
  if (!subId || !userId || !plan) return unresolved(event, { subId, userId, plan });
  const existing = await getSubscriptionByPolarId(subId);
  if (existing?.endedAt) return unresolved(event, { subId, ended: true });
  const eventAt = date(event as Data, 'timestamp') ?? new Date();
  const periodStart = date(s, 'current_period_start') ?? eventAt;
  const periodEnd = date(s, 'current_period_end') ?? new Date(periodStart.getTime() + 30 * DAY);
  const now = new Date();

  let planChanged = false;
  const granted = await db().transaction(async (tx) => {
    await upsertSubscriptionInTx(tx, {
      userId,
      plan,
      polarSubscriptionId: subId,
      status: statusOf(s),
      periodStart,
      periodEnd,
    });
    planChanged = await setPlan(userId, plan, tx);
    // Every credit lasts 90 days from the grant, so unused monthly credits carry over (no
    // expiry at renewal). A late event still grants: the period was paid for.
    const { created } = await createGrantInTx(tx, {
      userId,
      source: 'monthly',
      amount: PLANS[plan].monthlyCredits,
      expiresAt: creditExpiry(now),
      ref: subId,
      idempotencyKey: `monthly:${subId}:${periodStart.toISOString()}`,
      description: `${PLANS[plan].name} monthly credits`,
    });
    if (!created) return false;
    await audit(
      {
        userId,
        actor: 'system',
        action: kind === 'activated' ? 'plan_activated' : 'plan_renewed',
        summary: `${PLANS[plan].name} plan ${kind}: +${PLANS[plan].monthlyCredits} credits`,
        details: { subscriptionId: subId, periodEnd: periodEnd.toISOString() },
      },
      tx,
    );
    return true;
  });
  await afterCreditsAdded(userId); // also applies the plan's models to the LiteLLM key
  // A new plan, not a renewal of the same one: what the plan switches on follows (HLD 11.3).
  if (planChanged) await firePlanChanged(userId);
  if (kind === 'activated') await useWaitlistOffer(s, userId);
  return { granted };
}

/** The waitlist offer (the discount on this checkout) is used once the subscription starts. */
async function useWaitlistOffer(s: Data, userId: string) {
  const entry = meta(s).waitlist_offer_entry;
  if (entry) {
    await markWaitlistOfferUsed(entry);
    return;
  }
  // Metadata missing: the waitlist discount on the subscription still identifies the offer.
  const discountId = config().POLAR_WAITLIST_DISCOUNT_ID;
  if (!discountId || str(s, 'discount_id') !== discountId) return;
  const user = await getUser(userId);
  const offer = user?.email ? await findWaitlistOffer(user.email) : null;
  if (offer) await markWaitlistOfferUsed(offer.entryId);
}

/**
 * subscription.updated / canceled / uncanceled / past_due / revoked: keep our row in step with
 * Polar's subscription. Only subscriptions we already know (created by subscription.active or
 * order.paid) are changed. Canceled for good (revoked) → Free now; credits keep their expiry.
 */
async function syncSubscription(s: Data, event: PolarWebhook) {
  const subId = str(s, 'id');
  const sub = subId ? await getSubscriptionByPolarId(subId) : undefined;
  if (!sub) {
    // Normal for subscription.updated sent alongside the first subscription.active.
    logger().debug({ type: event.type, subId }, 'polar subscription not known yet; ignored');
    return IGNORED;
  }
  if (sub.endedAt) return IGNORED;
  const status = statusOf(s);
  if (status === 'cancelled') {
    const ended = await db().transaction((tx) =>
      upsertSubscriptionInTx(tx, {
        userId: sub.userId,
        plan: sub.plan,
        polarSubscriptionId: sub.polarSubscriptionId,
        status,
        periodEnd: date(s, 'ended_at') ?? new Date(),
      }),
    );
    await endSubscription(ended);
    return { status, ended: true };
  }
  const plan = planOf(s) ?? sub.plan;
  let planChanged = false;
  await db().transaction(async (tx) => {
    await upsertSubscriptionInTx(tx, {
      userId: sub.userId,
      plan,
      polarSubscriptionId: sub.polarSubscriptionId,
      status,
      periodStart: date(s, 'current_period_start') ?? sub.periodStart,
      periodEnd: date(s, 'current_period_end') ?? sub.periodEnd,
    });
    // A plan change (Pro ↔ Max) applies now; its credits come with the next period.
    if (plan !== sub.plan) planChanged = await setPlan(sub.userId, plan, tx);
  });
  if (plan !== sub.plan) await afterCreditsAdded(sub.userId);
  if (planChanged) await firePlanChanged(sub.userId);
  return { status, plan };
}

async function orderPaid(d: Data, event: PolarWebhook) {
  const orderId = str(d, 'id');
  const subId = str(d, 'subscription_id') ?? null;
  const userId = await resolveUserId(d, { subscriptionId: subId });
  if (!orderId || !userId) return unresolved(event, { orderId, userId });
  const reason = str(d, 'billing_reason');
  const isTopUp = !subId && (isTopUpProduct(str(d, 'product_id')) || meta(d).kind === 'topup');
  const newPeriod =
    Boolean(subId) && (reason === 'subscription_create' || reason === 'subscription_cycle');
  const sub = subId ? await getSubscriptionByPolarId(subId) : undefined;
  const plan = planOf(d) ?? sub?.plan;
  const pack = TOP_UPS[0]!;
  const credits = isTopUp ? pack.credits : newPeriod && plan ? PLANS[plan].monthlyCredits : 0;

  const toppedUp = await db().transaction(async (tx) => {
    await tx
      .insert(payments)
      .values({
        id: newId('pay'),
        userId,
        polarOrderId: orderId,
        polarSubscriptionId: subId,
        kind: isTopUp ? 'topup' : 'plan',
        // Net of discounts, before tax: refunds are measured the same way.
        amountCents: num(d, 'net_amount') ?? num(d, 'total_amount') ?? 0,
        credits,
      })
      .onConflictDoNothing({ target: payments.polarOrderId });
    if (!isTopUp) return false;
    const { created } = await createGrantInTx(tx, {
      userId,
      source: 'topup',
      amount: credits,
      expiresAt: creditExpiry(),
      ref: orderId,
      idempotencyKey: `topup:${orderId}`,
      description: `Top-up: ${credits} credits`,
    });
    if (created) {
      await audit(
        {
          userId,
          actor: 'system',
          action: 'credits_purchased',
          summary: `Bought ${credits} credits`,
          details: { orderId },
        },
        tx,
      );
    }
    return created;
  });
  if (toppedUp) await afterCreditsAdded(userId);
  if (newPeriod) {
    // The order carries the subscription as it is now (the paid period's dates).
    const s = obj(d, 'subscription') ?? { id: subId, product_id: str(d, 'product_id') };
    const kind = reason === 'subscription_create' ? 'activated' : 'renewed';
    const res = await startPeriod({ ...s, id: subId }, event, kind, obj(d, 'customer'));
    return { topUp: false, period: res };
  }
  return { topUp: isTopUp, granted: toppedUp };
}

/** Negative grant for credits bought with an order; settled from that order's grants first. */
async function takeBack(
  orderId: string,
  opts: {
    credits: (p: typeof payments.$inferSelect, alreadyTaken: number) => number;
    key: string;
    description: string;
    chargeback: boolean;
  },
  event: PolarWebhook,
) {
  const payment = await getPayment(orderId);
  if (!payment) return unresolved(event, { orderId });
  const [taken] = await db()
    .select({ n: sql<string>`coalesce(-sum(${creditGrants.amount}), 0)` })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.userId, payment.userId),
        eq(creditGrants.source, 'refund'),
        eq(creditGrants.ref, orderId),
      ),
    );
  const credits = Math.max(0, opts.credits(payment, Number(taken?.n ?? 0)));
  const refs = [orderId, payment.polarSubscriptionId].filter((r): r is string => Boolean(r));
  const own = await db()
    .select({ id: creditGrants.id })
    .from(creditGrants)
    .where(and(eq(creditGrants.userId, payment.userId), inArray(creditGrants.ref, refs)));
  const created = await db().transaction(async (tx) => {
    if (credits === 0) return false;
    const res = await createGrantInTx(tx, {
      userId: payment.userId,
      source: 'refund',
      amount: -credits,
      expiresAt: null,
      ref: orderId,
      idempotencyKey: opts.key,
      description: opts.description,
      settleFirst: own.map((g) => g.id),
    });
    if (res.created) {
      await audit(
        {
          userId: payment.userId,
          actor: 'system',
          action: opts.chargeback ? 'chargeback' : 'refund',
          summary: `${opts.description}: -${credits} credits`,
          details: { orderId },
        },
        tx,
      );
    }
    return res.created;
  });
  if (opts.chargeback) await flagUser(payment.userId);
  if (created) await afterCreditsRemoved(payment.userId);
  return { credits: created ? credits : 0 };
}

/** refund.created / refund.updated: acts once the refund has succeeded (keyed on the refund id). */
async function refund(d: Data, event: PolarWebhook) {
  const refundId = str(d, 'id');
  const orderId = str(d, 'order_id');
  if (!refundId || !orderId) return unresolved(event, { refundId, orderId });
  if (str(d, 'status') !== 'succeeded') return IGNORED;
  // Polar refunds on its own to head off a chargeback (early dispute signal): treat as one.
  if (obj(d, 'dispute') || str(d, 'reason') === 'dispute_prevention') {
    return takeBack(
      orderId,
      {
        credits: (p, taken) => p.credits - taken,
        key: `chargeback:${orderId}`,
        description: 'Chargeback',
        chargeback: true,
      },
      event,
    );
  }
  const amount = num(d, 'amount');
  return takeBack(
    orderId,
    {
      // The refunded share of what the order bought (all of it when the amount is missing).
      // Polar refunds the net amount (tax goes back on top), so compare with the net we saved.
      credits: (p, taken) => {
        const share =
          amount === undefined || p.amountCents <= 0
            ? p.credits
            : Math.ceil((p.credits * Math.min(amount, p.amountCents)) / p.amountCents);
        return Math.min(share, p.credits - taken);
      },
      key: `refund:${refundId}`,
      description: 'Refund',
      chargeback: false,
    },
    event,
  );
}

function unresolved(event: PolarWebhook, details: Record<string, unknown>) {
  logger().warn({ type: event.type, ...details }, 'polar event could not be matched; ignored');
  return IGNORED;
}

/** Must cover exactly the events in POLAR_EVENT_ACTIONS (checked by the type). */
const HANDLERS: Record<keyof typeof POLAR_EVENT_ACTIONS, Handler> = {
  'order.paid': orderPaid,
  'subscription.active': (d, e) => startPeriod(d, e, 'activated'),
  'subscription.updated': syncSubscription,
  'subscription.canceled': syncSubscription,
  'subscription.uncanceled': syncSubscription,
  'subscription.past_due': syncSubscription,
  'subscription.revoked': syncSubscription,
  'refund.created': refund,
  'refund.updated': refund,
};

export async function handlePolarEvent(job: Job): Promise<unknown> {
  const event = await getEvent((job.data as { eventId: string }).eventId);
  if (!event) return null;
  const payload = event.payload as PolarWebhook;
  const handler =
    payload.type && payload.type in HANDLERS
      ? HANDLERS[payload.type as keyof typeof HANDLERS]
      : undefined;
  if (!handler) return IGNORED;
  return handler(payload.data ?? {}, payload);
}
