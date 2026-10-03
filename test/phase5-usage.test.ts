import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { hasCredits } from '../src/modules/billing/balance.ts';
import { createGrant, getBalance } from '../src/modules/billing/credits.ts';
import { afterCreditsAdded } from '../src/modules/billing/enforce.ts';
import { onBalanceDepleted, onCreditsAdded } from '../src/modules/billing/hooks.ts';
import { refreshBudget } from '../src/modules/billing/litellm.ts';
import { usagePeriods } from '../src/modules/billing/schema.ts';
import { reverseTurn, syncAllUsage, syncUsageForUser } from '../src/modules/billing/usage.ts';
import { setByokKey } from '../src/modules/integrations/byok.ts';
import { db } from '../src/shared/db/client.ts';
import { installFakes, member, type FakeLiteLLM, type FakeVm } from './billing-fakes.ts';
import { ledgerMatchesGrants, ledgerOf } from './billing-helpers.ts';

// One set of fakes for the whole file: the 5-minute job syncs every user created so far.
const { llm, vm }: { llm: FakeLiteLLM; vm: FakeVm } = installFakes();

describe('sync-usage', () => {
  it('usage lowers the balance correctly (AI × 2.5 rounded up, awake, browser)', async () => {
    const u = await member(100);
    llm.spend(u.id, 'cheap', 0.0201); // → ceil(5.025) = 6 credits
    vm.add(u.id, 25 * 60, 90); // 25 min awake → 2 credits; 90 s browser → 3 credits
    const res = await syncUsageForUser(u.id);
    expect(res.charged).toBe(11);
    expect(res.balance).toBe(89);
    expect(await getBalance(u.id)).toBe(89);
    const [period] = await db().select().from(usagePeriods).where(eq(usagePeriods.userId, u.id));
    expect(period).toMatchObject({
      aiCostMicroUsd: 20100,
      aiCredits: 6,
      awakeSeconds: 1500,
      awakeCredits: 2,
      browserSeconds: 90,
      browserCredits: 3,
      toolCredits: 0,
      creditsCharged: 11,
    });
    // Budget follows the balance: $0.356 of real cost left on top of what was spent.
    expect(llm.remainingBudget(u.id)).toBeCloseTo(89 / 250, 6);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('re-running a sync does not double-charge (same window, later window, in parallel)', async () => {
    const u = await member(100);
    llm.spend(u.id, 'cheap', 0.004); // 1 credit
    vm.add(u.id, 600); // 1 credit
    const now = new Date();
    const runs = await Promise.all([1, 2, 3, 4].map(() => syncUsageForUser(u.id, now)));
    expect(runs.map((r) => r.charged).sort()).toEqual([0, 0, 0, 2]);
    expect((await syncUsageForUser(u.id, now)).charged).toBe(0);
    expect((await syncUsageForUser(u.id)).charged).toBe(0); // nothing new since
    expect(await getBalance(u.id)).toBe(98);
    const charges = (await ledgerOf(u.id)).filter((l) => l.reason === 'charge');
    expect(charges).toHaveLength(1);
    expect(
      await db().select().from(usagePeriods).where(eq(usagePeriods.userId, u.id)),
    ).toHaveLength(1);
  });

  it('carries partial 10-minute blocks between syncs', async () => {
    const u = await member(100);
    vm.add(u.id, 300, 0, Date.now() - 1000);
    expect((await syncUsageForUser(u.id)).charged).toBe(0);
    await new Promise((r) => setTimeout(r, 5));
    vm.add(u.id, 300);
    expect((await syncUsageForUser(u.id, new Date(Date.now() + 1))).charged).toBe(1);
  });

  it('splits AI by model: a pro user Claude spend never draws on a cheap-only coupon', async () => {
    const u = await member(0, 'pro');
    await createGrant({
      userId: u.id,
      source: 'coupon',
      amount: 200,
      expiresAt: new Date(Date.now() + 30 * 86400_000),
      cheapModelOnly: true,
      idempotencyKey: `c:${u.id}`,
      description: 'coupon',
    });
    await createGrant({
      userId: u.id,
      source: 'topup',
      amount: 800,
      expiresAt: new Date(Date.now() + 365 * 86400_000),
      idempotencyKey: `t:${u.id}`,
      description: 'topup',
    });
    llm.spend(u.id, 'claude', 0.04); // 10 credits, must come from the top-up
    llm.spend(u.id, 'cheap', 0.02); // 5 credits, from the coupon (expires first)
    await syncUsageForUser(u.id);
    const grants = await db().query.creditGrants.findMany({
      where: (g, { eq }) => eq(g.userId, u.id),
    });
    expect(grants.find((g) => g.source === 'coupon')!.remaining).toBe(195);
    expect(grants.find((g) => g.source === 'topup')!.remaining).toBe(790);
  });

  it('at 0 credits: hasCredits is false, the LiteLLM budget is 0, listeners are told', async () => {
    const depleted: string[] = [];
    const added: string[] = [];
    const off1 = onBalanceDepleted((id) => void depleted.push(id));
    const off2 = onCreditsAdded((id) => void added.push(id));
    try {
      const u = await member(10);
      llm.spend(u.id, 'cheap', 0.048); // 12 credits: a small overrun
      await syncUsageForUser(u.id);
      expect(await getBalance(u.id)).toBe(-2);
      expect(await hasCredits(u.id)).toBe(false);
      expect(llm.remainingBudget(u.id)).toBe(0);
      expect(depleted).toContain(u.id);

      // Credits added (e.g. a coupon): budget raised, overrun recovered, listeners told.
      await createGrant({
        userId: u.id,
        source: 'coupon',
        amount: 200,
        expiresAt: new Date(Date.now() + 30 * 86400_000),
        cheapModelOnly: true,
        idempotencyKey: `c:${u.id}`,
        description: 'coupon',
      });
      await afterCreditsAdded(u.id);
      expect(await getBalance(u.id)).toBe(198);
      expect(await hasCredits(u.id)).toBe(true);
      expect(llm.remainingBudget(u.id)).toBeCloseTo(198 / 250, 6);
      expect(added).toContain(u.id);
    } finally {
      off1();
      off2();
    }
  });

  it('bring-your-own-key users: AI is not charged, awake time is, and AI is not capped', async () => {
    const u = await member(100);
    expect(await setByokKey(u.id, 'openrouter', 'sk-or-good-key-1234', null)).not.toBeNull();
    await refreshBudget(u.id);
    expect(llm.remainingBudget(u.id)).toBeNull();
    llm.spend(u.id, 'cheap', 1); // $1 of AI on their own key
    vm.add(u.id, 600);
    expect((await syncUsageForUser(u.id)).charged).toBe(1);
    expect(await getBalance(u.id)).toBe(99);
  });

  it('the 5-minute job syncs every user with a key; one failure does not stop the rest', async () => {
    const a = await member(100);
    const b = await member(100);
    llm.spend(a.id, 'cheap', 0.004);
    llm.spend(b.id, 'cheap', 0.008);
    const res = await syncAllUsage();
    expect(res.failed).toBe(0);
    expect(await getBalance(a.id)).toBe(99);
    expect(await getBalance(b.id)).toBe(98);
  });
});

describe('reverseTurn (failed turns caused by us are not charged)', () => {
  it('gives back what the turn cost, once', async () => {
    const u = await member(100);
    const startedAt = new Date(Date.now() - 30_000);
    llm.spend(u.id, 'cheap', 0.02, Date.now() - 20_000); // 5 credits inside the turn
    vm.add(u.id, 600, 0, Date.now() - 10_000); // 1 credit inside the turn
    const endedAt = new Date();
    await syncUsageForUser(u.id);
    expect(await getBalance(u.id)).toBe(94);
    const turn = { startedAt, endedAt, idempotencyKey: `turn:${u.id}` };
    expect(await reverseTurn(u.id, turn)).toEqual({ restored: 6 });
    expect(await reverseTurn(u.id, turn)).toEqual({ restored: 0 });
    expect(await getBalance(u.id)).toBe(100);
    const reversals = (await ledgerOf(u.id)).filter((l) => l.reason === 'reversal');
    expect(reversals.reduce((n, r) => n + r.delta, 0)).toBe(6);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('never gives back more than was charged', async () => {
    const u = await member(100);
    const startedAt = new Date(Date.now() - 30_000);
    vm.add(u.id, 600, 0, Date.now() - 10_000);
    await syncUsageForUser(u.id);
    // A second failed turn in the same window can't restore the same credits again.
    await reverseTurn(u.id, { startedAt, endedAt: new Date(), idempotencyKey: 'a' + u.id });
    expect(
      await reverseTurn(u.id, { startedAt, endedAt: new Date(), idempotencyKey: 'b' + u.id }),
    ).toEqual({ restored: 0 });
    expect(await getBalance(u.id)).toBe(100);
  });
});
