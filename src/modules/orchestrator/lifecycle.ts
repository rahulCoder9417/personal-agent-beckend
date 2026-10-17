import { Code, ConnectError } from '@connectrpc/connect';
import type { Job } from 'bullmq';
import { deleteUserAudit } from '../admin/audit.ts';
import { deleteUserLinks } from '../auth/links.ts';
import { getActiveUser, scrubDeletedUser } from '../auth/users.ts';
import { deleteUserChannelData } from '../channels/messages.ts';
import { deleteAgentSettings } from './agent-settings.ts';
import { deleteUserApprovals } from './approvals.ts';
import { deleteUserSkipRules } from './skip-rules.ts';
import { deleteAllMemories } from './memory.ts';
import { deleteSandboxRecord, ensureSandbox } from './sandbox.ts';
import { deleteTurnTimings } from './timings.ts';
import { deleteChatEngines } from './turn-context.ts';
import { vm } from './vm.ts';

/** Extra onboarding/offboarding steps from other modules (billing: grant + LiteLLM key). */
export interface LifecycleHooks {
  onboard(userId: string): Promise<void>;
  offboard(userId: string): Promise<void>;
}

let hooks: LifecycleHooks = { onboard: async () => {}, offboard: async () => {} };

export function setLifecycleHooks(h: Partial<LifecycleHooks>): void {
  hooks = { ...hooks, ...h };
}

/** system/onboard-user: sign-up grant + LiteLLM key (billing), then the sandbox. Safe to re-run. */
export async function handleOnboardUser(job: Job): Promise<unknown> {
  const { userId } = job.data as { userId: string };
  if (!(await getActiveUser(userId))) return null;
  await hooks.onboard(userId);
  await ensureSandbox(userId);
  return null;
}

/**
 * system/delete-user: delete the container (with every backup archive of the user's files, which
 * the vm-manager's DeleteSandbox removes too) and the user's data, each module its own tables. Every
 * step is safe to re-run, so a try that failed half-way is simply run again. The steps that ask
 * outside services and can fail (the offboard hook: Polar, LiteLLM, Composio) come after the
 * user's own data, so a failure there holds back as little as possible. The activity log goes
 * last, so a row written by an earlier step does not stay behind.
 */
export async function handleDeleteUser(job: Job): Promise<unknown> {
  const { userId } = job.data as { userId: string };
  try {
    await vm().deleteSandbox({ userId });
  } catch (err) {
    if (!(err instanceof ConnectError && err.code === Code.NotFound)) throw err;
  }
  await deleteSandboxRecord(userId);
  await deleteAgentSettings(userId);
  // Shared memory and the engine each conversation ran on (HLD 0.9).
  await deleteAllMemories(userId);
  await deleteChatEngines(userId);
  await deleteTurnTimings(userId);
  // Approvals, with the exact inputs each one was asked for (an email's recipient, say).
  await deleteUserApprovals(userId);
  // The user's skip rules, with the addresses they hold.
  await deleteUserSkipRules(userId);
  await deleteUserLinks(userId);
  // Messages, files, conversations and each chat's counter.
  await deleteUserChannelData(userId);
  // Billing (LiteLLM key, renewals), own keys, MCP servers, automations, crew jobs, app connections.
  await hooks.offboard(userId);
  // The activity log, with each action's inputs. An admin's record of the deletion stays.
  await deleteUserAudit(userId);
  // Last, the account row itself keeps its id and `deletedAt` but no email, name or time zone.
  await scrubDeletedUser(userId);
  return null;
}
