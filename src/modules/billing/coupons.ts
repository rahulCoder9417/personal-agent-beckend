// Coupon codes (HLD 7.7), followed exactly:
// - codes are 16 random chars from an unambiguous alphabet, shown once, stored only as a hash
// - redeem: rate limit → eligibility → hash lookup → ONE transaction (atomic count, unique
//   (coupon, user), grant, ledger, audit) → raise the LiteLLM budget
// - every failure is the same generic 400 `invalid_or_expired_code`
//
// Model: a `coupons` row is a campaign; its codes are in `coupon_codes`. `codeCount: 1` = one
// shared code with `maxRedemptions` uses; `codeCount > 1` = that many single-use codes, and the
// campaign's `maxRedemptions` still caps the total. One redemption per user per campaign.
import { and, desc, eq, gt, lt, sql } from 'drizzle-orm';
import { randomString, sha256Hex } from '../../shared/crypto.ts';
import { db } from '../../shared/db/client.ts';
import { AppError } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { enforce } from '../../shared/rate-limit.ts';
import { audit } from '../admin/audit.ts';
import { countChannelLinks } from '../auth/links.ts';
import { getActiveUser } from '../auth/users.ts';
import { createGrantInTx, getBalance, revokeGrantsInTx } from './credits.ts';
import { afterCreditsAdded, afterCreditsRemoved } from './enforce.ts';
import { freeCapAllows } from './free-credits.ts';
import type { PlanId } from './plans.ts';
import { couponCodes, couponRedemptions, coupons } from './schema.ts';

export type Coupon = typeof coupons.$inferSelect;

/** No 0/O or 1/I, so codes survive being read aloud or retyped. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_RANDOM_CHARS = 16;

export const REDEEM_LIMITS = {
  perUserPerHour: 5,
  perIpPerHour: 20,
};

/** `AGT-XXXX-XXXX-XXXX-XXXX` (16 random chars = 80 bits, crypto-secure). */
export function generateCouponCode(): string {
  const raw = randomString(CODE_RANDOM_CHARS, CODE_ALPHABET);
  return `AGT-${raw.match(/.{4}/g)!.join('-')}`;
}

/** Case, spaces and dashes don't matter when a user types a code. */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export const hashCouponCode = (code: string) => sha256Hex(normalizeCode(code));
const visiblePrefix = (code: string) => `${code.slice(0, 6)}…`;

export const invalidOrExpiredCode = () =>
  new AppError(400, 'invalid_or_expired_code', 'Invalid or expired code');

// --- admin ------------------------------------------------------------------------------------

export interface CouponCreateInput {
  campaign: string;
  credits: number;
  maxRedemptions: number;
  codeCount?: number;
  expiresAt: Date;
  creditExpiryDays?: number;
  cheapModelOnly?: boolean;
  newUsersOnly?: boolean;
  plans?: PlanId[];
  createdBy: string;
}

/** Returns the plaintext codes: this is the only time they exist outside the admin's hands. */
export async function createCoupon(
  input: CouponCreateInput,
): Promise<{ coupon: Coupon; codes: string[] }> {
  const codeCount = input.codeCount ?? 1;
  const codes = Array.from({ length: codeCount }, generateCouponCode);
  const first = visiblePrefix(codes[0]!);
  const coupon = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(coupons)
      .values({
        id: newId('cpn'),
        campaign: input.campaign,
        codePrefix: codeCount === 1 ? first : `${first} +${codeCount - 1}`,
        credits: input.credits,
        maxRedemptions: input.maxRedemptions,
        codeCount,
        expiresAt: input.expiresAt,
        creditExpiryDays: input.creditExpiryDays ?? 30,
        cheapModelOnly: input.cheapModelOnly ?? true,
        newUsersOnly: input.newUsersOnly ?? false,
        plans: input.plans ?? [],
        createdBy: input.createdBy,
      })
      .returning();
    await tx.insert(couponCodes).values(
      codes.map((code) => ({
        id: newId('cpc'),
        couponId: row!.id,
        codeHash: hashCouponCode(code),
        codePrefix: visiblePrefix(code),
        maxRedemptions: codeCount === 1 ? input.maxRedemptions : 1,
      })),
    );
    await audit(
      {
        userId: null,
        actor: 'admin',
        action: 'coupon_created',
        summary: `Coupon "${input.campaign}": ${codeCount} code(s), ${input.credits} credits each`,
        details: {
          couponId: row!.id,
          adminId: input.createdBy,
          maxRedemptions: input.maxRedemptions,
        },
      },
      tx,
    );
    return row!;
  });
  return { coupon, codes };
}

export async function listCoupons(opts: { cursor?: string; limit: number }) {
  const rows = await db()
    .select()
    .from(coupons)
    .where(opts.cursor ? lt(coupons.id, opts.cursor) : undefined)
    .orderBy(desc(coupons.id))
    .limit(opts.limit + 1);
  const items = rows.slice(0, opts.limit);
  return { items, nextCursor: rows.length > opts.limit ? items[items.length - 1]!.id : null };
}

/**
 * Disable (instantly) or re-enable a campaign. When disabling with `revokeUnspentCredits`, what's
 * left of every grant it gave is removed; otherwise granted credits stay (HLD 7.7).
 */
export async function updateCoupon(
  couponId: string,
  patch: { active: boolean; revokeUnspentCredits?: boolean },
  adminId: string,
): Promise<Coupon | undefined> {
  const { coupon, affected } = await db().transaction(async (tx) => {
    const [row] = await tx
      .update(coupons)
      .set({ active: patch.active, updatedAt: new Date() })
      .where(eq(coupons.id, couponId))
      .returning();
    if (!row) return { coupon: undefined, affected: new Map<string, number>() };
    let revoked = new Map<string, number>();
    if (!patch.active && patch.revokeUnspentCredits) {
      const grants = await tx
        .select({ grantId: couponRedemptions.grantId })
        .from(couponRedemptions)
        .where(eq(couponRedemptions.couponId, couponId));
      revoked = await revokeGrantsInTx(
        tx,
        grants.map((g) => g.grantId),
        `Coupon credits revoked (${row.campaign})`,
      );
    }
    const total = [...revoked.values()].reduce((a, b) => a + b, 0);
    const what = patch.active ? 'enabled' : 'disabled';
    const revokedNote = total ? `, ${total} unspent credits revoked` : '';
    await audit(
      {
        userId: null,
        actor: 'admin',
        action: patch.active ? 'coupon_enabled' : 'coupon_disabled',
        summary: `Coupon "${row.campaign}" ${what}${revokedNote}`,
        details: { couponId, adminId, revokedUsers: revoked.size, revokedCredits: total },
      },
      tx,
    );
    return { coupon: row, affected: revoked };
  });
  for (const userId of affected.keys()) await afterCreditsRemoved(userId);
  return coupon;
}

// --- redeem -----------------------------------------------------------------------------------

export interface RedeemResult {
  creditsAdded: number;
  expiresAt: Date | null;
  cheapModelOnly: boolean;
  balance: number;
}

class Rejected extends Error {}

/**
 * Web app (`POST /v1/coupons/redeem`) or a code sent in chat (`ip` null). Throws 429 when rate
 * limited, and the generic 400 `invalid_or_expired_code` for every other failure.
 */
export async function redeemCoupon(
  input: { userId: string; code: string; ip?: string | null },
  now = new Date(),
): Promise<RedeemResult> {
  // 1. Rate limit: every attempt counts, right or wrong.
  await enforce(
    { key: `redeem:user:${input.userId}`, max: REDEEM_LIMITS.perUserPerHour, windowSeconds: 3600 },
    ...(input.ip
      ? [{ key: `redeem:ip:${input.ip}`, max: REDEEM_LIMITS.perIpPerHour, windowSeconds: 3600 }]
      : []),
  );

  // 2. Eligibility: verified email and at least one linked chat app (stops account farming).
  const user = await getActiveUser(input.userId);
  if (!user?.emailVerified) throw invalidOrExpiredCode();
  if ((await countChannelLinks(user.id)) < 1) throw invalidOrExpiredCode();

  // 3. Hash → an active, unexpired coupon the user qualifies for.
  if (normalizeCode(input.code).length < 8) throw invalidOrExpiredCode();
  const [found] = await db()
    .select({ code: couponCodes, coupon: coupons })
    .from(couponCodes)
    .innerJoin(coupons, eq(coupons.id, couponCodes.couponId))
    .where(eq(couponCodes.codeHash, hashCouponCode(input.code)));
  if (!found) throw invalidOrExpiredCode();
  const { code, coupon } = found;
  if (!coupon.active || coupon.expiresAt <= now) throw invalidOrExpiredCode();
  // "New users only" = the account was created after the campaign started.
  if (coupon.newUsersOnly && user.createdAt < coupon.createdAt) throw invalidOrExpiredCode();
  if (coupon.plans.length && !coupon.plans.includes(user.plan)) throw invalidOrExpiredCode();

  // 4. One transaction; any failure rolls all of it back.
  const expiresAt = new Date(now.getTime() + coupon.creditExpiryDays * 24 * 3600 * 1000);
  try {
    await db().transaction(async (tx) => {
      const [codeOk] = await tx
        .update(couponCodes)
        .set({ redeemedCount: sql`${couponCodes.redeemedCount} + 1` })
        .where(
          and(
            eq(couponCodes.id, code.id),
            lt(couponCodes.redeemedCount, couponCodes.maxRedemptions),
          ),
        )
        .returning({ id: couponCodes.id });
      if (!codeOk) throw new Rejected();
      const [couponOk] = await tx
        .update(coupons)
        .set({ redeemedCount: sql`${coupons.redeemedCount} + 1`, updatedAt: now })
        .where(
          and(
            eq(coupons.id, coupon.id),
            lt(coupons.redeemedCount, coupons.maxRedemptions),
            eq(coupons.active, true),
            gt(coupons.expiresAt, now),
          ),
        )
        .returning({ id: coupons.id });
      if (!couponOk) throw new Rejected();
      if (!(await freeCapAllows(tx, coupon.credits, now))) throw new Rejected();

      const { grant, created } = await createGrantInTx(
        tx,
        {
          userId: user.id,
          source: 'coupon',
          amount: coupon.credits,
          expiresAt,
          cheapModelOnly: coupon.cheapModelOnly,
          ref: coupon.id,
          idempotencyKey: `coupon:${coupon.id}:${user.id}`,
          description: `Coupon: ${coupon.campaign}`,
        },
        now,
      );
      if (!created) throw new Rejected();
      // Unique (coupon, user): a second use is impossible, even in parallel.
      const [redemption] = await tx
        .insert(couponRedemptions)
        .values({
          id: newId('red'),
          couponId: coupon.id,
          codeId: code.id,
          userId: user.id,
          ip: input.ip ?? null,
          grantId: grant.id,
          createdAt: now,
        })
        .onConflictDoNothing({ target: [couponRedemptions.couponId, couponRedemptions.userId] })
        .returning({ id: couponRedemptions.id });
      if (!redemption) throw new Rejected();
      await audit(
        {
          userId: user.id,
          actor: 'user',
          action: 'coupon_redeemed',
          summary: `Redeemed a coupon code: +${coupon.credits} credits`,
          details: { couponId: coupon.id, codePrefix: code.codePrefix, ip: input.ip ?? null },
        },
        tx,
      );
    });
  } catch (err) {
    if (err instanceof Rejected) throw invalidOrExpiredCode();
    throw err;
  }

  // 5. Raise the LiteLLM budget and un-pause anything paused at zero.
  await afterCreditsAdded(user.id);
  return {
    creditsAdded: coupon.credits,
    expiresAt,
    cheapModelOnly: coupon.cheapModelOnly,
    balance: await getBalance(user.id),
  };
}
