// Dodo Payments (HLD 7.6): hosted checkout, cancel at period end, and webhook verification.
// Webhooks follow the Standard Webhooks spec (headers webhook-id / -timestamp / -signature,
// signed over the raw body with DODO_WEBHOOK_SECRET).
import { Webhook } from 'standardwebhooks';
import { config } from '../../shared/config.ts';
import { badRequest, conflict, planLimit } from '../../shared/errors.ts';
import { webhookUnauthorized } from '../auth/webhooks.ts';
import type { User } from '../auth/users.ts';
import { getTopUp, planLimits, type PlanId } from './plans.ts';
import {
  getCurrentSubscription,
  getRenewingSubscription,
  setSubscriptionStatus,
  type Subscription,
} from './subscriptions.ts';

export interface DodoClient {
  /** POST /checkouts → a hosted checkout URL. */
  createCheckoutSession(input: {
    productId: string;
    quantity: number;
    customer?: { email: string; name?: string };
    returnUrl: string;
    metadata: Record<string, string>;
  }): Promise<{ checkoutUrl: string; sessionId: string }>;
  /** PATCH /subscriptions/{id} { cancel_at_next_billing_date: true } */
  cancelAtPeriodEnd(subscriptionId: string): Promise<void>;
}

class HttpDodo implements DodoClient {
  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    const c = config();
    if (!c.DODO_API_KEY) throw new Error('DODO_API_KEY is not set');
    const res = await fetch(new URL(path, c.DODO_API_URL), {
      method,
      headers: { authorization: `Bearer ${c.DODO_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Dodo ${method} ${path} failed: ${res.status}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async createCheckoutSession(input: Parameters<DodoClient['createCheckoutSession']>[0]) {
    const out = await this.request<{ session_id: string; checkout_url: string }>(
      'POST',
      '/checkouts',
      {
        product_cart: [{ product_id: input.productId, quantity: input.quantity }],
        ...(input.customer ? { customer: input.customer } : {}),
        return_url: input.returnUrl,
        metadata: input.metadata,
      },
    );
    return { checkoutUrl: out.checkout_url, sessionId: out.session_id };
  }

  async cancelAtPeriodEnd(subscriptionId: string) {
    await this.request('PATCH', `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      cancel_at_next_billing_date: true,
    });
  }
}

let client: DodoClient | undefined;

export function dodo(): DodoClient {
  client ??= new HttpDodo();
  return client;
}

/** Tests: swap in a fake Dodo. */
export function setDodoClient(fake: DodoClient | undefined): void {
  client = fake;
}

// --- products ---------------------------------------------------------------------------------

function productFor(kind: 'plan' | 'topup', id: string): string {
  const c = config();
  const map: Record<string, string | undefined> = {
    'plan:pro': c.DODO_PRODUCT_PRO,
    'plan:max': c.DODO_PRODUCT_MAX,
    'topup:topup_10': c.DODO_PRODUCT_TOPUP_10,
  };
  const product = map[`${kind}:${id}`];
  if (!product) throw new Error(`Dodo product for ${kind} ${id} is not configured`);
  return product;
}

/** Which plan a Dodo product id is (undefined for top-ups / unknown products). */
export function planForProduct(productId: string | undefined): PlanId | undefined {
  const c = config();
  if (!productId) return undefined;
  if (productId === c.DODO_PRODUCT_PRO) return 'pro';
  if (productId === c.DODO_PRODUCT_MAX) return 'max';
  return undefined;
}

export function isTopUpProduct(productId: string | undefined): boolean {
  return Boolean(productId) && productId === config().DODO_PRODUCT_TOPUP_10;
}

// --- checkout ---------------------------------------------------------------------------------

export type CheckoutRequest = { kind: 'plan'; planId: PlanId } | { kind: 'topup'; topUpId: string };

/** The plan or credits change only when Dodo's webhook arrives, never from this call. */
export async function startCheckout(user: User, req: CheckoutRequest): Promise<string> {
  const returnUrl = `${config().WEB_APP_URL}/billing?checkout=done`;
  const customer = user.email ? { email: user.email, name: user.name || user.email } : undefined;
  let productId: string;
  let metadata: Record<string, string>;
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
  } else {
    const pack = getTopUp(req.topUpId);
    if (!pack) throw badRequest('Unknown top-up pack', { topUpId: req.topUpId });
    if (!planLimits(user.plan).topUps) {
      throw planLimit('Top-ups are for paid plans. Upgrade, or redeem a coupon code.');
    }
    productId = productFor('topup', pack.id);
    metadata = { user_id: user.id, kind: 'topup', top_up_id: pack.id };
  }
  const { checkoutUrl } = await dodo().createCheckoutSession({
    productId,
    quantity: 1,
    ...(customer ? { customer } : {}),
    returnUrl,
    metadata,
  });
  return checkoutUrl;
}

/** Cancel at the end of the current period (the plan stays until then). */
export async function cancelSubscription(userId: string): Promise<Subscription> {
  const current = await getCurrentSubscription(userId);
  if (current?.status === 'cancel_at_period_end') return current;
  const renewing = await getRenewingSubscription(userId);
  if (!renewing) throw conflict('No active paid subscription');
  await dodo().cancelAtPeriodEnd(renewing.dodoSubscriptionId);
  return (await setSubscriptionStatus(renewing.id, 'cancel_at_period_end'))!;
}

// --- webhook ----------------------------------------------------------------------------------

export interface DodoWebhook {
  business_id?: string;
  type?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
}

/** Verifies the Standard Webhooks signature on the raw body, then parses it. */
export function verifyDodoWebhook(
  rawBody: string,
  headers: Record<string, string | undefined>,
): DodoWebhook {
  const secret = config().DODO_WEBHOOK_SECRET;
  if (!secret) throw webhookUnauthorized();
  try {
    new Webhook(secret).verify(rawBody, {
      'webhook-id': headers['webhook-id'] ?? '',
      'webhook-timestamp': headers['webhook-timestamp'] ?? '',
      'webhook-signature': headers['webhook-signature'] ?? '',
    });
    return JSON.parse(rawBody) as DodoWebhook;
  } catch {
    throw webhookUnauthorized();
  }
}
