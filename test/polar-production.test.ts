// Polar for real money: the customer portal link, the checkout's fixed settings (no trials, a back
// link), a paused subscription, and the read-only setup check run before switching to production.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getUser, scrubDeletedUser } from '../src/modules/auth/users.ts';
import { getBalance } from '../src/modules/billing/credits.ts';
import { checkPolarSetup, REQUIRED_EVENTS } from '../src/modules/billing/polar-check.ts';
import { handlePolarEvent } from '../src/modules/billing/polar-events.ts';
import { POLAR_API_VERSION, polar, setPolarClient } from '../src/modules/billing/polar.ts';
import { getCurrentSubscription } from '../src/modules/billing/subscriptions.ts';
import { ingestEvent } from '../src/modules/events/intake.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { config, resetConfig } from '../src/shared/config.ts';
import { installFakes, member } from './billing-fakes.ts';
import { DAY, fakeJob, grantsOf } from './billing-helpers.ts';
import { call, createUser, expectContract } from './helpers.ts';
import {
  PRODUCTS,
  installPolar,
  orderPaid,
  subscriptionEvent,
  type FakePolar,
  type SubOpts,
} from './polar-fakes.ts';

afterAll(closeQueues);
installFakes();
let fake: FakePolar = installPolar();

async function deliver(payload: { type: string; data?: unknown }) {
  const { eventId } = await ingestEvent({
    source: 'polar',
    externalId: `msg_${randomUUID()}`,
    type: payload.type,
    payload: payload as Record<string, unknown>,
    queue: 'system',
    jobName: 'polar-event',
  });
  return handlePolarEvent(fakeJob({ eventId }));
}

/** Runs `fn` with some env settings changed, then puts them back. */
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetConfig();
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetConfig();
  }
}

describe('Manage billing: the customer portal link', () => {
  it('a customer gets a signed-in portal link that comes back to the billing page', async () => {
    const u = await createUser();
    fake.customers.add(u.id);
    const body = await expectContract<{ portalUrl: string }>(
      'openBillingPortal',
      await call('/v1/billing/portal', { method: 'POST', token: u.token }),
      200,
    );
    expect(body.portalUrl).toMatch(/^https:\/\/sandbox\.polar\.sh\/.+\/portal\?/);
    expect(fake.portals.at(-1)).toEqual({
      externalCustomerId: u.id, // Polar finds the customer by our user id, never by email
      returnUrl: `${config().WEB_APP_URL}/billing`,
    });
  });

  it('someone who never bought anything is told so (409)', async () => {
    const u = await createUser();
    await expectContract(
      'openBillingPortal',
      await call('/v1/billing/portal', { method: 'POST', token: u.token }),
      409,
    );
  });

  it('Polar down, or no token on the server → 503; signed out → 401', async () => {
    const u = await createUser();
    fake.customers.add(u.id);
    fake.failPortal = true;
    await expectContract(
      'openBillingPortal',
      await call('/v1/billing/portal', { method: 'POST', token: u.token }),
      503,
    );
    await withEnv({ POLAR_ACCESS_TOKEN: undefined }, async () => {
      await expectContract(
        'openBillingPortal',
        await call('/v1/billing/portal', { method: 'POST', token: u.token }),
        503,
      );
      await expectContract(
        'createCheckout',
        await call('/v1/billing/checkout', {
          method: 'POST',
          token: u.token,
          body: { kind: 'plan', planId: 'pro' },
        }),
        503,
      );
    });
    await expectContract(
      'openBillingPortal',
      await call('/v1/billing/portal', { method: 'POST' }),
      401,
    );
  });
});

describe('what is sent to Polar (the real HTTP client)', () => {
  const sent: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    fake = installPolar();
  });

  function stubFetch(answer: (url: string) => { status: number; body: unknown }) {
    sent.length = 0;
    vi.stubGlobal('fetch', async (input: URL | string, init: RequestInit) => {
      const url = String(input);
      sent.push({
        url,
        method: init.method ?? 'GET',
        headers: new Headers(init.headers),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const a = answer(url);
      return new Response(JSON.stringify(a.body), { status: a.status });
    });
    setPolarClient(undefined); // the real client, talking to the stubbed fetch
  }

  it('a checkout: our user id as the external customer, no trial, a back link, the version pinned', async () => {
    stubFetch(() => ({ status: 201, body: { id: 'chk_1', url: 'https://polar.sh/checkout/x' } }));
    const u = await member(0);
    const res = await call('/v1/billing/checkout', {
      method: 'POST',
      token: u.token,
      body: { kind: 'plan', planId: 'max' },
    });
    expect(res.status).toBe(200);
    const req = sent[0]!;
    expect(req.url).toBe('https://sandbox-api.polar.sh/v1/checkouts/');
    expect(req.headers.get('polar-version')).toBe(POLAR_API_VERSION);
    expect(req.body).toMatchObject({
      products: [PRODUCTS.max],
      external_customer_id: u.id,
      allow_trial: false,
      allow_discount_codes: false,
      return_url: `${config().WEB_APP_URL}/pricing`,
      metadata: { user_id: u.id, kind: 'plan', plan_id: 'max' },
    });
    expect((req.body as { success_url: string }).success_url).toBe(
      `${config().WEB_APP_URL}/billing?checkout=done&checkout_id={CHECKOUT_ID}`,
    );
  });

  it('production is one setting: the same calls go to api.polar.sh', async () => {
    await withEnv({ POLAR_SERVER: 'production' }, async () => {
      stubFetch(() => ({
        status: 201,
        body: { customer_portal_url: 'https://polar.sh/text-crew/portal?x=1' },
      }));
      expect(await polar().customerPortalUrl('usr_1', 'https://app.example/billing')).toBe(
        'https://polar.sh/text-crew/portal?x=1',
      );
      expect(sent[0]!.url).toBe('https://api.polar.sh/v1/customer-sessions/');
      expect(sent[0]!.body).toEqual({
        external_customer_id: 'usr_1',
        return_url: 'https://app.example/billing',
      });
    });
  });

  it('the portal call: an unknown customer is null, not an error', async () => {
    stubFetch(() => ({ status: 404, body: { detail: 'Customer not found' } }));
    expect(await polar().customerPortalUrl('usr_nobody', 'https://app.example/billing')).toBe(null);
  });
});

describe('a paused subscription', () => {
  const period = () => ({ start: new Date(), end: new Date(Date.now() + 30 * DAY) });

  it('pause → Free now; the paid resume brings the plan back with that period’s credits', async () => {
    const u = await member(0);
    const sub: SubOpts = { userId: u.id, subId: randomUUID(), ...period() };
    await deliver(subscriptionEvent('subscription.active', sub));
    expect((await getUser(u.id))!.plan).toBe('pro');
    expect(await getBalance(u.id)).toBe(1500);

    await deliver(subscriptionEvent('subscription.paused', { ...sub, status: 'paused' }));
    expect((await getUser(u.id))!.plan).toBe('free');
    expect(await getCurrentSubscription(u.id)).toBeUndefined();
    expect(await getBalance(u.id)).toBe(1500); // credits keep their own 90 days

    // A late event for the old period changes nothing.
    await deliver(subscriptionEvent('subscription.active', sub));
    expect((await getUser(u.id))!.plan).toBe('free');

    // subscription.resumed alone gives nothing; the paid order of the new period does.
    const resumed: SubOpts = {
      ...sub,
      start: new Date(Date.now() + 1000),
      end: new Date(Date.now() + 31 * DAY),
    };
    await deliver(subscriptionEvent('subscription.resumed', resumed));
    expect((await getUser(u.id))!.plan).toBe('free');
    const order = orderPaid(
      {
        userId: u.id,
        orderId: randomUUID(),
        product: PRODUCTS.pro,
        netAmount: 1900,
        billingReason: 'subscription_cycle',
      },
      resumed,
    );
    await deliver(order);
    await deliver(order); // twice: still one grant
    expect((await getUser(u.id))!.plan).toBe('pro');
    expect((await getCurrentSubscription(u.id))!.status).toBe('active');
    expect(await getBalance(u.id)).toBe(3000);
    expect((await grantsOf(u.id)).filter((g) => g.source === 'monthly')).toHaveLength(2);
  });

  it('a revoked subscription is not brought back by a late event', async () => {
    const u = await member(0);
    const sub: SubOpts = { userId: u.id, subId: randomUUID(), ...period() };
    await deliver(subscriptionEvent('subscription.active', sub));
    await deliver(
      subscriptionEvent('subscription.revoked', {
        ...sub,
        status: 'canceled',
        endedAt: new Date(),
      }),
    );
    await deliver(
      orderPaid(
        {
          userId: u.id,
          orderId: randomUUID(),
          product: PRODUCTS.pro,
          netAmount: 1900,
          billingReason: 'subscription_cycle',
        },
        { ...sub, status: 'canceled' },
      ),
    );
    expect((await getUser(u.id))!.plan).toBe('free');
    expect(await getBalance(u.id)).toBe(1500);
  });
});

describe('which account a payment belongs to', () => {
  it('a new account wins over a deleted one that still owns the Polar customer', async () => {
    // Someone deleted their account and signed up again with the same email. Polar matched the
    // checkout to their old customer, whose external id is the deleted account; our checkout's
    // metadata names the new one.
    const old = await member(0);
    await scrubDeletedUser(old.id);
    const fresh = await member(0);
    const sub: SubOpts = {
      userId: old.id,
      subId: randomUUID(),
      start: new Date(),
      end: new Date(Date.now() + 30 * DAY),
      metadata: { user_id: fresh.id, kind: 'plan', plan_id: 'pro' },
    };
    await deliver(subscriptionEvent('subscription.active', sub));
    expect((await getUser(fresh.id))!.plan).toBe('pro');
    expect(await getBalance(fresh.id)).toBe(1500);
    expect(await getBalance(old.id)).toBe(0);
  });
});

describe('polar:check (read-only setup check)', () => {
  const product = (id: string, cents: number, monthly: boolean) => ({
    id,
    name: `Product ${cents}`,
    is_archived: false,
    is_recurring: monthly,
    recurring_interval: monthly ? 'month' : null,
    recurring_interval_count: monthly ? 1 : null,
    trial_interval: null,
    prices: [
      { amount_type: 'fixed', price_amount: cents, price_currency: 'usd', is_archived: false },
    ],
  });
  const webhook = (over: Record<string, unknown> = {}) => ({
    items: [
      {
        url: `${config().PUBLIC_API_URL}/webhooks/polar`,
        enabled: true,
        format: 'raw',
        api_version: POLAR_API_VERSION,
        events: [...REQUIRED_EVENTS, 'checkout.created'],
        ...over,
      },
    ],
  });
  const polarAnswers =
    (over: Record<string, unknown> = {}) =>
    async (path: string) => {
      const c = config();
      const answers: Record<string, unknown> = {
        [`/v1/products/${c.POLAR_PRODUCT_PRO}`]: product(c.POLAR_PRODUCT_PRO!, 1900, true),
        [`/v1/products/${c.POLAR_PRODUCT_MAX}`]: product(c.POLAR_PRODUCT_MAX!, 3000, true),
        [`/v1/products/${c.POLAR_PRODUCT_TOPUP_10}`]: product(
          c.POLAR_PRODUCT_TOPUP_10!,
          1000,
          false,
        ),
        '/v1/webhooks/endpoints?limit=100': webhook(),
        ...over,
      };
      if (!(path in answers)) throw new Error(`unexpected ${path}`);
      return answers[path];
    };

  it('all OK when the products, prices and webhook match our plans', async () => {
    const lines = await checkPolarSetup(polarAnswers());
    expect(lines.filter((l) => !l.ok)).toEqual([]);
    expect(lines.map((l) => l.item)).toEqual([
      'Server',
      'Pro product',
      'Max product',
      'Top-up product',
      'Waitlist discount',
      'Webhook endpoint',
    ]);
  });

  it('says what is wrong: a price that differs, a missing event, a wrong discount', async () => {
    const c = config();
    await withEnv({ POLAR_WAITLIST_DISCOUNT_ID: 'disc_1' }, async () => {
      const lines = await checkPolarSetup(
        polarAnswers({
          [`/v1/products/${c.POLAR_PRODUCT_PRO}`]: product(c.POLAR_PRODUCT_PRO!, 600, true),
          '/v1/webhooks/endpoints?limit=100': webhook({
            events: REQUIRED_EVENTS.filter((e) => e !== 'order.paid'),
          }),
          '/v1/discounts/disc_1': {
            type: 'percentage',
            basis_points: 5000,
            duration: 'forever',
            code: null,
            products: [],
          },
        }),
      );
      const bad = Object.fromEntries(lines.filter((l) => !l.ok).map((l) => [l.item, l.detail]));
      expect(Object.keys(bad).sort()).toEqual([
        'Pro product',
        'Waitlist discount',
        'Webhook endpoint',
      ]);
      expect(bad['Pro product']).toContain('price is $6, our plans say $19');
      expect(bad['Webhook endpoint']).toContain('missing events: order.paid');
      expect(bad['Waitlist discount']).toContain('once');
    });
  });

  it('a product priced in several currencies is checked on its dollar price', async () => {
    const c = config();
    const pro = product(c.POLAR_PRODUCT_PRO!, 1900, true);
    pro.prices.push({
      amount_type: 'fixed',
      price_amount: 99900,
      price_currency: 'inr',
      is_archived: false,
    });
    const lines = await checkPolarSetup(
      polarAnswers({ [`/v1/products/${c.POLAR_PRODUCT_PRO}`]: pro }),
    );
    expect(lines.find((l) => l.item === 'Pro product')).toMatchObject({ ok: true });
  });

  it('without a token it stops at once and prints no secret', async () => {
    await withEnv({ POLAR_ACCESS_TOKEN: undefined }, async () => {
      const lines = await checkPolarSetup(async () => {
        throw new Error('must not be called');
      });
      expect(lines.at(-1)).toMatchObject({ item: 'Access token', ok: false });
    });
    const text = JSON.stringify(await checkPolarSetup(polarAnswers()));
    expect(text).not.toContain(process.env.POLAR_ACCESS_TOKEN!);
    expect(text).not.toContain(process.env.POLAR_WEBHOOK_SECRET!);
  });
});
