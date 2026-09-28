// system/dodo-event: turns a saved Dodo webhook into plan and credit changes (HLD 7.6).
// Exactly once: the event is unique on its webhook-id, and every grant has an idempotency key
// derived from Dodo's ids (payment, refund, subscription + period), so a re-run changes nothing.
import type { Job } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { IGNORED } from '../../worker/runner.ts';
import { audit } from '../admin/audit.ts';
import { flagUser, getUser, setPlan } from '../auth/users.ts';
import { getEvent } from '../events/intake.ts';
import { createGrantInTx, expireGrantsNowInTx } from './credits.ts';
import { isTopUpProduct, planForProduct, type DodoWebhook } from './dodo.ts';
import { afterCreditsAdded, afterCreditsRemoved } from './enforce.ts';
import { PLANS, TOP_UPS, PLAN_IDS, type PlanId } from './plans.ts';
import { creditGrants, payments } from './schema.ts';
import {
  endSubscription,
  getSubscriptionByDodoId,
  upsertSubscriptionInTx,
  type SubscriptionStatus,
} from './subscriptions.ts';

type Data = Record<string, unknown>;
type Handler = (data: Data, event: DodoWebhook) => Promise<unknown>;

/**
 * Dodo event → action. Event names are Dodo's (docs.dodopayments.com, "Webhook events").
 * Anything not listed is saved and marked "ignored".
 */
export const DODO_EVENT_ACTIONS: Record<string, string> = {
  'payment.succeeded': 'Record the payment; a top-up adds 800 credits per pack (12 months)',
  'subscription.active': 'Set the plan → monthly grant → raise the budget',
  'subscription.renewed': 'New monthly grant; the previous monthly grant expires',
  'subscription.plan_changed': 'Set the new plan (credits come with the next period)',
  'subscription.updated': 'Track cancel-at-period-end and the period dates',
  'subscription.on_hold': 'Mark past due (plan kept until cancelled/expired)',
  'subscription.past_due': 'Mark past due (plan kept until cancelled/expired)',
  'subscription.cancelled': 'At the end of the period → Free; monthly credits expire, top-ups stay',
  'subscription.expired': 'At the end of the period → Free; monthly credits expire, top-ups stay',
  'refund.succeeded': 'Negative grant for the refunded share of the credits bought',
  'dispute.opened': 'Chargeback: negative grant for the credits bought + flag the account',
};

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
const meta = (d: Data): Record<string, string> =>
  d.metadata && typeof d.metadata === 'object' ? (d.metadata as Record<string, string>) : {};

async function resolveUserId(d: Data): Promise<string | undefined> {
  const fromMeta = meta(d).user_id;
  if (fromMeta && (await getUser(fromMeta))) return fromMeta;
  const subId = str(d, 'subscription_id');
  if (subId) {
    const sub = await getSubscriptionByDodoId(subId);
    if (sub) return sub.userId;
  }
  const paymentId = str(d, 'payment_id');
  if (paymentId) return (await getPayment(paymentId))?.userId;
  return undefined;
}

function planOf(d: Data): PlanId | undefined {
  const p = planForProduct(str(d, 'product_id')) ?? (meta(d).plan_id as PlanId | undefined);
  return p && PLAN_IDS.includes(p) && p !== 'free' ? p : undefined;
}

async function getPayment(dodoPaymentId: string) {
  const [row] = await db().select().from(payments).where(eq(payments.dodoPaymentId, dodoPaymentId));
  return row;
}

const DAY = 24 * 3600 * 1000;

// --- handlers ---------------------------------------------------------------------------------

/** subscription.active / subscription.renewed: set the plan and grant this period's credits. */
async function startPeriod(d: Data, event: DodoWebhook, kind: 'activated' | 'renewed') {
  const subId = str(d, 'subscription_id');
  const userId = await resolveUserId(d);
  const plan = planOf(d);
  if (!subId || !userId || !plan) return unresolved(event, { subId, userId, plan });
  const eventAt = date(event as Data, 'timestamp') ?? new Date();
  const periodStart = date(d, 'previous_billing_date') ?? eventAt;
  const periodEnd = date(d, 'next_billing_date') ?? new Date(periodStart.getTime() + 30 * DAY);
  const now = new Date();
  const status: SubscriptionStatus = d.cancel_at_next_billing_date
    ? 'cancel_at_period_end'
    : 'active';

  const granted = await db().transaction(async (tx) => {
    await upsertSubscriptionInTx(tx, {
      userId,
      plan,
      dodoSubscriptionId: subId,
      status,
      periodStart,
      periodEnd,
    });
    await setPlan(userId, plan, tx);
    if (periodEnd <= now) return false; // a late event for a period that is already over
    const { grant, created } = await createGrantInTx(tx, {
      userId,
      source: 'monthly',
      amount: PLANS[plan].monthlyCredits,
      expiresAt: periodEnd,
      ref: subId,
      idempotencyKey: `monthly:${subId}:${periodStart.toISOString()}`,
      description: `${PLANS[plan].name} monthly credits`,
    });
    if (!created) return false;
    // No roll-over: the previous period's monthly credits end now.
    await expireGrantsNowInTx(tx, userId, {
      source: 'monthly',
      exceptId: grant.id,
      olderThan: periodEnd,
      description: 'Monthly credits replaced by the new period',
    });
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
  return { granted };
}

async function planChanged(d: Data, event: DodoWebhook) {
  const subId = str(d, 'subscription_id');
  const userId = await resolveUserId(d);
  const plan = planOf(d);
  if (!subId || !userId || !plan) return unresolved(event, { subId, userId, plan });
  await db().transaction(async (tx) => {
    await upsertSubscriptionInTx(tx, {
      userId,
      plan,
      dodoSubscriptionId: subId,
      status: d.cancel_at_next_billing_date ? 'cancel_at_period_end' : 'active',
      periodStart: date(d, 'previous_billing_date') ?? null,
      periodEnd: date(d, 'next_billing_date') ?? null,
    });
    await setPlan(userId, plan, tx);
  });
  await afterCreditsAdded(userId);
  return { plan };
}

async function updated(d: Data, event: DodoWebhook) {
  const subId = str(d, 'subscription_id');
  const sub = subId ? await getSubscriptionByDodoId(subId) : undefined;
  if (!sub) return unresolved(event, { subId });
  if (str(d, 'status') !== 'active' || sub.endedAt) return IGNORED;
  await db().transaction((tx) =>
    upsertSubscriptionInTx(tx, {
      userId: sub.userId,
      plan: sub.plan,
      dodoSubscriptionId: sub.dodoSubscriptionId,
      status: d.cancel_at_next_billing_date ? 'cancel_at_period_end' : 'active',
      periodStart: date(d, 'previous_billing_date') ?? sub.periodStart,
      periodEnd: date(d, 'next_billing_date') ?? sub.periodEnd,
    }),
  );
  return null;
}

async function pastDue(d: Data, event: DodoWebhook) {
  const subId = str(d, 'subscription_id');
  const sub = subId ? await getSubscriptionByDodoId(subId) : undefined;
  if (!sub) return unresolved(event, { subId });
  if (sub.endedAt || sub.status === 'cancelled') return IGNORED;
  await db().transaction((tx) =>
    upsertSubscriptionInTx(tx, {
      userId: sub.userId,
      plan: sub.plan,
      dodoSubscriptionId: sub.dodoSubscriptionId,
      status: 'past_due',
    }),
  );
  return null;
}

/** subscription.cancelled / expired: Free once the paid period is over (maybe right now). */
async function ended(d: Data, event: DodoWebhook) {
  const subId = str(d, 'subscription_id');
  const userId = await resolveUserId(d);
  const existing = subId ? await getSubscriptionByDodoId(subId) : undefined;
  if (!subId || !userId) return unresolved(event, { subId, userId });
  const plan = existing?.plan ?? planOf(d);
  if (!plan) return unresolved(event, { subId, plan });
  const periodEnd = existing?.periodEnd ?? date(d, 'next_billing_date') ?? new Date();
  const sub = await db().transaction((tx) =>
    upsertSubscriptionInTx(tx, {
      userId,
      plan,
      dodoSubscriptionId: subId,
      status: 'cancelled',
      periodEnd,
    }),
  );
  // Otherwise the hourly expire-credits job ends it when the period is over.
  if (periodEnd <= new Date()) await endSubscription(sub);
  return null;
}

async function paymentSucceeded(d: Data, event: DodoWebhook) {
  const paymentId = str(d, 'payment_id');
  const userId = await resolveUserId(d);
  if (!paymentId || !userId) return unresolved(event, { paymentId, userId });
  const subId = str(d, 'subscription_id') ?? null;
  const cart = Array.isArray(d.product_cart) ? (d.product_cart as Data[]) : [];
  const packs = cart
    .filter((p) => isTopUpProduct(str(p, 'product_id')))
    .reduce((n, p) => n + (num(p, 'quantity') ?? 1), 0);
  const isTopUp = !subId && (packs > 0 || meta(d).kind === 'topup');
  const pack = TOP_UPS[0]!;
  const sub = subId ? await getSubscriptionByDodoId(subId) : undefined;
  const plan = sub?.plan ?? planOf(d);
  const credits = isTopUp
    ? pack.credits * Math.max(packs, 1)
    : plan
      ? PLANS[plan].monthlyCredits
      : 0;

  const granted = await db().transaction(async (tx) => {
    await tx
      .insert(payments)
      .values({
        id: newId('pay'),
        userId,
        dodoPaymentId: paymentId,
        dodoSubscriptionId: subId,
        kind: isTopUp ? 'topup' : 'plan',
        amountCents: num(d, 'total_amount') ?? 0,
        credits,
      })
      .onConflictDoNothing({ target: payments.dodoPaymentId });
    if (!isTopUp) return false;
    const { created } = await createGrantInTx(tx, {
      userId,
      source: 'topup',
      amount: credits,
      expiresAt: new Date(Date.now() + pack.expiresInDays * DAY),
      ref: paymentId,
      idempotencyKey: `topup:${paymentId}`,
      description: `Top-up: ${credits} credits`,
    });
    if (created) {
      await audit(
        {
          userId,
          actor: 'system',
          action: 'credits_purchased',
          summary: `Bought ${credits} credits`,
          details: { paymentId },
        },
        tx,
      );
    }
    return created;
  });
  if (granted) await afterCreditsAdded(userId);
  return { topUp: isTopUp, granted };
}

/** Negative grant for credits bought with a payment; settled from that payment's grants first. */
async function takeBack(
  paymentId: string,
  opts: {
    credits: (p: typeof payments.$inferSelect, alreadyTaken: number) => number;
    key: string;
    description: string;
    chargeback: boolean;
  },
  event: DodoWebhook,
) {
  const payment = await getPayment(paymentId);
  if (!payment) return unresolved(event, { paymentId });
  const [taken] = await db()
    .select({ n: sql<string>`coalesce(-sum(${creditGrants.amount}), 0)` })
    .from(creditGrants)
    .where(
      and(
        eq(creditGrants.userId, payment.userId),
        eq(creditGrants.source, 'refund'),
        eq(creditGrants.ref, paymentId),
      ),
    );
  const credits = Math.max(0, opts.credits(payment, Number(taken?.n ?? 0)));
  const refs = [paymentId, payment.dodoSubscriptionId].filter((r): r is string => Boolean(r));
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
      ref: paymentId,
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
          details: { paymentId },
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

async function refund(d: Data, event: DodoWebhook) {
  const refundId = str(d, 'refund_id');
  const paymentId = str(d, 'payment_id');
  if (!refundId || !paymentId) return unresolved(event, { refundId, paymentId });
  const amount = num(d, 'amount');
  return takeBack(
    paymentId,
    {
      // The refunded share of what the payment bought (all of it when the amount is missing).
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

async function chargeback(d: Data, event: DodoWebhook) {
  const paymentId = str(d, 'payment_id');
  if (!paymentId) return unresolved(event, { paymentId });
  return takeBack(
    paymentId,
    {
      credits: (p, taken) => p.credits - taken,
      key: `chargeback:${paymentId}`,
      description: 'Chargeback',
      chargeback: true,
    },
    event,
  );
}

function unresolved(event: DodoWebhook, details: Record<string, unknown>) {
  logger().warn({ type: event.type, ...details }, 'dodo event could not be matched; ignored');
  return IGNORED;
}

const HANDLERS: Record<string, Handler> = {
  'payment.succeeded': paymentSucceeded,
  'subscription.active': (d, e) => startPeriod(d, e, 'activated'),
  'subscription.renewed': (d, e) => startPeriod(d, e, 'renewed'),
  'subscription.plan_changed': planChanged,
  'subscription.updated': updated,
  'subscription.on_hold': pastDue,
  'subscription.past_due': pastDue,
  'subscription.cancelled': ended,
  'subscription.expired': ended,
  'refund.succeeded': refund,
  'dispute.opened': chargeback,
};

export async function handleDodoEvent(job: Job): Promise<unknown> {
  const event = await getEvent((job.data as { eventId: string }).eventId);
  if (!event) return null;
  const payload = event.payload as DodoWebhook;
  const handler = payload.type ? HANDLERS[payload.type] : undefined;
  if (!handler) return IGNORED;
  return handler(payload.data ?? {}, payload);
}
