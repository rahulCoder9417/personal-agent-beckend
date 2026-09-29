import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import {
  CODE_ALPHABET,
  createCoupon,
  hashCouponCode,
  redeemCoupon,
  updateCoupon,
  type CouponCreateInput,
} from '../src/modules/billing/coupons.ts';
import {
  charge,
  createGrant,
  expireDueGrants,
  getBalance,
} from '../src/modules/billing/credits.ts';
import { freeCreditStats } from '../src/modules/billing/free-credits.ts';
import { ensureLiteLLMKey } from '../src/modules/billing/litellm.ts';
import { couponCodes, couponRedemptions, coupons } from '../src/modules/billing/schema.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { AppError } from '../src/shared/errors.ts';
import { installFakes } from './billing-fakes.ts';
import { DAY, grantsOf, ledgerOf, linkChat } from './billing-helpers.ts';
import { createUser } from './helpers.ts';

const { llm } = installFakes();

const ip = () =>
  `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function eligible(overrides: Parameters<typeof createUser>[0] = {}) {
  const u = await createUser(overrides);
  await linkChat(u.id);
  return u;
}

async function campaign(overrides: Partial<CouponCreateInput> = {}) {
  const admin = await createUser({ role: 'admin' });
  return createCoupon({
    campaign: `test ${randomUUID().slice(0, 8)}`,
    credits: 200,
    maxRedemptions: 20,
    expiresAt: new Date(Date.now() + 7 * DAY),
    createdBy: admin.id,
    ...overrides,
  });
}

/** Resolves to the error code (or 'ok'). */
async function attempt(userId: string, code: string, fromIp: string | null = ip(), now?: Date) {
  try {
    await redeemCoupon({ userId, code, ip: fromIp }, now);
    return 'ok';
  } catch (err) {
    if (err instanceof AppError) return `${err.status}:${err.code}:${err.message}`;
    throw err;
  }
}

const GENERIC = '400:invalid_or_expired_code:Invalid or expired code';

describe('coupons: admin create', () => {
  it('generates AGT-XXXX-XXXX-XXXX-XXXX codes (16 unambiguous random chars), stores only hashes', async () => {
    const { coupon, codes } = await campaign({ codeCount: 5, maxRedemptions: 5 });
    expect(codes).toHaveLength(5);
    const re = new RegExp(`^AGT(-[${CODE_ALPHABET}]{4}){4}$`);
    for (const code of codes) {
      expect(code).toMatch(re);
      expect(code).not.toMatch(/[01OI]/);
    }
    expect(new Set(codes).size).toBe(5);
    const rows = await db().select().from(couponCodes).where(eq(couponCodes.couponId, coupon.id));
    expect(rows.map((r) => r.codeHash).sort()).toEqual(codes.map(hashCouponCode).sort());
    expect(JSON.stringify(rows)).not.toContain(codes[0]!.slice(4));
    expect(rows.every((r) => r.maxRedemptions === 1)).toBe(true);
    expect(coupon.codePrefix).toMatch(/^AGT-[A-Z2-9]{2}… \+4$/);
  });
});

describe('coupons: redeem (HLD 7.7)', () => {
  it('adds the credits (90-day expiry, cheap-model only), raises the budget, audits it', async () => {
    const u = await eligible();
    await ensureLiteLLMKey(u.id);
    const { codes } = await campaign();
    const from = ip();
    const before = Date.now();
    const res = await redeemCoupon({ userId: u.id, code: codes[0]!.toLowerCase(), ip: from });
    expect(res.creditsAdded).toBe(200);
    expect(res.cheapModelOnly).toBe(true);
    expect(res.balance).toBe(200);
    expect(res.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 90 * DAY);
    expect(res.expiresAt!.getTime()).toBeLessThan(Date.now() + 90 * DAY + 1000);
    expect(llm.remainingBudget(u.id)).toBeCloseTo(200 / 250, 6);
    const [grant] = await grantsOf(u.id);
    expect(grant).toMatchObject({ source: 'coupon', amount: 200, cheapModelOnly: true });
    expect((await ledgerOf(u.id)).map((l) => l.reason)).toEqual(['grant']);
    const audits = await db().select().from(auditLog).where(eq(auditLog.userId, u.id));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: 'user', action: 'coupon_redeemed' });
    expect(audits[0]!.details).toMatchObject({ ip: from });
  });

  it('a second redemption by the same user fails with the generic message', async () => {
    const u = await eligible();
    const { codes } = await campaign();
    expect(await attempt(u.id, codes[0]!)).toBe('ok');
    expect(await attempt(u.id, codes[0]!)).toBe(GENERIC);
    // Even in parallel.
    const v = await eligible();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => attempt(v.id, codes[0]!)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(await getBalance(v.id)).toBe(200);
  });

  it('the (max+1)th redemption fails even with 50 parallel attempts', async () => {
    const { coupon, codes } = await campaign({ maxRedemptions: 20 });
    const users = await Promise.all(Array.from({ length: 50 }, () => eligible()));
    const results = await Promise.all(users.map((u) => attempt(u.id, codes[0]!)));
    expect(results.filter((r) => r === 'ok')).toHaveLength(20);
    expect(results.filter((r) => r === GENERIC)).toHaveLength(30);
    const [row] = await db().select().from(coupons).where(eq(coupons.id, coupon.id));
    expect(row!.redeemedCount).toBe(20);
    const redemptions = await db()
      .select()
      .from(couponRedemptions)
      .where(eq(couponRedemptions.couponId, coupon.id));
    expect(redemptions).toHaveLength(20);
    // Credits were granted exactly to the 20 winners.
    const balances = await Promise.all(users.map((u) => getBalance(u.id)));
    expect(balances.filter((b) => b === 200)).toHaveLength(20);
    expect(balances.filter((b) => b === 0)).toHaveLength(30);
  });

  it('wrong, expired and disabled codes all fail with the same generic message', async () => {
    const u = await eligible();
    expect(await attempt(u.id, 'AGT-ZZZZ-ZZZZ-ZZZZ-ZZZZ')).toBe(GENERIC);
    const expired = await campaign({ expiresAt: new Date(Date.now() + 60_000) });
    const later = new Date(Date.now() + 120_000);
    expect(await attempt(u.id, expired.codes[0]!, ip(), later)).toBe(GENERIC);
    const disabled = await campaign();
    const admin = await createUser({ role: 'admin' });
    await updateCoupon(disabled.coupon.id, { active: false }, admin.id);
    expect(await attempt(u.id, disabled.codes[0]!)).toBe(GENERIC);
    expect(await getBalance(u.id)).toBe(0);
  });

  it('unverified users and users without a linked chat app cannot redeem', async () => {
    const { codes } = await campaign();
    const unverified = await eligible({ emailVerified: false });
    expect(await attempt(unverified.id, codes[0]!)).toBe(GENERIC);
    const unlinked = await createUser();
    expect(await attempt(unlinked.id, codes[0]!)).toBe(GENERIC);
    expect(await getBalance(unverified.id)).toBe(0);
    expect(await getBalance(unlinked.id)).toBe(0);
  });

  it('rate limit: 5 attempts per user per hour, wrong codes count too', async () => {
    const u = await eligible();
    const { codes } = await campaign();
    for (let i = 0; i < 5; i++)
      expect(await attempt(u.id, `AGT-WRNG-${i}AAA-BBBB-CCCC`)).toBe(GENERIC);
    // The 6th is refused before the code is even looked at — a right code too.
    expect(await attempt(u.id, codes[0]!)).toMatch(/^429:rate_limited:/);
  });

  it('rate limit: 20 attempts per IP per hour, across accounts', async () => {
    const shared = ip();
    const users = await Promise.all(Array.from({ length: 21 }, () => eligible()));
    const results = [];
    for (const u of users) results.push(await attempt(u.id, 'AGT-NOPE-NOPE-NOPE-NOPE', shared));
    expect(results.slice(0, 20).every((r) => r === GENERIC)).toBe(true);
    expect(results[20]).toMatch(/^429:rate_limited:/);
  });

  it('coupon credits expire after 90 days and pay only for the cheap model', async () => {
    const u = await eligible({ plan: 'pro' });
    await createGrant({
      userId: u.id,
      source: 'topup',
      amount: 800,
      // Outlives the coupon, so only the coupon expires below.
      expiresAt: new Date(Date.now() + 120 * DAY),
      idempotencyKey: `t:${u.id}`,
      description: 'topup',
    });
    const { codes } = await campaign();
    expect(await attempt(u.id, codes[0]!)).toBe('ok');
    const usage = { cheapAi: 0, otherAi: 50, awake: 0, browser: 0, tools: 0 };
    await charge(u.id, usage, { idempotencyKey: `claude:${u.id}`, description: 'Claude' });
    let coupon = (await grantsOf(u.id)).find((g) => g.source === 'coupon')!;
    expect(coupon.remaining).toBe(200); // Claude usage came from the top-up
    await charge(
      u.id,
      { ...usage, otherAi: 0, cheapAi: 30 },
      {
        idempotencyKey: `cheap:${u.id}`,
        description: 'cheap',
      },
    );
    coupon = (await grantsOf(u.id)).find((g) => g.source === 'coupon')!;
    expect(coupon.remaining).toBe(170);

    expect(await getBalance(u.id, new Date(Date.now() + 89 * DAY))).toBe(920);
    const day91 = new Date(Date.now() + 91 * DAY);
    expect(await getBalance(u.id, day91)).toBe(750);
    expect(await expireDueGrants(day91)).toContain(u.id);
    const expired = (await ledgerOf(u.id)).filter((l) => l.reason === 'expire');
    expect(expired.map((e) => e.delta)).toEqual([-170]);
  });

  it('single-use codes: each works once; one redemption per user per campaign', async () => {
    const { codes } = await campaign({ codeCount: 3, maxRedemptions: 3 });
    const [a, b, c] = await Promise.all([eligible(), eligible(), eligible()]);
    expect(await attempt(a!.id, codes[0]!)).toBe('ok');
    expect(await attempt(b!.id, codes[0]!)).toBe(GENERIC); // used
    expect(await attempt(a!.id, codes[1]!)).toBe(GENERIC); // same campaign
    expect(await attempt(b!.id, codes[1]!)).toBe('ok');
    expect(await attempt(c!.id, codes[2]!)).toBe('ok');
  });

  it('new-users-only and plan-restricted coupons', async () => {
    const old = await eligible();
    const onlyNew = await campaign({ newUsersOnly: true });
    expect(await attempt(old.id, onlyNew.codes[0]!)).toBe(GENERIC);
    const fresh = await eligible();
    expect(await attempt(fresh.id, onlyNew.codes[0]!)).toBe('ok');

    const proOnly = await campaign({ plans: ['pro', 'max'] });
    expect(await attempt(fresh.id, proOnly.codes[0]!)).toBe(GENERIC);
    const pro = await eligible({ plan: 'pro' });
    expect(await attempt(pro.id, proOnly.codes[0]!)).toBe('ok');
  });

  it('disabling can revoke unspent credits; without revoke, granted credits stay', async () => {
    const admin = await createUser({ role: 'admin' });
    const keep = await campaign();
    const revoke = await campaign();
    const u = await eligible();
    // Redeemed first, so it expires first and pays for the spend below.
    expect(await attempt(u.id, revoke.codes[0]!)).toBe('ok');
    expect(await attempt(u.id, keep.codes[0]!)).toBe('ok');
    await charge(
      u.id,
      { cheapAi: 50, otherAi: 0, awake: 0, browser: 0, tools: 0 },
      { idempotencyKey: `spend:${u.id}`, description: 'spend' },
    );
    expect(await getBalance(u.id)).toBe(350);
    await updateCoupon(keep.coupon.id, { active: false }, admin.id);
    expect(await getBalance(u.id)).toBe(350);
    const updated = await updateCoupon(
      revoke.coupon.id,
      { active: false, revokeUnspentCredits: true },
      admin.id,
    );
    expect(updated!.active).toBe(false);
    const left = (await grantsOf(u.id)).map((g) => g.remaining).sort((x, y) => x - y);
    expect(left).toEqual([0, 200]);
    expect(await getBalance(u.id)).toBe(200);
  });

  it('the free-credit monthly cap blocks redemptions once reached', async () => {
    const stats = await freeCreditStats();
    process.env.FREE_CREDITS_MONTHLY_CAP = String(stats.signupCredits + stats.couponCredits + 200);
    resetConfig();
    try {
      const { codes } = await campaign();
      const [a, b] = await Promise.all([eligible(), eligible()]);
      expect(await attempt(a!.id, codes[0]!)).toBe('ok');
      expect(await attempt(b!.id, codes[0]!)).toBe(GENERIC);
      expect((await freeCreditStats()).capReached).toBe(true);
    } finally {
      delete process.env.FREE_CREDITS_MONTHLY_CAP;
      resetConfig();
    }
  });

  it('abuse signal: many accounts redeeming from one IP are flagged for the admin', async () => {
    const shared = ip();
    const { codes } = await campaign();
    const users = await Promise.all([eligible(), eligible(), eligible()]);
    for (const u of users) expect(await attempt(u.id, codes[0]!, shared)).toBe('ok');
    const flag = (await freeCreditStats()).abuseFlags.find((f) => f.ip === shared);
    expect(flag?.redemptions).toBe(3);
    expect(flag?.userIds.sort()).toEqual(users.map((u) => u.id).sort());
  });
});
