import { handleClerkEvent } from '../modules/auth/jobs.ts';
import { handleSendMessage, handleSendRaw } from '../modules/channels/outbound.ts';
import { handleDeleteUser, handleOnboardUser } from '../modules/orchestrator/lifecycle.ts';
import { handleProcessMessage, handleWebMessage } from '../modules/orchestrator/process-message.ts';
import type { Processors } from './runner.ts';

/** Every job the worker runs, by queue and job name. */
export function processors(): Processors {
  return {
    inbound: {
      'process-message': handleProcessMessage,
      'web-message': handleWebMessage,
    },
    outbound: {
      'send-message': handleSendMessage,
      'send-raw': handleSendRaw,
    },
    system: {
      'clerk-event': handleClerkEvent,
      'onboard-user': handleOnboardUser,
      'delete-user': handleDeleteUser,
    },
  };
}
