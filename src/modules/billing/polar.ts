// Polar (HLD 7.6): hosted checkout, cancel at period end, and webhook verification.
// Plain HTTP against the Core API (pinned with the Polar-Version header), so the client is two
// small calls and easy to fake in tests. Webhooks follow the Standard Webhooks spec (headers
// webhook-id / -timestamp / -signature, signed over the raw body with POLAR_WEBHOOK_SECRET).
import { Webhook } from 'standardwebhooks';
import { config } from '../../shared/config.ts';
import { badRequest, conflict, planLimit } from '../../shared/errors.ts';
import { webhookUnauthorized } from '../auth/webhooks.ts';
import type { User } from '../auth/users.ts';
import { findWaitlistOffer } from '../auth/waitlist.ts';
import { getTopUp, planLimits, type PlanId } from './plans.ts';
import {
  getCurrentSubscription,
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
    metadata: Record<string, string>;
    /** A Polar discount applied to this checkout (the waitlist offer). */
    discountId?: string;
  }): Promise<{ checkoutUrl: string; checkoutId: string }>;
  /** PATCH /v1/subscriptions/{id} { cancel_at_period_end: true } */
  cancelAtPeriodEnd(subscriptionId: string): Promise<void>;
}

class HttpPolar implements PolarClient {
  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
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
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Polar ${method} ${path} failed: ${res.status}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async createCheckout(input: Parameters<PolarClient['createCheckout']>[0]) {
    const out = await this.request<{ id: string; url: string }>('POST', '/v1/checkouts/', {
      products: [input.productId],
      external_customer_id: input.externalCustomerId,
      ...(input.customerEmail ? { customer_email: input.customerEmail } : {}),
      ...(input.customerName ? { customer_name: input.customerName } : {}),
      success_url: input.successUrl,
      metadata: input.metadata,
      // Only the discount we attach (the waitlist offer); no codes typed in at checkout.
      allow_discount_codes: false,
      ...(input.discountId ? { discount_id: input.discountId } : {}),
    });
    return { checkoutUrl: out.url, checkoutId: out.id };
  }

  async cancelAtPeriodEnd(subscriptionId: string) {
    await this.request('PATCH', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      cancel_at_period_end: true,
    });
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

function productFor(kind: 'plan' | 'topup', id: string): string {
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
  const successUrl = `${config().WEB_APP_URL}/billing?checkout=done`;
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
    metadata,
    ...(discountId ? { discountId } : {}),
  });
  return { checkoutUrl, discountApplied: Boolean(discountId) };
}

/** Cancel at the end of the current period (the plan stays until then). */
export async function cancelSubscription(userId: string): Promise<Subscription> {
  const current = await getCurrentSubscription(userId);
  if (current?.status === 'cancel_at_period_end') return current;
  const renewing = await getRenewingSubscription(userId);
  if (!renewing) throw conflict('No active paid subscription');
  await polar().cancelAtPeriodEnd(renewing.polarSubscriptionId);
  return (await setSubscriptionStatus(renewing.id, 'cancel_at_period_end'))!;
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
