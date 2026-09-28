import type { Job } from 'bullmq';

/** system/onboard-user: sign-up grant (Phase 5), LiteLLM key (Phase 5), sandbox (Phase 3). */
export async function handleOnboardUser(_job: Job): Promise<unknown> {
  return null;
}

/** system/delete-user: delete sandbox + data, revoke LiteLLM key, remove links. */
export async function handleDeleteUser(_job: Job): Promise<unknown> {
  return null;
}
