import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hasCredits } from '../src/modules/billing/balance.ts';
import {
  charge,
  createGrant,
  expireDueGrants,
  getBalance,
  type GrantSource,
} from '../src/modules/billing/credits.ts';
import { canUseModel } from '../src/modules/billing/models.ts';
import { aiCostToCredits, modelsForPlan, planLimits } from '../src/modules/billing/plans.ts';
import { creditLedger } from '../src/modules/billing/schema.ts';
import { db } from '../src/shared/db/client.ts';
import { DAY, grantsOf, ledgerMatchesGrants, ledgerOf } from './billing-helpers.ts';
import { createUser } from './helpers.ts';

let seq = 0;
async function grant(
  userId: string,
  source: GrantSource,
  amount: number,
  expiresInDays: number | null,
  cheapModelOnly = false,
) {
  const { grant } = await createGrant({
    userId,
    source,
    amount,
    expiresAt: expiresInDays === null ? null : new Date(Date.now() + expiresInDays * DAY),
    cheapModelOnly,
    idempotencyKey: `test:${userId}:${seq++}`,
    description: source,
  });
  return grant;
}

const usage = (
  p: Partial<{ cheapAi: number; otherAi: number; awake: number; browser: number }>,
) => ({
  cheapAi: 0,
  otherAi: 0,
  awake: 0,
  browser: 0,
  tools: 0,
  ...p,
});

const remaining = async (userId: string) =>
  Object.fromEntries((await grantsOf(userId)).map((g) => [g.source, g.remaining]));

describe('credits: grants + ledger', () => {
  it('balance = sum of what is left in unexpired grants; nothing stores a balance', async () => {
    const u = await createUser();
    await grant(u.id, 'signup', 100, null);
    await grant(u.id, 'topup', 800, 365);
    expect(await getBalance(u.id)).toBe(900);
    expect(await hasCredits(u.id)).toBe(true);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('spends the grant that expires soonest first (coupon → monthly → top-up → sign-up)', async () => {
    const u = await createUser({ plan: 'pro' });
    await grant(u.id, 'signup', 100, null);
    await grant(u.id, 'topup', 800, 365);
    await grant(u.id, 'monthly', 1500, 20);
    await grant(u.id, 'coupon', 200, 10); // not cheap-only here
    await charge(u.id, usage({ awake: 1750 }), { idempotencyKey: 'c1', description: 't' });
    expect(await remaining(u.id)).toEqual({ coupon: 0, monthly: 0, topup: 750, signup: 100 });
    // One ledger row per grant touched, all under the charge's key.
    const parts = (await ledgerOf(u.id)).filter((l) => l.reason === 'charge');
    expect(parts.map((p) => p.delta).sort((a, b) => a - b)).toEqual([-1500, -200, -50]);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('cheap-model-only grants pay only cheap-model AI and awake time', async () => {
    const u = await createUser({ plan: 'pro' });
    await grant(u.id, 'signup', 100, null);
    await grant(u.id, 'coupon', 200, 30, true);
    // Claude usage skips the coupon even though it expires sooner.
    await charge(u.id, usage({ otherAi: 30, browser: 10 }), {
      idempotencyKey: 'a',
      description: 't',
    });
    expect(await remaining(u.id)).toEqual({ signup: 60, coupon: 200 });
    // Cheap AI + awake time come from the coupon first.
    await charge(u.id, usage({ cheapAi: 20, awake: 5 }), { idempotencyKey: 'b', description: 't' });
    expect(await remaining(u.id)).toEqual({ signup: 60, coupon: 175 });
  });

  it('with only a cheap-only coupon, Claude usage does not touch it (it becomes debt)', async () => {
    const u = await createUser({ plan: 'pro' });
    await grant(u.id, 'coupon', 200, 30, true);
    await charge(u.id, usage({ otherAi: 10 }), { idempotencyKey: 'x', description: 't' });
    const gs = await grantsOf(u.id);
    expect(gs.find((g) => g.source === 'coupon')!.remaining).toBe(200);
    expect(await getBalance(u.id)).toBe(190);
    // The debt is not recoverable from a cheap-only grant, only from a normal one.
    await grant(u.id, 'coupon', 50, 30, true);
    expect(await getBalance(u.id)).toBe(240);
    await grant(u.id, 'topup', 800, 365);
    expect(await remaining(u.id)).toMatchObject({ topup: 790 });
    expect(await getBalance(u.id)).toBe(1040);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('a small overrun is allowed and recovered from the next grant', async () => {
    const u = await createUser();
    await grant(u.id, 'signup', 10, null);
    await charge(u.id, usage({ cheapAi: 15 }), { idempotencyKey: 'over', description: 't' });
    expect(await getBalance(u.id)).toBe(-5);
    expect(await hasCredits(u.id)).toBe(false);
    const g = await grant(u.id, 'coupon', 200, 30, true);
    expect(g.remaining).toBe(195);
    expect(await getBalance(u.id)).toBe(195);
    expect(await remaining(u.id)).toEqual({ signup: 0, coupon: 195, admin: 0 }); // admin = overrun holder
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('a user with no grants at all still records the overrun', async () => {
    const u = await createUser();
    await charge(u.id, usage({ awake: 3 }), { idempotencyKey: 'none', description: 't' });
    expect(await getBalance(u.id)).toBe(-3);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('every charge has an idempotency key: the same key never charges twice', async () => {
    const u = await createUser();
    await grant(u.id, 'signup', 100, null);
    const first = await charge(u.id, usage({ awake: 7 }), {
      idempotencyKey: 'same',
      description: 't',
    });
    const again = await Promise.all(
      [1, 2, 3].map(() =>
        charge(u.id, usage({ awake: 7 }), { idempotencyKey: 'same', description: 't' }),
      ),
    );
    expect(first).toEqual({ charged: 7, duplicate: false });
    expect(again.every((r) => r.duplicate)).toBe(true);
    expect(await getBalance(u.id)).toBe(93);
  });

  it('grants are idempotent too', async () => {
    const u = await createUser();
    const input = {
      userId: u.id,
      source: 'topup' as const,
      amount: 800,
      expiresAt: null,
      idempotencyKey: `topup:pay_${u.id}`,
      description: 'Top-up',
    };
    const results = await Promise.all([createGrant(input), createGrant(input), createGrant(input)]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await getBalance(u.id)).toBe(800);
  });

  it('expired grants leave the balance; the expire job writes the ledger; debt never expires', async () => {
    const u = await createUser();
    await grant(u.id, 'coupon', 200, 30, true);
    await grant(u.id, 'signup', 5, null);
    await charge(u.id, usage({ otherAi: 8 }), { idempotencyKey: 'd', description: 't' });
    expect(await getBalance(u.id)).toBe(197); // 200 + (5 − 8)
    const later = new Date(Date.now() + 31 * DAY);
    expect(await getBalance(u.id, later)).toBe(-3); // coupon gone, debt stays
    expect(await expireDueGrants(later)).toContain(u.id);
    expect(await expireDueGrants(later)).not.toContain(u.id); // nothing left to expire
    const expired = (await ledgerOf(u.id)).filter((l) => l.reason === 'expire');
    expect(expired.map((e) => e.delta)).toEqual([-200]);
    expect(await getBalance(u.id, later)).toBe(-3);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('the ledger is append-only (an UPDATE is rejected by the database)', async () => {
    const u = await createUser();
    await grant(u.id, 'signup', 100, null);
    await expect(
      db()
        .update(creditLedger)
        .set({ delta: sql`${creditLedger.delta} + 1000` })
        .where(eq(creditLedger.userId, u.id)),
    ).rejects.toThrow();
  });
});

describe('plans', () => {
  it('limits per plan (Free 1 / Pro 5 / Max 50 automations)', () => {
    expect(planLimits('free')).toEqual({
      apps: 10,
      automations: 1,
      ownMcpServers: false,
      topUps: false,
      models: 'cheap',
    });
    expect(planLimits('pro')).toEqual({
      apps: 25,
      automations: 5,
      ownMcpServers: false,
      topUps: true,
      models: 'all',
    });
    expect(planLimits('max')).toEqual({
      apps: 25,
      automations: 50,
      ownMcpServers: true,
      topUps: true,
      models: 'all',
    });
  });

  it('models by plan: Free gets the cheap model only', async () => {
    expect(modelsForPlan('free')).toEqual(['cheap']);
    expect(modelsForPlan('pro')).toEqual(['cheap', 'claude', 'gpt']);
    const free = await createUser();
    const pro = await createUser({ plan: 'pro' });
    expect(await canUseModel(free.id, 'cheap')).toBe(true);
    expect(await canUseModel(free.id, 'claude')).toBe(false);
    expect(await canUseModel(pro.id, 'claude')).toBe(true);
    expect(await canUseModel(pro.id, 'unknown-model')).toBe(false);
    expect(await canUseModel(free.id, 'agent-default')).toBe(true);
  });

  it('AI cost × 2.5, rounded up (1 credit = $0.004 of real cost)', () => {
    expect(aiCostToCredits(0)).toBe(0);
    expect(aiCostToCredits(1)).toBe(1); // $0.000001
    expect(aiCostToCredits(4000)).toBe(1); // $0.004
    expect(aiCostToCredits(4001)).toBe(2);
    expect(aiCostToCredits(1_000_000)).toBe(250); // $1
  });
});
