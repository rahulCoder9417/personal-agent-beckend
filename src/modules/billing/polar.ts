// Polar (HLD 7.6): hosted checkout, cancel at period end, and webhook verification.
// Plain HTTP against the Core API (pinned with the Polar-Version header), so the client is two
// small calls and easy to fake in tests. Webhooks follow the Standard Webhooks spec (headers
// webhook-id / -timestamp / -signature, signed over the raw body with POLAR_WEBHOOK_SECRET).
import { Webhook } from 'standardwebhooks';
import { config } from '../../shared/config.ts';
import { badRequest, conflict, planLimit, unavailable } from '../../shared/errors.ts';
import { audit } from '../admin/audit.ts';
import { webhookUnauthorized } from '../auth/webhooks.ts';
import type { User } from '../auth/users.ts';
import { findWaitlistOffer } from '../auth/waitlist.ts';
import { getTopUp, PLANS, planLimits, type PlanId } from './plans.ts';
import {
  getCurrentSubscription,
  getEndingSubscription,
  getRenewingSubscription,
  setSubscriptionStatus,
  type Subscription,
} from './subscriptions.ts';

/** The API version we are written against (requests here; set the same on the webhook endpoint). */
export const POLAR_API_VERSION = '2026-10';

const POLAR_API_URLS = {
  sandbox: 'https://sandbox-api.polar.sh',
  production: 'https://api.polar.sh',
} as const;

export interface PolarClient {
  /** POST /v1/checkouts/ → a hosted checkout URL. */
  createCheckout(input: {
    productId: string;
    /** Our user id. Polar links the order to (or creates) the customer with this external id. */
    externalCustomerId: string;
    customerEmail?: string;
    customerName?: string;
    successUrl: string;
    /** Polar's checkout shows a back link to this page. */
    returnUrl?: string;
    metadata: Record<string, string>;
    /** A Polar discount applied to this checkout (the waitlist offer). */
    discountId?: string;
  }): Promise<{ checkoutUrl: string; checkoutId: string }>;
  /**
   * POST /v1/customer-sessions/ { external_customer_id, return_url }: a signed-in link to Polar's
   * customer portal. Null when Polar has no customer for this user yet (nothing bought).
   */
  customerPortalUrl(externalCustomerId: string, returnUrl: string): Promise<string | null>;
  /** PATCH /v1/subscriptions/{id} { cancel_at_period_end: true } */
  cancelAtPeriodEnd(subscriptionId: string): Promise<void>;
  /** PATCH /v1/subscriptions/{id} { cancel_at_period_end: false }: un-cancel before it ends. */
  uncancel(subscriptionId: string): Promise<void>;
  /**
   * GET /v1/customers/external/{external_id}/payment-methods: the customer's default saved card
   * (or the first one). Null when Polar has no customer or no saved method for this user.
   */
  savedCard(externalCustomerId: string): Promise<SavedCard | null>;
  /** POST /v1/orders/: a draft order for an off-session charge (nothing is charged yet). */
  createDraftOrder(input: {
    customerId: string;
    productId: string;
    metadata: Record<string, string>;
  }): Promise<{ orderId: string }>;
  /** POST /v1/orders/{id}/finalize: charges the saved card now, off-session. */
  finalizeOrder(orderId: string, paymentMethodId?: string): Promise<FinalizeOutcome>;
  /** GET /v1/orders/{id}: the order's status (draft, pending, paid, refunded, …). */
  orderStatus(orderId: string): Promise<string>;
}

export interface SavedCard {
  customerId: string;
  paymentMethodId: string;
  brand: string;
  last4: string;
}

/**
 * What finalizing a draft order gave. `paid`: charged (order.paid follows). `declined`: 402, the
 * card was declined, there is no method, or it needs 3-D Secure, which cannot happen off-session.
 * `refused`: 403 (off-session charges not switched on for us) or another refusal. `not_draft`: 412,
 * the order was finalized before (a re-run).
 */
export type FinalizeOutcome =
  | { outcome: 'paid' }
  | { outcome: 'declined'; reason: string }
  | { outcome: 'refused'; reason: string }
  | { outcome: 'not_draft' };

/** A Polar answer that is not 2xx. `reason` is Polar's short message (never card data). */
export class PolarHttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    what: string,
  ) {
    super(`Polar ${what} failed: ${status}`);
  }
  /** Polar's own refusal (4xx other than rate limiting): trying again won't change it. */
  get refusal(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

/** Polar's error body: `{ detail: "…" }` or `{ error, detail }`. Kept short. */
function reasonOf(text: string): string {
  try {
    const body = JSON.parse(text) as { detail?: unknown; error?: unknown };
    const d = typeof body.detail === 'string' ? body.detail : body.error;
    if (typeof d === 'string' && d) return d.slice(0, 200);
  } catch {
    // not JSON
  }
  return '';
}

/** One call to Polar's Core API on the server POLAR_SERVER names, pinned to POLAR_API_VERSION. */
export async function polarRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const c = config();
  if (!c.POLAR_ACCESS_TOKEN) throw new Error('POLAR_ACCESS_TOKEN is not set');
  const res = await fetch(new URL(path, POLAR_API_URLS[c.POLAR_SERVER]), {
    method,
    headers: {
      authorization: `Bearer ${c.POLAR_ACCESS_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json',
      'polar-version': POLAR_API_VERSION,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    // Finalizing an order charges the card while we wait: give it longer.
    signal: AbortSignal.timeout(path.endsWith('/finalize') ? 60_000 : 15_000),
  });
  const text = await res.text();
  if (!res.ok) throw new PolarHttpError(res.status, reasonOf(text), `${method} ${path}`);
  return (text ? JSON.parse(text) : {}) as T;
}

class HttpPolar implements PolarClient {
  private request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return polarRequest<T>(method, path, body);
  }

  async createCheckout(input: Parameters<PolarClient['createCheckout']>[0]) {
    const out = await this.request<{ id: string; url: string }>('POST', '/v1/checkouts/', {
      products: [input.productId],
      external_customer_id: input.externalCustomerId,
      ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
      ...(input.customerName ? { customer_name: input.customerName } : {}),
      success_url: input.successUrl,
      ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
      metadata: input.metadata,
      // No free trials: a trial set on a product in Polar's dashboard must not start a paid plan
      // (and its monthly credits) without a payment. Our plans have none (HLD section 7).
      allow_trial: false,
      // Only the discount we attach (the waitlist offer); no codes typed in at checkout.
      allow_discount_codes: false,
      ...(input.discountId ? { discount_id: input.discountId } : {}),
    });
    return { checkoutUrl: out.url, checkoutId: out.id };
  }

  async customerPortalUrl(externalCustomerId: string, returnUrl: string) {
    try {
      const out = await this.request<{ customer_portal_url: string }>(
        'POST',
        '/v1/customer-sessions/',
        { external_customer_id: externalCustomerId, return_url: returnUrl },
      );
      return out.customer_portal_url;
    } catch (err) {
      // No customer with this external id: Polar answers 404 (or 422 on some versions).
      if (err instanceof PolarHttpError && (err.status === 404 || err.status === 422)) return null;
      throw err;
    }
  }

  async cancelAtPeriodEnd(subscriptionId: string) {
    await this.request('PATCH', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      cancel_at_period_end: true,
    });
  }

  async uncancel(subscriptionId: string) {
    await this.request('PATCH', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      cancel_at_period_end: false,
    });
  }

  async savedCard(externalCustomerId: string): Promise<SavedCard | null> {
    type Method = {
      id: string;
      type: string;
      customer_id: string;
      is_default?: boolean;
      method_metadata?: { brand?: string | null; last4?: string | null };
    };
    let out: { items?: Method[] };
    try {
      out = await this.request<{ items?: Method[] }>(
        'GET',
        `/v1/customers/external/${encodeURIComponent(externalCustomerId)}/payment-methods?limit=100`,
      );
    } catch (err) {
      if (err instanceof PolarHttpError && err.status === 404) return null; // no customer yet
      throw err;
    }
    const items = out.items ?? [];
    const pick = items.find((m) => m.is_default) ?? items[0];
    if (!pick) return null;
    return {
      customerId: pick.customer_id,
      paymentMethodId: pick.id,
      brand: pick.method_metadata?.brand ?? pick.type,
      last4: pick.method_metadata?.last4 ?? '',
    };
  }

  async createDraftOrder(input: Parameters<PolarClient['createDraftOrder']>[0]) {
    const out = await this.request<{ id: string }>('POST', '/v1/orders/', {
      customer_id: input.customerId,
      product_id: input.productId,
      metadata: input.metadata,
    });
    return { orderId: out.id };
  }

  async finalizeOrder(orderId: string, paymentMethodId?: string): Promise<FinalizeOutcome> {
    try {
      await this.request('POST', `/v1/orders/${encodeURIComponent(orderId)}/finalize`, {
        ...(paymentMethodId ? { payment_method_id: paymentMethodId } : {}),
      });
      return { outcome: 'paid' };
    } catch (err) {
      if (!(err instanceof PolarHttpError) || !err.refusal) throw err; // retried by the job
      if (err.status === 412) return { outcome: 'not_draft' };
      if (err.status === 402) return { outcome: 'declined', reason: err.reason || 'declined' };
      return { outcome: 'refused', reason: err.reason || `refused (${err.status})` };
    }
  }

  async orderStatus(orderId: string): Promise<string> {
    const out = await this.request<{ status?: string }>(
      'GET',
      `/v1/orders/${encodeURIComponent(orderId)}`,
    );
    return out.status ?? 'unknown';
  }
}

let client: PolarClient | undefined;

export function polar(): PolarClient {
  client ??= new HttpPolar();
  return client;
}

/** Tests: swap in a fake Polar. */
export function setPolarClient(fake: PolarClient | undefined): void {
  client = fake;
}

// --- products ---------------------------------------------------------------------------------

export function productFor(kind: 'plan' | 'topup', id: string): string {
  const c = config();
  const map: Record<string, string | undefined> = {
    'plan:pro': c.POLAR_PRODUCT_PRO,
    'plan:max': c.POLAR_PRODUCT_MAX,
    'topup:topup_10': c.POLAR_PRODUCT_TOPUP_10,
  };
  const product = map[`${kind}:${id}`];
  if (!product) throw new Error(`Polar product for ${kind} ${id} is not configured`);
  return product;
}

/** Which plan a Polar product id is (undefined for top-ups / unknown products). */
export function planForProduct(productId: string | undefined): PlanId | undefined {
  const c = config();
  if (!productId) return undefined;
  if (productId === c.POLAR_PRODUCT_PRO) return 'pro';
  if (productId === c.POLAR_PRODUCT_MAX) return 'max';
  return undefined;
}

export function isTopUpProduct(productId: string | undefined): boolean {
  return Boolean(productId) && productId === config().POLAR_PRODUCT_TOPUP_10;
}

// --- checkout ---------------------------------------------------------------------------------

export type CheckoutRequest = { kind: 'plan'; planId: PlanId } | { kind: 'topup'; topUpId: string };

/**
 * The plan or credits change only when Polar's webhook arrives, never from this call.
 * Waitlist members get 50% off their first month of Pro or Max (once, verified email only).
 */
export async function startCheckout(
  user: User,
  req: CheckoutRequest,
): Promise<{ checkoutUrl: string; discountApplied: boolean }> {
  if (!polarConfigured()) throw unavailable('Payments are not set up yet');
  // Polar fills in {CHECKOUT_ID}; the web app's billing page waits for the webhook either way.
  const successUrl = `${config().WEB_APP_URL}/billing?checkout=done&checkout_id={CHECKOUT_ID}`;
  let productId: string;
  let metadata: Record<string, string>;
  let discountId: string | undefined;
  if (req.kind === 'plan') {
    if (req.planId === 'free') throw badRequest('The Free plan needs no checkout');
    const renewing = await getRenewingSubscription(user.id);
    if (renewing) {
      throw badRequest(
        renewing.plan === req.planId
          ? 'You are already on this plan'
          : 'Cancel your current plan first; the new one can start when it ends',
      );
    }
    // The same plan, cancelled but still running: paying again would start a second paid month
    // beside it. "Keep my plan" (resumeSubscription) undoes the cancel instead.
    const ending = await getEndingSubscription(user.id);
    if (ending?.plan === req.planId) {
      throw badRequest('Your plan is still running until the end of this period. Keep it instead');
    }
    productId = productFor('plan', req.planId);
    metadata = { user_id: user.id, kind: 'plan', plan_id: req.planId };
    const discount = config().POLAR_WAITLIST_DISCOUNT_ID;
    const offer =
      discount && user.emailVerified && user.email ? await findWaitlistOffer(user.email) : null;
    if (discount && offer) {
      discountId = discount;
      metadata.waitlist_offer_entry = offer.entryId;
    }
  } else {
    const pack = getTopUp(req.topUpId);
    if (!pack) throw badRequest('Unknown top-up pack', { topUpId: req.topUpId });
    if (!planLimits(user.plan).topUps) {
      throw planLimit('Top-ups are for paid plans. Upgrade, or redeem a coupon code.');
    }
    productId = productFor('topup', pack.id);
    metadata = { user_id: user.id, kind: 'topup', top_up_id: pack.id };
  }
  const { checkoutUrl } = await polar().createCheckout({
    productId,
    externalCustomerId: user.id,
    ...(user.email ? { customerEmail: user.email } : {}),
    ...(user.name ? { customerName: user.name } : {}),
    successUrl,
    returnUrl: `${config().WEB_APP_URL}/pricing`,
    metadata,
    ...(discountId ? { discountId } : {}),
  });
  return { checkoutUrl, discountApplied: Boolean(discountId) };
}

/** True when this server can talk to Polar (a token is set). Product ids are checked per checkout. */
export function polarConfigured(): boolean {
  return Boolean(config().POLAR_ACCESS_TOKEN);
}

/**
 * "Manage billing": a signed-in link to Polar's customer portal (card, invoices, receipts), with a
 * back link to the web app's billing page. Polar finds the customer by our user id, the external
 * id every checkout sets. Changes made there reach us only through Polar's webhooks.
 */
export async function openBillingPortal(user: User): Promise<{ portalUrl: string }> {
  if (!polarConfigured()) throw unavailable('Payments are not set up yet');
  let url: string | null;
  try {
    url = await polar().customerPortalUrl(user.id, `${config().WEB_APP_URL}/billing`);
  } catch (err) {
    if (err instanceof PolarHttpError && err.refusal)
      throw unavailable('Polar refused the request');
    throw unavailable('Polar could not be reached. Try again in a minute');
  }
  if (!url) throw conflict('Nothing bought yet, so there is no billing account to manage');
  return { portalUrl: url };
}

/** Cancel at the end of the current period (the plan stays until then). */
export async function cancelSubscription(userId: string): Promise<Subscription> {
  const current = await getCurrentSubscription(userId);
  if (current?.status === 'cancel_at_period_end') return current;
  const renewing = await getRenewingSubscription(userId);
  if (!renewing) throw conflict('No active paid subscription');
  await polar().cancelAtPeriodEnd(renewing.polarSubscriptionId);
  const updated = (await setSubscriptionStatus(renewing.id, 'cancel_at_period_end'))!;
  await audit({
    userId,
    actor: 'user',
    action: 'plan_cancelled',
    summary: `${PLANS[updated.plan].name} plan cancelled: stays until ${shortDay(updated.periodEnd)}`,
    details: auditDetails(updated),
  });
  return updated;
}

/** "18 Nov" (UTC), or "the end of the period" when we do not know the date. */
export function shortDay(d: Date | null | undefined): string {
  return d
    ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : 'the end of the period';
}

/** The subscription id and period end that every plan audit line carries. */
export function auditDetails(sub: {
  polarSubscriptionId: string;
  periodEnd: Date | null;
}): Record<string, unknown> {
  return {
    subscriptionId: sub.polarSubscriptionId,
    periodEnd: sub.periodEnd ? sub.periodEnd.toISOString() : null,
  };
}

/**
 * "Keep my plan": undo a cancel before the period ends. Polar is asked to renew the subscription
 * again; nothing is charged now and no credits are given. Our row says "active" at once (as
 * cancel says "cancelled" at once); Polar's subscription.uncanceled / .updated then sync it.
 */
export async function resumeSubscription(userId: string): Promise<Subscription> {
  if (await getRenewingSubscription(userId)) throw conflict('Your plan already renews');
  const ending = await getEndingSubscription(userId);
  if (!ending) throw conflict('No cancelled plan to keep');
  await polar().uncancel(ending.polarSubscriptionId);
  const updated = (await setSubscriptionStatus(ending.id, 'active'))!;
  await audit({
    userId,
    actor: 'user',
    action: 'plan_resumed',
    summary: `${PLANS[updated.plan].name} plan kept: renews again`,
    details: auditDetails(updated),
  });
  return updated;
}

// --- webhook ----------------------------------------------------------------------------------

export interface PolarWebhook {
  type?: string;
  timestamp?: string;
  api_version?: string;
  data?: Record<string, unknown>;
}

/**
 * The two ways Polar signs with a `whsec_…` secret. Secrets made on or after 2026-09-08 are
 * Standard Webhooks: the part after `whsec_` is base64 key bytes. Older ones are "Polar HMAC":
 * the key is the UTF-8 bytes of the whole `whsec_…` string (the `raw` format). Polar's own SDK
 * tries both, and so do we; either way only the holder of the secret can sign.
 */
function verifiers(secret: string): Webhook[] {
  const out: Webhook[] = [];
  try {
    out.push(new Webhook(secret));
  } catch {
    // Not base64 after the prefix: can only be a legacy secret.
  }
  out.push(new Webhook(secret, { format: 'raw' }));
  return out;
}

/** Verifies the Standard Webhooks signature on the raw body, then parses it. */
export function verifyPolarWebhook(
  rawBody: string,
  headers: Record<string, string | undefined>,
): PolarWebhook {
  const secret = config().POLAR_WEBHOOK_SECRET;
  if (!secret) throw webhookUnauthorized();
  const h = {
    'webhook-id': headers['webhook-id'] ?? '',
    'webhook-timestamp': headers['webhook-timestamp'] ?? '',
    'webhook-signature': headers['webhook-signature'] ?? '',
  };
  for (const wh of verifiers(secret)) {
    try {
      wh.verify(rawBody, h);
      return JSON.parse(rawBody) as PolarWebhook;
    } catch {
      // try the next scheme
    }
  }
  throw webhookUnauthorized();
}
