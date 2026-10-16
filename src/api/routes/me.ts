import {
  getUser,
  isValidTimezone,
  notificationSettingsOf,
  updateProfile,
} from '../../modules/auth/users.ts';
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
    const quiet = body.notifications?.quietHours;
    if (quiet?.start !== undefined || quiet?.end !== undefined) {
      // The hours as they will be: one end given, the other kept from the saved settings.
      const saved = notificationSettingsOf((await getUser(user.id)) ?? user).quietHours;
      if ((quiet.start ?? saved.start) === (quiet.end ?? saved.end))
        throw badRequest('Quiet hours must start and end at different times', {
          quietHours: quiet,
        });
    }
    const updated = await updateProfile(user.id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.onboardingCompleted !== undefined
        ? { onboardingCompleted: body.onboardingCompleted }
        : {}),
      ...(body.gettingStartedDismissed !== undefined
        ? { gettingStartedDismissed: body.gettingStartedDismissed }
        : {}),
      ...(body.notifications !== undefined ? { notifications: body.notifications } : {}),
    });
    return c.json(toMe(updated, await getBalanceSummary(user.id)), 200);
  }),
];
