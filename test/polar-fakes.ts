// Polar fakes for Phase 5 tests: a fake API client and Standard Webhooks signing.
import { randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import {
  PolarHttpError,
  setPolarClient,
  type FinalizeOutcome,
  type PolarClient,
  type SavedCard,
} from '../src/modules/billing/polar.ts';
import { POLAR_SECRET } from './billing-fakes.ts';

// --- Polar ------------------------------------------------------------------------------------

export class FakePolar implements PolarClient {
  checkouts: Array<Parameters<PolarClient['createCheckout']>[0]> = [];
  cancelled: string[] = [];
  uncancelled: string[] = [];
  /** When set, the next uncancel fails as if Polar did not answer. */
  failUncancel = false;
  async createCheckout(input: Parameters<PolarClient['createCheckout']>[0]) {
    this.checkouts.push(input);
    const checkoutId = randomUUID();
    return {
      checkoutId,
      checkoutUrl: `https://sandbox.polar.sh/checkout/polar_c_${checkoutId.replace(/-/g, '')}`,
    };
  }
  /** Users (external ids) Polar has a customer for; the portal link is refused for others. */
  customers = new Set<string>();
  portals: Array<{ externalCustomerId: string; returnUrl: string }> = [];
  /** When set, the next portal call fails as if Polar did not answer. */
  failPortal = false;
  async customerPortalUrl(externalCustomerId: string, returnUrl: string) {
    if (this.failPortal) {
      this.failPortal = false;
      throw new Error('Polar POST /v1/customer-sessions/ failed: 503');
    }
    this.portals.push({ externalCustomerId, returnUrl });
    if (!this.customers.has(externalCustomerId)) return null;
    return `https://sandbox.polar.sh/text-crew/portal?customer_session_token=polar_cst_${randomUUID()}`;
  }
  async cancelAtPeriodEnd(subscriptionId: string) {
    this.cancelled.push(subscriptionId);
  }
  async uncancel(subscriptionId: string) {
    if (this.failUncancel) {
      this.failUncancel = false;
      throw new Error('Polar PATCH /v1/subscriptions failed: 503');
    }
    this.uncancelled.push(subscriptionId);
  }

  // --- off-session charges (auto top-up) ---
  /** The saved card per user (external id). Missing → a default Visa; null → none. */
  cards = new Map<string, SavedCard | null>();
  /** Draft orders made, with their status as Polar would keep it. */
  orders = new Map<
    string,
    { customerId: string; productId: string; metadata: Record<string, string>; status: string }
  >();
  /** Finalize calls, in order (an order id each). */
  finalized: string[] = [];
  /** What the next finalize calls answer (default: paid). 'crash' charges, then throws. */
  finalizeScript: Array<FinalizeOutcome['outcome'] | 'crash' | 'timeout'> = [];
  /** When set, creating a draft order is refused with this status. */
  refuseDraft: number | null = null;

  async savedCard(externalCustomerId: string): Promise<SavedCard | null> {
    if (this.cards.has(externalCustomerId)) return this.cards.get(externalCustomerId) ?? null;
    return {
      customerId: `cus_${externalCustomerId}`,
      paymentMethodId: `pm_${externalCustomerId}`,
      brand: 'visa',
      last4: '4242',
    };
  }
  async createDraftOrder(input: Parameters<PolarClient['createDraftOrder']>[0]) {
    if (this.refuseDraft)
      throw new PolarHttpError(
        this.refuseDraft,
        'Customer has no billing address',
        'POST /v1/orders/',
      );
    const orderId = randomUUID();
    this.orders.set(orderId, { ...input, status: 'draft' });
    return { orderId };
  }
  async finalizeOrder(orderId: string): Promise<FinalizeOutcome> {
    this.finalized.push(orderId);
    const order = this.orders.get(orderId);
    if (!order) throw new PolarHttpError(404, 'Order not found', 'finalize');
    if (order.status !== 'draft') return { outcome: 'not_draft' };
    const next = this.finalizeScript.shift() ?? 'paid';
    if (next === 'timeout') throw new Error('The operation was aborted due to timeout');
    if (next === 'crash') {
      order.status = 'paid'; // charged at Polar, but the answer never came back
      throw new Error('socket hang up');
    }
    if (next === 'paid') order.status = 'paid';
    if (next === 'declined') return { outcome: 'declined', reason: 'Your card was declined.' };
    if (next === 'refused')
      return { outcome: 'refused', reason: 'Off-session charges are not enabled' };
    return next === 'not_draft' ? { outcome: 'not_draft' } : { outcome: 'paid' };
  }
  async orderStatus(orderId: string) {
    return this.orders.get(orderId)?.status ?? 'unknown';
  }
  /** Card charges that went through (orders paid). */
  get paidOrders() {
    return [...this.orders.entries()].filter(([, o]) => o.status === 'paid').map(([id]) => id);
  }
}

/** Signs like Polar: Standard Webhooks with the endpoint's `whsec_…` secret. */
export function signPolar(payload: unknown, msgId = `msg_${randomUUID()}`, secret = POLAR_SECRET) {
  const body = JSON.stringify(payload);
  const ts = new Date();
  return {
    body,
    headers: {
      'webhook-id': msgId,
      'webhook-timestamp': String(Math.floor(ts.getTime() / 1000)),
      'webhook-signature': new Webhook(secret).sign(msgId, ts, body),
      'content-type': 'application/json',
    },
  };
}

/** Signs like Polar did before 2026-09-08 (key = the UTF-8 bytes of the whole secret). */
export function signPolarLegacy(payload: unknown, msgId = `msg_${randomUUID()}`) {
  const body = JSON.stringify(payload);
  const ts = new Date();
  return {
    body,
    headers: {
      'webhook-id': msgId,
      'webhook-timestamp': String(Math.floor(ts.getTime() / 1000)),
      'webhook-signature': new Webhook(POLAR_SECRET, { format: 'raw' }).sign(msgId, ts, body),
      'content-type': 'application/json',
    },
  };
}

export function installPolar(): FakePolar {
  const fake = new FakePolar();
  setPolarClient(fake);
  return fake;
}

// --- payloads (shapes from Polar's 2026-10 webhook schemas) -------------------------------------

export const PRODUCTS = {
  pro: '5b8c4f3e-1111-4c5a-9d7e-0a1b2c3d4e01',
  max: '5b8c4f3e-2222-4c5a-9d7e-0a1b2c3d4e02',
  topup10: '5b8c4f3e-3333-4c5a-9d7e-0a1b2c3d4e03',
};

const customer = (userId: string) => ({
  id: randomUUID(),
  external_id: userId,
  email: 'a@example.com',
  email_verified: false,
  type: 'individual',
  name: 'A',
  metadata: {},
});

export interface SubOpts {
  userId: string;
  subId: string;
  product?: string;
  start: Date;
  end: Date;
  status?: string;
  cancelAtPeriodEnd?: boolean;
  endedAt?: Date;
  metadata?: Record<string, string>;
  discountId?: string | null;
}

/** A Polar Subscription object. */
export function subscriptionData(o: SubOpts) {
  return {
    id: o.subId,
    created_at: o.start.toISOString(),
    modified_at: new Date().toISOString(),
    amount: 1900,
    currency: 'usd',
    recurring_interval: 'month',
    recurring_interval_count: 1,
    status: o.status ?? 'active',
    current_period_start: o.start.toISOString(),
    current_period_end: o.end.toISOString(),
    cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
    canceled_at: o.cancelAtPeriodEnd ? new Date().toISOString() : null,
    started_at: o.start.toISOString(),
    ends_at: o.cancelAtPeriodEnd ? o.end.toISOString() : null,
    ended_at: o.endedAt?.toISOString() ?? null,
    customer_id: randomUUID(),
    product_id: o.product ?? PRODUCTS.pro,
    discount_id: o.discountId ?? null,
    checkout_id: randomUUID(),
    metadata: o.metadata ?? { user_id: o.userId, kind: 'plan', plan_id: 'pro' },
    customer: customer(o.userId),
  };
}

export function subscriptionEvent(type: string, o: SubOpts) {
  return {
    type,
    timestamp: new Date().toISOString(),
    api_version: '2026-10',
    data: subscriptionData(o),
  };
}

/** order.paid. A subscription order carries the subscription as it is at that moment. */
export function orderPaid(
  o: {
    userId: string;
    orderId: string;
    product: string;
    netAmount: number;
    billingReason?: string;
    metadata?: Record<string, string>;
  },
  sub?: SubOpts,
) {
  const subscription = sub ? subscriptionData(sub) : null;
  return {
    type: 'order.paid',
    timestamp: new Date().toISOString(),
    api_version: '2026-10',
    data: {
      id: o.orderId,
      created_at: new Date().toISOString(),
      status: 'paid',
      paid: true,
      subtotal_amount: o.netAmount,
      discount_amount: 0,
      net_amount: o.netAmount,
      tax_amount: Math.round(o.netAmount * 0.2),
      total_amount: o.netAmount + Math.round(o.netAmount * 0.2),
      refunded_amount: 0,
      currency: 'usd',
      billing_reason: o.billingReason ?? (sub ? 'subscription_create' : 'purchase'),
      customer_id: randomUUID(),
      product_id: o.product,
      discount_id: null,
      subscription_id: sub?.subId ?? null,
      checkout_id: randomUUID(),
      metadata: o.metadata ?? {},
      customer: customer(o.userId),
      subscription: subscription && { ...subscription, customer: undefined },
      items: [],
    },
  };
}

export function topUpOrder(userId: string, orderId: string) {
  return orderPaid({
    userId,
    orderId,
    product: PRODUCTS.topup10,
    netAmount: 1000,
    metadata: { user_id: userId, kind: 'topup', top_up_id: 'topup_10' },
  });
}

/** refund.created / refund.updated with a Polar Refund object. */
export function refundEvent(
  o: {
    refundId?: string;
    orderId: string;
    amount: number;
    status?: string;
    reason?: string;
    dispute?: Record<string, unknown> | null;
  },
  type = 'refund.created',
) {
  return {
    type,
    timestamp: new Date().toISOString(),
    api_version: '2026-10',
    data: {
      id: o.refundId ?? randomUUID(),
      created_at: new Date().toISOString(),
      metadata: {},
      status: o.status ?? 'succeeded',
      reason: o.reason ?? 'customer_request',
      amount: o.amount,
      tax_amount: Math.round(o.amount * 0.2),
      currency: 'usd',
      organization_id: randomUUID(),
      order_id: o.orderId,
      subscription_id: null,
      customer_id: randomUUID(),
      revoke_benefits: false,
      dispute: o.dispute ?? null,
    },
  };
}
