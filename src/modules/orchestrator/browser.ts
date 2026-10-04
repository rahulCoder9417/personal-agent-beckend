// Scout's browser (HLD section 11). It runs inside the user's own container, so the agent image
// and the vm-manager provide it. The platform's part is the switch: on for a user whose plan has
// the browser (Max) while this deployment's image has it, off for everyone else. A container with
// the browser on can reach any public website (HLD 4, 10.3), so the switch is never left on for a
// user who shouldn't have it.
import { Code, ConnectError } from '@connectrpc/connect';
import type { Job } from 'bullmq';
import { config } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { audit } from '../admin/audit.ts';
import { getActiveUser, type PlanId } from '../auth/users.ts';
import { addJob } from '../events/queues.ts';
import { vm } from './vm.ts';

/**
 * Whether a plan includes the browser. Billing plugs in through wiring.ts; until it does, no plan
 * has it.
 */
let planHasBrowser: (plan: PlanId) => boolean = () => false;
export function setBrowserPlanCheck(fn: (plan: PlanId) => boolean): void {
  planHasBrowser = fn;
}

/** The deployed agent image has the browser (`BROWSER_AVAILABLE`). */
export function browserAvailable(): boolean {
  return config().BROWSER_AVAILABLE;
}

/** Should the browser be on for a user on this plan? Both must hold: the image and the plan. */
export function browserWanted(plan: PlanId): boolean {
  return browserAvailable() && planHasBrowser(plan);
}

/**
 * Sends the wanted state to the vm-manager when it differs from what the vm-manager has on
 * record. It takes effect on the container's next wake. Sending the state (not "flip it") makes
 * this safe to repeat. True: the state was changed.
 */
async function applyBrowser(
  userId: string,
  wanted: boolean,
  onRecord: boolean,
  why: string,
): Promise<boolean> {
  if (onRecord === wanted) return false;
  await vm().setBrowser({ userId, enabled: wanted });
  // The user can see when their container was given the open way out, and when it was closed.
  await audit({
    userId,
    actor: 'system',
    action: wanted ? 'browser_enabled' : 'browser_disabled',
    summary: wanted
      ? "Scout's browser switched on (Max plan). It is there from the agent's next start"
      : "Scout's browser switched off",
    details: { why },
  });
  return true;
}

/**
 * Makes the vm-manager's record match the user's plan and the setting. `changed`: it had to be
 * changed. Null: no such user, or no container yet (it is created with the right state). Throws
 * when the vm-manager can't be asked, so a job retries.
 */
export async function syncBrowser(
  userId: string,
  why = 'plan_changed',
): Promise<{ enabled: boolean; changed: boolean } | null> {
  const user = await getActiveUser(userId);
  if (!user) return null;
  const wanted = browserWanted(user.plan);
  let onRecord: boolean;
  try {
    onRecord = (await vm().getSandbox({ userId })).browserEnabled;
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound) return null;
    throw err;
  }
  try {
    return { enabled: wanted, changed: await applyBrowser(userId, wanted, onRecord, why) };
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound) return null;
    throw err;
  }
}

/**
 * The switch as it stands, for a status line: what the plan and the setting say (`wanted`) and
 * what the vm-manager has on record (null: no container, or it can't be asked).
 */
export async function browserStatus(
  userId: string,
  plan: PlanId,
): Promise<{ available: boolean; wanted: boolean; onRecord: boolean | null }> {
  const onRecord = await vm()
    .getSandbox({ userId })
    .then((s) => s.browserEnabled)
    .catch(() => null);
  return { available: browserAvailable(), wanted: browserWanted(plan), onRecord };
}

/** The user's plan changed → check the browser switch (system job, with the queue's retries). */
export async function queueBrowserSync(userId: string): Promise<void> {
  await addJob('system', 'sync-browser', { userId }, { jobId: `browser-${userId}-${Date.now()}` });
}

/** system/sync-browser: worked out again from the user's plan each time it runs. */
export async function handleSyncBrowser(job: Job): Promise<unknown> {
  const { userId } = job.data as { userId: string };
  return syncBrowser(userId);
}

/**
 * After WakeSandbox: the woken sandbox says what the vm-manager has on record. If that is not what
 * the plan and the setting say, the switch is sent again. This catches a job that ran out of
 * tries, a container made before the browser existed, and a change of `BROWSER_AVAILABLE`. It
 * takes effect on the next wake, and never fails the turn.
 */
export async function syncBrowserAfterWake(
  userId: string,
  plan: PlanId,
  sandbox: { browserEnabled?: boolean } | undefined,
): Promise<void> {
  if (!sandbox) return;
  try {
    await applyBrowser(userId, browserWanted(plan), sandbox.browserEnabled ?? false, 'after_wake');
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'browser switch not sent; the next turn retries');
  }
}
