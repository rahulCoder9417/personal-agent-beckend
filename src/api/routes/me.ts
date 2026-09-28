import { isValidTimezone, updateProfile } from '../../modules/auth/users.ts';
import { getBalanceSummary } from '../../modules/billing/balance.ts';
import { badRequest } from '../../shared/errors.ts';
import { toMe } from '../presenters.ts';
import { route } from '../router.ts';

export const meRoutes = [
  route('getMe', async (c) => {
    const user = c.get('user');
    return c.json(toMe(user, await getBalanceSummary(user.id)), 200);
  }),

  route('updateMe', async (c, { body }) => {
    const user = c.get('user');
    if (body.timezone !== undefined && !isValidTimezone(body.timezone)) {
      throw badRequest('Unknown timezone', { timezone: body.timezone });
    }
    const updated = await updateProfile(user.id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
    });
    return c.json(toMe(updated, await getBalanceSummary(user.id)), 200);
  }),
];
