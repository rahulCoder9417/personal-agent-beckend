import { notificationSettingsOf, type User } from '../modules/auth/users.ts';
import type { BalanceSummary } from '../modules/billing/balance.ts';
import type { Schemas } from './types.ts';

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);

export function toMe(user: User, credits: BalanceSummary): Schemas['Me'] {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    name: user.name,
    timezone: user.timezone,
    timezoneSet: user.timezoneSet,
    plan: user.plan,
    role: user.role,
    credits: { balance: credits.balance, nextExpiry: iso(credits.nextExpiry) },
    createdAt: user.createdAt.toISOString(),
    onboardingCompletedAt: iso(user.onboardingCompletedAt),
    gettingStartedDismissedAt: iso(user.gettingStartedDismissedAt),
    notifications: notificationSettingsOf(user),
  };
}
