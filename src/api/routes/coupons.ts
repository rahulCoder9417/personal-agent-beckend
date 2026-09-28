import { redeemCoupon } from '../../modules/billing/coupons.ts';
import { toRedemption } from '../billing-presenters.ts';
import { clientIp } from '../client-ip.ts';
import { route } from '../router.ts';

export const couponRoutes = [
  // Every failure is the same 400 invalid_or_expired_code (HLD 7.7); 429 when rate limited.
  route('redeemCoupon', async (c, { body }) => {
    const result = await redeemCoupon({
      userId: c.get('user').id,
      code: body.code,
      ip: clientIp(c),
    });
    return c.json(toRedemption(result), 200);
  }),
];
