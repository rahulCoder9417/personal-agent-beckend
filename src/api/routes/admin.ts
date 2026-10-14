import { adminOverview } from '../../modules/admin/overview.ts';
import { adminUserDetail, adminUserPage } from '../../modules/admin/users.ts';
import { getUser } from '../../modules/auth/users.ts';
import { adjustCredits, setPlanByHand } from '../../modules/billing/admin.ts';
import { createCoupon, listCoupons, updateCoupon } from '../../modules/billing/coupons.ts';
import { getBalance, listBalanceGrants } from '../../modules/billing/credits.ts';
import { freeCreditStats } from '../../modules/billing/free-credits.ts';
import { creditExpiry } from '../../modules/billing/plans.ts';
import { getCurrentSubscription } from '../../modules/billing/subscriptions.ts';
import { badRequest, conflict, notFound } from '../../shared/errors.ts';
import { toAdminUser, toAdminUserDetail } from '../admin-presenters.ts';
import { toBalance, toCoupon, toSubscription } from '../billing-presenters.ts';
import { route } from '../router.ts';

// Admin only: the router adds requireAdmin for every operation tagged `admin` in the spec.
export const adminRoutes = [
  route('adminListCoupons', async (c, { query }) => {
    const page = await listCoupons({
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit ?? 30,
    });
    return c.json({ items: page.items.map(toCoupon), nextCursor: page.nextCursor }, 200);
  }),

  // The plaintext codes are in this response only; the database keeps hashes.
  route('adminCreateCoupon', async (c, { body }) => {
    const expiresAt = new Date(body.expiresAt);
    if (expiresAt <= new Date()) throw badRequest('`expiresAt` must be in the future');
    const { coupon, codes } = await createCoupon({
      campaign: body.campaign,
      credits: body.credits,
      maxRedemptions: body.maxRedemptions,
      codeCount: body.codeCount ?? 1,
      expiresAt,
      creditExpiryDays: body.creditExpiryDays ?? 30,
      cheapModelOnly: body.cheapModelOnly ?? true,
      newUsersOnly: body.newUsersOnly ?? false,
      plans: body.plans ?? [],
      createdBy: c.get('user').id,
    });
    return c.json({ coupon: toCoupon(coupon), codes }, 201);
  }),

  route('adminUpdateCoupon', async (c, { params, body }) => {
    const coupon = await updateCoupon(
      params.couponId,
      { active: body.active, revokeUnspentCredits: body.revokeUnspentCredits ?? false },
      c.get('user').id,
    );
    if (!coupon) throw notFound('Coupon not found');
    return c.json(toCoupon(coupon), 200);
  }),

  route('adminAdjustCredits', async (c, { params, body }) => {
    const user = await getUser(params.userId);
    if (!user) throw notFound('User not found');
    if (body.amount === 0) throw badRequest('`amount` must not be 0');
    await adjustCredits({
      userId: user.id,
      amount: body.amount,
      reason: body.reason,
      // Omitted: 90 days like every grant; explicit null: never expires (admin's choice).
      expiresAt:
        body.expiresAt === undefined
          ? creditExpiry()
          : body.expiresAt
            ? new Date(body.expiresAt)
            : null,
      idempotencyKey: body.idempotencyKey,
      adminId: c.get('user').id,
    });
    const now = new Date();
    const [balance, grants] = await Promise.all([
      getBalance(user.id, now),
      listBalanceGrants(user.id, now),
    ]);
    return c.json(toBalance(balance, grants), 200);
  }),

  route('adminFreeCreditStats', async (c) => c.json(await freeCreditStats(), 200)),

  // Counts only: no name, email, id or text.
  route('adminOverview', async (c) => c.json(await adminOverview(), 200)),

  route('adminListUsers', async (c, { query }) => {
    const page = await adminUserPage({
      ...(query.query ? { query: query.query } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit ?? 30,
    });
    return c.json({ items: page.items.map(toAdminUser), nextCursor: page.nextCursor }, 200);
  }),

  route('adminGetUser', async (c, { params }) => {
    const detail = await adminUserDetail(params.userId);
    if (!detail) throw notFound('User not found');
    return c.json(toAdminUserDetail(detail), 200);
  }),

  // The plan by hand: the same steps as the ops script's `plan`, audited with the admin's id.
  route('adminUpdateUser', async (c, { params, body }) => {
    const user = await getUser(params.userId);
    if (!user) throw notFound('User not found');
    if (user.deletedAt) throw conflict('This account is deleted');
    const { changed } = await setPlanByHand({
      userId: user.id,
      from: user.plan,
      plan: body.plan,
      adminId: c.get('user').id,
      ...(body.reason ? { reason: body.reason } : {}),
    });
    const sub = await getCurrentSubscription(user.id);
    return c.json(
      {
        userId: user.id,
        plan: body.plan,
        previousPlan: user.plan,
        changed,
        // The subscription's own plan: one that still runs can set it again at its next event.
        subscription: toSubscription(sub?.plan ?? body.plan, sub),
      },
      200,
    );
  }),
];
