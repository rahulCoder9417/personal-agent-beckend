// Account-level admin tools (backend-report.md, "Admin tools"): the role, suspending and lifting a
// suspension, deleting an account, signing a user out everywhere. Each needs a reason and writes
// one activity-log row for the user, with the admin's id and the reason in its details. The user's
// own activity list shows only the neutral summary, never the reason.
import { badRequest, conflict, notFound, unavailable } from '../../shared/errors.ts';
import { db } from '../../shared/db/client.ts';
import { ClerkAdminError, clerkAdmin } from '../auth/clerk-admin.ts';
import { enqueueUserDeletion } from '../auth/provision.ts';
import { getUser, markUserDeleted, setAccountStatus, setRole, type User } from '../auth/users.ts';
import { pauseAllForAdmin, resumeAfterAdmin } from '../automations/automations.ts';
import { hasCredits } from '../billing/index.ts';
import { stopPolitely } from '../orchestrator/sandbox.ts';
import { audit } from './audit.ts';

/** Who acts and why. The reason is required (the contract refuses a blank one). */
export interface AdminAction {
  adminId: string;
  reason: string;
}

/** The account an admin acts on: it exists and is not deleted. */
async function target(userId: string): Promise<User> {
  const user = await getUser(userId);
  if (!user || user.deletedAt) throw notFound('User not found');
  return user;
}

/** Clerk said no: nothing was changed on our side. */
function clerkFailed(err: unknown): never {
  if (err instanceof ClerkAdminError) {
    if (err.kind === 'not_found') throw conflict('Clerk has no such user');
    throw unavailable(
      err.kind === 'not_configured'
        ? 'Clerk is not set up on this server (CLERK_SECRET_KEY). Nothing was changed'
        : 'Clerk could not be reached. Nothing was changed; try again',
    );
  }
  throw err;
}

const details = (a: AdminAction, extra: Record<string, unknown> = {}) => ({
  adminId: a.adminId,
  reason: a.reason.trim(),
  ...extra,
});

/** Who may be suspended or deleted: not yourself, and not an admin (take the role away first). */
function refuseSelfAndAdmins(user: User, a: AdminAction, what: string): void {
  if (user.id === a.adminId) throw conflict(`You can't ${what} your own account`);
  if (user.role === 'admin') throw conflict('Remove the admin role first');
}

/**
 * Sets the role in Clerk (the user's public metadata), then on our row at once, so it applies from
 * the user's next request; Clerk's `user.updated` webhook then carries the same role. Nothing
 * happens when the user already has it. An admin can't remove their own admin role, and a suspended
 * account can't be made an admin.
 */
export async function changeRole(
  userId: string,
  role: User['role'],
  a: AdminAction,
): Promise<{ user: User; changed: boolean }> {
  const user = await target(userId);
  if (user.id === a.adminId && role !== 'admin')
    throw conflict("You can't remove your own admin role");
  if (user.role === role) return { user, changed: false };
  if (role === 'admin' && user.status === 'suspended') throw conflict('Lift the suspension first');
  try {
    await clerkAdmin().setRole(user.clerkId, role);
  } catch (err) {
    clerkFailed(err);
  }
  await db().transaction(async (tx) => {
    await setRole(user.id, role, tx);
    await audit(
      {
        userId: user.id,
        actor: 'admin',
        action: 'role_changed',
        summary:
          role === 'admin'
            ? 'An admin made this account an admin'
            : 'An admin removed the admin role',
        details: details(a, { from: user.role, to: role }),
      },
      tx,
    );
  });
  return { user: { ...user, role }, changed: true };
}

/**
 * Suspends the account: from now on every signed-in call is refused, chat messages are saved but
 * not answered, the container's calls to the platform are refused and it is not woken. Its
 * automations are paused (reason `admin`) and the container is stopped politely through the
 * vm-manager. Again on a suspended account: no second log row, but the pause and the stop are tried
 * again. `containerStopped` is false when the vm-manager refused (a turn runs): the idle stop does
 * it later.
 */
export async function suspendAccount(
  userId: string,
  a: AdminAction,
): Promise<{ user: User; changed: boolean; automationsPaused: number; containerStopped: boolean }> {
  const user = await target(userId);
  refuseSelfAndAdmins(user, a, 'suspend');
  const res = await db().transaction(async (tx) => {
    const r = await setAccountStatus(user.id, 'suspended', tx);
    if (r?.changed)
      await audit(
        {
          userId: user.id,
          actor: 'admin',
          action: 'account_suspended',
          summary: 'An admin suspended this account',
          details: details(a),
        },
        tx,
      );
    return r;
  });
  if (!res) throw notFound('User not found');
  const automationsPaused = await pauseAllForAdmin(user.id);
  const stop = await stopPolitely(user.id, 'account suspended');
  return { ...res, automationsPaused, containerStopped: stop !== 'refused' };
}

/**
 * Lifts the suspension: the account works again at once, and the automations the suspension paused
 * come back (on with credits, else paused for lack of credits). The container wakes with the next
 * message. On an active account nothing changes and no row is written.
 */
export async function unsuspendAccount(
  userId: string,
  a: AdminAction,
): Promise<{
  user: User;
  changed: boolean;
  automationsResumed: number;
  automationsWaitingForCredits: number;
}> {
  const user = await target(userId);
  const res = await db().transaction(async (tx) => {
    const r = await setAccountStatus(user.id, 'active', tx);
    if (r?.changed)
      await audit(
        {
          userId: user.id,
          actor: 'admin',
          action: 'account_unsuspended',
          summary: 'An admin lifted the suspension of this account',
          details: details(a),
        },
        tx,
      );
    return r;
  });
  if (!res) throw notFound('User not found');
  const back = await resumeAfterAdmin(user.id, await hasCredits(user.id));
  return {
    ...res,
    automationsResumed: back.resumed,
    automationsWaitingForCredits: back.waitingForCredits,
  };
}

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Deletes the account the way a user's own deletion goes: the user is deleted in Clerk first, then
 * marked deleted here and the deletion job runs (container, data, keys, subscription). Clerk's
 * `user.deleted` webhook that follows finds it deleted already. `confirmEmail` must be the user's
 * email. The log row keeps the admin's id, the user's id and the reason; never the email or name.
 */
export async function deleteAccount(
  userId: string,
  a: AdminAction & { confirmEmail: string },
): Promise<void> {
  const user = await target(userId);
  refuseSelfAndAdmins(user, a, 'delete');
  if (!user.email || !sameEmail(a.confirmEmail, user.email))
    throw badRequest("`confirmEmail` is not this user's email", { field: 'confirmEmail' });
  let deletedInClerk = true;
  try {
    await clerkAdmin().deleteUser(user.clerkId);
  } catch (err) {
    // Clerk no longer has the user (an earlier try got that far): our side still has to follow.
    if (err instanceof ClerkAdminError && err.kind === 'not_found') deletedInClerk = false;
    else clerkFailed(err);
  }
  const marked = await markUserDeleted(user.clerkId);
  if (marked || deletedInClerk)
    await audit({
      userId: user.id,
      actor: 'admin',
      action: 'account_deleted',
      summary: 'An admin deleted this account',
      details: details(a),
    });
  // One job per user (its id holds the user id), also when Clerk's webhook adds it too.
  await enqueueUserDeletion(user.id);
}

/**
 * Ends every active Clerk session of the user. A token the browser already holds still works
 * until it expires (about a minute): the api checks tokens without asking Clerk.
 */
export async function signOutEverywhere(userId: string, a: AdminAction): Promise<number> {
  const user = await target(userId);
  let revoked = 0;
  try {
    revoked = await clerkAdmin().revokeSessions(user.clerkId);
  } catch (err) {
    if (!(err instanceof ClerkAdminError && err.kind === 'not_found')) clerkFailed(err);
  }
  await audit({
    userId: user.id,
    actor: 'admin',
    action: 'sessions_revoked',
    summary: 'An admin signed this account out everywhere',
    details: details(a, { revoked }),
  });
  return revoked;
}
