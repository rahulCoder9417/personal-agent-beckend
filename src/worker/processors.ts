import { handleBackup } from '../modules/admin/backup.ts';
import { handleHealthCheck } from '../modules/admin/health.ts';
import { handleClerkEvent } from '../modules/auth/jobs.ts';
import { handlePolarEvent, handleExpireCredits, handleSyncUsage } from '../modules/billing/jobs.ts';
import {
  handleAutomationTurn,
  handleComposioTrigger,
  handleRunAutomation,
} from '../modules/automations/jobs.ts';
import { handleSendMessage, handleSendRaw } from '../modules/channels/outbound.ts';
import { handleMessageStatus } from '../modules/channels/status.ts';
import { handleComposioEvent, handleSyncAllowlist } from '../modules/integrations/jobs.ts';
import { expireApprovals, handleProcessApproval } from '../modules/orchestrator/approvals.ts';
import { handleDeleteUser, handleOnboardUser } from '../modules/orchestrator/lifecycle.ts';
import { handleProcessMessage, handleWebMessage } from '../modules/orchestrator/process-message.ts';
import type { Processors } from './runner.ts';
import { handleCleanup } from './schedules.ts';

/** Every job the worker runs, by queue and job name. */
export function processors(): Processors {
  return {
    inbound: {
      'process-message': handleProcessMessage,
      'web-message': handleWebMessage,
      'process-approval': handleProcessApproval,
      'automation-turn': handleAutomationTurn,
      'composio-trigger': handleComposioTrigger,
    },
    scheduled: {
      'run-automation': handleRunAutomation,
    },
    outbound: {
      'send-message': handleSendMessage,
      'send-raw': handleSendRaw,
      'message-status': handleMessageStatus,
    },
    system: {
      'clerk-event': handleClerkEvent,
      'onboard-user': handleOnboardUser,
      'delete-user': handleDeleteUser,
      'sync-allowlist': handleSyncAllowlist,
      'composio-event': handleComposioEvent,
      'expire-approvals': async () => expireApprovals(),
      cleanup: handleCleanup,
      backup: handleBackup,
      'health-check': handleHealthCheck,
      'polar-event': handlePolarEvent,
      'sync-usage': handleSyncUsage,
      'expire-credits': handleExpireCredits,
    },
  };
}
