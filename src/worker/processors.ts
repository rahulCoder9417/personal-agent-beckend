import { handleClerkEvent } from '../modules/auth/jobs.ts';
import { handleDeleteUser, handleOnboardUser } from '../modules/orchestrator/lifecycle.ts';
import type { Processors } from './runner.ts';

/** Every job the worker runs, by queue and job name. */
export function processors(): Processors {
  return {
    system: {
      'clerk-event': handleClerkEvent,
      'onboard-user': handleOnboardUser,
      'delete-user': handleDeleteUser,
    },
  };
}
