import { handleClerkEvent } from '../modules/auth/jobs.ts';
import { handleSendMessage, handleSendRaw } from '../modules/channels/outbound.ts';
import { handleComposioEvent, handleSyncAllowlist } from '../modules/integrations/jobs.ts';
import { expireApprovals, handleProcessApproval } from '../modules/orchestrator/approvals.ts';
import { handleDeleteUser, handleOnboardUser } from '../modules/orchestrator/lifecycle.ts';
import { handleProcessMessage, handleWebMessage } from '../modules/orchestrator/process-message.ts';
import type { Processors } from './runner.ts';

/** Every job the worker runs, by queue and job name. */
export function processors(): Processors {
  return {
    inbound: {
      'process-message': handleProcessMessage,
      'web-message': handleWebMessage,
      'process-approval': handleProcessApproval,
    },
    outbound: {
      'send-message': handleSendMessage,
      'send-raw': handleSendRaw,
    },
    system: {
      'clerk-event': handleClerkEvent,
      'onboard-user': handleOnboardUser,
      'delete-user': handleDeleteUser,
      'sync-allowlist': handleSyncAllowlist,
      'composio-event': handleComposioEvent,
      'expire-approvals': async () => expireApprovals(),
    },
  };
}
