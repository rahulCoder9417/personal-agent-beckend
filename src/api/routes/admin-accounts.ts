import {
  changeRole,
  deleteAccount,
  resetOnboarding,
  signOutEverywhere,
  suspendAccount,
  unsuspendAccount,
} from '../../modules/admin/accounts.ts';
import type { User } from '../../modules/auth/users.ts';
import { route } from '../router.ts';

/** What the admin tools show of an account: its id, role and status. Nothing else. */
const accountState = (u: User) => ({
  userId: u.id,
  role: u.role,
  status: u.status,
  suspendedAt: u.suspendedAt ? u.suspendedAt.toISOString() : null,
});

// Admin only: the router adds requireAdmin for every operation tagged `admin` in the spec.
// The acting admin is always the signed-in user; the target is the path's user id.
export const adminAccountRoutes = [
  route('adminSetUserRole', async (c, { params, body }) => {
    const { user, changed } = await changeRole(params.userId, body.role, {
      adminId: c.get('user').id,
      reason: body.reason,
    });
    return c.json({ account: accountState(user), changed }, 200);
  }),

  route('adminSuspendUser', async (c, { params, body }) => {
    const r = await suspendAccount(params.userId, {
      adminId: c.get('user').id,
      reason: body.reason,
    });
    return c.json(
      {
        account: accountState(r.user),
        changed: r.changed,
        automationsPaused: r.automationsPaused,
        containerStopped: r.containerStopped,
      },
      200,
    );
  }),

  route('adminUnsuspendUser', async (c, { params, body }) => {
    const r = await unsuspendAccount(params.userId, {
      adminId: c.get('user').id,
      reason: body.reason,
    });
    return c.json(
      {
        account: accountState(r.user),
        changed: r.changed,
        automationsResumed: r.automationsResumed,
        automationsWaitingForCredits: r.automationsWaitingForCredits,
      },
      200,
    );
  }),

  route('adminRevokeUserSessions', async (c, { params, body }) => {
    const revoked = await signOutEverywhere(params.userId, {
      adminId: c.get('user').id,
      reason: body.reason,
    });
    return c.json({ revoked }, 200);
  }),

  route('adminResetUserOnboarding', async (c, { params, body }) => {
    const { user, changed } = await resetOnboarding(params.userId, {
      adminId: c.get('user').id,
      reason: body.reason,
    });
    return c.json(
      {
        userId: user.id,
        onboardingCompletedAt: null,
        gettingStartedDismissedAt: null,
        changed,
      },
      200,
    );
  }),

  route('adminDeleteUser', async (c, { params, body }) => {
    await deleteAccount(params.userId, {
      adminId: c.get('user').id,
      reason: body.reason,
      confirmEmail: body.confirmEmail,
    });
    return c.json({ userId: params.userId, status: 'deleting' as const }, 202);
  }),
];
