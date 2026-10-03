import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { allRoutes } from '../src/api/app.ts';
import { getOperation } from '../src/api/openapi/spec.ts';
import { syncUsageForUser } from '../src/modules/billing/usage.ts';
import { events } from '../src/modules/events/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { db } from '../src/shared/db/client.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakes, member } from './billing-fakes.ts';
import { DAY, grantsOf, linkChat } from './billing-helpers.ts';
import { call, createUser, expectContract, waitFor } from './helpers.ts';
import { installPolar, signPolar, topUpOrder } from './polar-fakes.ts';

afterAll(closeQueues);
const { llm, vm } = installFakes();
installPolar();

type Err = { error: { code: string; message: string } };
const post = (token: string, body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  token,
  body,
  headers,
});

describe('contract: routes', () => {
  it('every Phase 5 operation is mounted and in openapi.yaml', () => {
    const mounted = new Set(allRoutes.map((r) => r.operationId));
    for (const op of [
      'listPlans',
      'getSubscription',
      'createCheckout',
      'cancelSubscription',
      'getCredits',
      'listLedger',
      'getUsage',
      'redeemCoupon',
      'adminListCoupons',
      'adminCreateCoupon',
      'adminUpdateCoupon',
      'adminAdjustCredits',
      'adminFreeCreditStats',
      'webhookPolar',
      'listByokKeys',
      'setByokKey',
      'deleteByokKey',
    ]) {
      expect(mounted.has(op as never), op).toBe(true);
      expect(() => getOperation(op)).not.toThrow();
    }
  });
});

describe('contract: billing', () => {
  it('GET /v1/billing/plans (public)', async () => {
    const body = await expectContract<{
      plans: Array<{ id: string; priceCents: number; monthlyCredits: number }>;
      topUps: Array<{ id: string; credits: number }>;
    }>('listPlans', await call('/v1/billing/plans'), 200);
    expect(body.plans.map((p) => [p.id, p.priceCents, p.monthlyCredits])).toEqual([
      ['free', 0, 0],
      ['pro', 1200, 1500],
      ['max', 3000, 4500],
    ]);
    expect(body.topUps).toEqual([
      { id: 'topup_10', priceCents: 1000, credits: 800, expiresInDays: 90 },
    ]);
  });

  it('GET /v1/billing/subscription', async () => {
    await expectContract('getSubscription', await call('/v1/billing/subscription'), 401);
    const u = await createUser();
    const body = await expectContract<{ plan: string; status: string }>(
      'getSubscription',
      await call('/v1/billing/subscription', { token: u.token }),
      200,
    );
    expect(body).toMatchObject({ plan: 'free', status: 'none' });
  });

  it('POST /v1/billing/checkout', async () => {
    const u = await createUser();
    const ok = await expectContract<{ checkoutUrl: string }>(
      'createCheckout',
      await call('/v1/billing/checkout', post(u.token, { kind: 'plan', planId: 'pro' })),
      200,
    );
    expect(ok.checkoutUrl).toMatch(/^https:\/\//);
    const topup = await expectContract<Err>(
      'createCheckout',
      await call('/v1/billing/checkout', post(u.token, { kind: 'topup', topUpId: 'topup_10' })),
      403,
    );
    expect(topup.error.code).toBe('plan_limit');
    await expectContract(
      'createCheckout',
      await call('/v1/billing/checkout', post(u.token, { kind: 'plan', planId: 'free' })),
      400,
    );
    await expectContract(
      'createCheckout',
      await call('/v1/billing/checkout', post(u.token, { kind: 'plan', planId: 'gold' })),
      400,
    );
    await expectContract(
      'createCheckout',
      await call('/v1/billing/checkout', { method: 'POST' }),
      401,
    );
  });

  it('POST /v1/billing/subscription/cancel', async () => {
    const u = await createUser();
    const body = await expectContract<Err>(
      'cancelSubscription',
      await call('/v1/billing/subscription/cancel', { method: 'POST', token: u.token }),
      409,
    );
    expect(body.error.code).toBe('conflict');
  });
});

describe('contract: credits', () => {
  it('GET /v1/credits', async () => {
    const u = await member(100);
    const body = await expectContract<{ balance: number; grants: Array<{ source: string }> }>(
      'getCredits',
      await call('/v1/credits', { token: u.token }),
      200,
    );
    expect(body.balance).toBe(100);
    expect(body.grants.map((g) => g.source)).toEqual(['signup']);
  });

  it('GET /v1/credits/ledger paginates newest first', async () => {
    const u = await member(100);
    llm.spend(u.id, 'cheap', 0.004);
    await syncUsageForUser(u.id);
    const first = await expectContract<{
      items: Array<{ id: string; reason: string }>;
      nextCursor: string | null;
    }>('listLedger', await call('/v1/credits/ledger?limit=1', { token: u.token }), 200);
    expect(first.items.map((i) => i.reason)).toEqual(['charge']);
    expect(first.nextCursor).not.toBeNull();
    const second = await expectContract<{
      items: Array<{ reason: string }>;
      nextCursor: string | null;
    }>(
      'listLedger',
      await call(`/v1/credits/ledger?limit=1&cursor=${first.nextCursor}`, { token: u.token }),
      200,
    );
    expect(second.items.map((i) => i.reason)).toEqual(['grant']);
    expect(second.nextCursor).toBeNull();
    await expectContract(
      'listLedger',
      await call('/v1/credits/ledger?limit=0', { token: u.token }),
      400,
    );
  });

  it('GET /v1/usage', async () => {
    const u = await member(100);
    vm.add(u.id, 1200, 60);
    llm.spend(u.id, 'cheap', 0.008);
    await syncUsageForUser(u.id);
    const from = new Date(Date.now() - DAY).toISOString();
    const to = new Date(Date.now() + DAY).toISOString();
    const body = await expectContract<{ items: unknown[]; totals: Record<string, number> }>(
      'getUsage',
      await call(`/v1/usage?from=${from}&to=${to}`, { token: u.token }),
      200,
    );
    expect(body.items).toHaveLength(1);
    expect(body.totals).toEqual({
      aiCredits: 2,
      awakeCredits: 2,
      appActionCredits: 0,
      toolCredits: 2,
      totalCredits: 6,
    });
    await expectContract(
      'getUsage',
      await call(`/v1/usage?from=${to}&to=${from}`, { token: u.token }),
      400,
    );
    await expectContract('getUsage', await call('/v1/usage', { token: u.token }), 400);
  });
});

describe('contract: coupons + admin', () => {
  it('admin endpoints are admin-only', async () => {
    const u = await createUser();
    await expectContract('adminListCoupons', await call('/v1/admin/coupons'), 401);
    await expectContract(
      'adminListCoupons',
      await call('/v1/admin/coupons', { token: u.token }),
      403,
    );
    await expectContract(
      'adminCreateCoupon',
      await call(
        '/v1/admin/coupons',
        post(u.token, {
          campaign: 'x',
          credits: 1,
          maxRedemptions: 1,
          expiresAt: new Date().toISOString(),
        }),
      ),
      403,
    );
    await expectContract(
      'adminFreeCreditStats',
      await call('/v1/admin/stats/free-credits', { token: u.token }),
      403,
    );
  });

  it('create → list → redeem → disable, with the generic error and the rate limit', async () => {
    const admin = await createUser({ role: 'admin' });
    const created = await expectContract<{
      coupon: { id: string; codePrefix: string };
      codes: string[];
    }>(
      'adminCreateCoupon',
      await call(
        '/v1/admin/coupons',
        post(admin.token, {
          campaign: 'Launch',
          credits: 200,
          maxRedemptions: 20,
          expiresAt: new Date(Date.now() + 7 * DAY).toISOString(),
        }),
      ),
      201,
    );
    expect(created.codes).toHaveLength(1);
    expect(created.coupon.codePrefix).toBe(`${created.codes[0]!.slice(0, 6)}…`);
    await expectContract(
      'adminCreateCoupon',
      await call(
        '/v1/admin/coupons',
        post(admin.token, {
          campaign: 'Past',
          credits: 5,
          maxRedemptions: 1,
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      ),
      400,
    );
    await expectContract(
      'adminCreateCoupon',
      await call('/v1/admin/coupons', post(admin.token, { credits: 5 })),
      400,
    );

    const list = await expectContract<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      'adminListCoupons',
      await call('/v1/admin/coupons?limit=100', { token: admin.token }),
      200,
    );
    expect(list.items.map((c) => c.id)).toContain(created.coupon.id);

    const u = await createUser();
    await linkChat(u.id);
    const ip = { 'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 200)}` };
    const redeemed = await expectContract<{
      creditsAdded: number;
      balance: number;
      cheapModelOnly: boolean;
    }>(
      'redeemCoupon',
      await call('/v1/coupons/redeem', post(u.token, { code: created.codes[0] }, ip)),
      200,
    );
    expect(redeemed).toMatchObject({ creditsAdded: 200, balance: 200, cheapModelOnly: true });
    const again = await expectContract<Err>(
      'redeemCoupon',
      await call('/v1/coupons/redeem', post(u.token, { code: created.codes[0] }, ip)),
      400,
    );
    expect(again.error).toEqual({
      code: 'invalid_or_expired_code',
      message: 'Invalid or expired code',
    });
    const wrong = await expectContract<Err>(
      'redeemCoupon',
      await call('/v1/coupons/redeem', post(u.token, { code: 'AGT-AAAA-BBBB-CCCC-DDDD' }, ip)),
      400,
    );
    expect(wrong.error).toEqual(again.error);
    await expectContract(
      'redeemCoupon',
      await call('/v1/coupons/redeem', post(u.token, { code: 'x' }, ip)),
      400,
    );
    for (let i = 0; i < 2; i++)
      await call('/v1/coupons/redeem', post(u.token, { code: 'AGT-AAAA-BBBB-CCCC-EEEE' }, ip));
    const limited = await call('/v1/coupons/redeem', post(u.token, { code: created.codes[0] }, ip));
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    const body = await expectContract<Err>('redeemCoupon', limited, 429);
    expect(body.error.code).toBe('rate_limited');
    await expectContract(
      'redeemCoupon',
      await call('/v1/coupons/redeem', { method: 'POST', body: { code: 'AGT-AAAA-BBBB' } }),
      401,
    );

    const disabled = await expectContract<{ active: boolean }>(
      'adminUpdateCoupon',
      await call(`/v1/admin/coupons/${created.coupon.id}`, {
        method: 'PATCH',
        token: admin.token,
        body: { active: false, revokeUnspentCredits: true },
      }),
      200,
    );
    expect(disabled.active).toBe(false);
    expect((await grantsOf(u.id))[0]!.remaining).toBe(0);
    await expectContract(
      'adminUpdateCoupon',
      await call('/v1/admin/coupons/cpn_missing', {
        method: 'PATCH',
        token: admin.token,
        body: { active: false },
      }),
      404,
    );
  });

  it('POST /v1/admin/users/{userId}/credits (idempotent)', async () => {
    const admin = await createUser({ role: 'admin' });
    const u = await createUser();
    const add = {
      amount: 300,
      reason: 'Support goodwill',
      idempotencyKey: randomUUID(),
      expiresAt: null,
    };
    for (let i = 0; i < 2; i++) {
      const body = await expectContract<{ balance: number }>(
        'adminAdjustCredits',
        await call(`/v1/admin/users/${u.id}/credits`, post(admin.token, add)),
        200,
      );
      expect(body.balance).toBe(300);
    }
    const removed = await expectContract<{ balance: number }>(
      'adminAdjustCredits',
      await call(
        `/v1/admin/users/${u.id}/credits`,
        post(admin.token, { amount: -120, reason: 'Abuse', idempotencyKey: randomUUID() }),
      ),
      200,
    );
    expect(removed.balance).toBe(180);
    await expectContract(
      'adminAdjustCredits',
      await call('/v1/admin/users/usr_missing/credits', post(admin.token, add)),
      404,
    );
    await expectContract(
      'adminAdjustCredits',
      await call(
        `/v1/admin/users/${u.id}/credits`,
        post(admin.token, { ...add, amount: 0, idempotencyKey: 'z' }),
      ),
      400,
    );
  });

  it('GET /v1/admin/stats/free-credits', async () => {
    const admin = await createUser({ role: 'admin' });
    const body = await expectContract<{
      month: string;
      capCredits: number | null;
      capReached: boolean;
    }>(
      'adminFreeCreditStats',
      await call('/v1/admin/stats/free-credits', { token: admin.token }),
      200,
    );
    expect(body.month).toBe(new Date().toISOString().slice(0, 7));
    expect(body).toMatchObject({ capCredits: null, capReached: false });
  });
});

describe('contract: bring your own key', () => {
  it('list / set (test-called first) / delete; the key is never returned', async () => {
    const u = await member(100);
    const list = await expectContract<{ items: Array<{ provider: string; set: boolean }> }>(
      'listByokKeys',
      await call('/v1/byok', { token: u.token }),
      200,
    );
    expect(list.items.every((k) => !k.set)).toBe(true);
    const saved = await expectContract<{ set: boolean; last4: string }>(
      'setByokKey',
      await call('/v1/byok/openai', {
        method: 'PUT',
        token: u.token,
        body: { apiKey: 'sk-openai-good-9876' },
      }),
      200,
    );
    expect(saved).toMatchObject({ set: true, last4: '9876' });
    expect(llm.remainingBudget(u.id)).toBeNull();
    const rejected = await expectContract<Err>(
      'setByokKey',
      await call('/v1/byok/openai', {
        method: 'PUT',
        token: u.token,
        body: { apiKey: 'sk-openai-bad-0000' },
      }),
      400,
    );
    expect(rejected.error.code).toBe('invalid_request');
    await expectContract(
      'setByokKey',
      await call('/v1/byok/mistral', {
        method: 'PUT',
        token: u.token,
        body: { apiKey: 'sk-mistral-12345' },
      }),
      400,
    );
    const after = await call('/v1/byok', { token: u.token });
    expect(await after.clone().text()).not.toContain('good-9876');
    await expectContract('listByokKeys', after, 200);
    await expectContract(
      'deleteByokKey',
      await call('/v1/byok/openai', { method: 'DELETE', token: u.token }),
      204,
    );
    expect(llm.remainingBudget(u.id)).toBeCloseTo(0.4, 6);
  });
});

describe('contract: Polar webhook', () => {
  it('rejects a bad signature without saving anything', async () => {
    const signed = signPolar({ type: 'order.paid', data: {} });
    const res = await call('/webhooks/polar', {
      method: 'POST',
      body: signed.body,
      headers: { ...signed.headers, 'webhook-signature': 'v1,AAAA' },
    });
    await expectContract('webhookPolar', res, 401);
    expect(
      await db().select().from(events).where(eq(events.externalId, signed.headers['webhook-id'])),
    ).toHaveLength(0);
  });

  it('a sandbox top-up sent twice adds credits exactly once', async () => {
    const u = await member(0, 'pro');
    const signed = signPolar(topUpOrder(u.id, randomUUID()));
    for (let i = 0; i < 2; i++) {
      await expectContract(
        'webhookPolar',
        await call('/webhooks/polar', {
          method: 'POST',
          body: signed.body,
          headers: signed.headers,
        }),
        200,
      );
    }
    const rows = await db()
      .select()
      .from(events)
      .where(eq(events.externalId, signed.headers['webhook-id']));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'polar', type: 'order.paid', userId: u.id });
    const workers = startWorkers(processors());
    try {
      await waitFor(async () => {
        const [e] = await db().select().from(events).where(eq(events.id, rows[0]!.id));
        return e?.status === 'done';
      });
    } finally {
      await Promise.all(workers.map((w) => w.close()));
    }
    const topups = (await grantsOf(u.id)).filter((g) => g.source === 'topup');
    expect(topups.map((g) => g.amount)).toEqual([800]);
    const credits = await expectContract<{ balance: number }>(
      'getCredits',
      await call('/v1/credits', { token: u.token }),
      200,
    );
    expect(credits.balance).toBe(800);
  });
});
