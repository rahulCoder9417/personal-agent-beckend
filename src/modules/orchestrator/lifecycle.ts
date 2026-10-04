import { Code, ConnectError } from '@connectrpc/connect';
import type { Job } from 'bullmq';
import { deleteUserLinks } from '../auth/links.ts';
import { getActiveUser } from '../auth/users.ts';
import { deleteUserChannelData } from '../channels/messages.ts';
import { deleteAgentSettings } from './agent-settings.ts';
import { deleteAllMemories } from './memory.ts';
import { deleteSandboxRecord, ensureSandbox } from './sandbox.ts';
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
 * system/delete-user: delete the container and data (memories and messages too), revoke the
 * LiteLLM key, remove links.
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
  // Shared memory and the engine each chat ran on (HLD 0.9).
  await deleteAllMemories(userId);
  await deleteChatEngines(userId);
  await hooks.offboard(userId);
  await deleteUserLinks(userId);
  await deleteUserChannelData(userId);
  return null;
}
