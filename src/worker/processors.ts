import { handleBackup } from '../modules/admin/backup.ts';
import { handleHealthCheck } from '../modules/admin/health.ts';
import { handleClerkEvent } from '../modules/auth/jobs.ts';
import {
  handleExpireCredits,
  handlePolarEvent,
  handleRefundTurn,
  handleSyncUsage,
} from '../modules/billing/jobs.ts';
import { handleBillTurn } from '../modules/billing/turn-billing.ts';
import {
  handleAutomationTurn,
  handleComposioTrigger,
  handleRunAutomation,
} from '../modules/automations/jobs.ts';
import { handleCrewJob } from '../modules/automations/crew-jobs.ts';
import { handleSendMessage, handleSendRaw } from '../modules/channels/outbound.ts';
import { handleMessageStatus } from '../modules/channels/status.ts';
import {
  handleCheckConnection,
  handleSettleConnection,
  handleComposioEvent,
  handleSyncAllowlist,
} from '../modules/integrations/jobs.ts';
import { expireApprovals, handleProcessApproval } from '../modules/orchestrator/approvals.ts';
import { handleSyncBrowser } from '../modules/orchestrator/browser.ts';
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
      'crew-job': handleCrewJob,
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
      'sync-browser': handleSyncBrowser,
      'composio-event': handleComposioEvent,
      'check-connection': handleCheckConnection,
      'settle-connection': handleSettleConnection,
      'expire-approvals': async () => expireApprovals(),
      cleanup: handleCleanup,
      backup: handleBackup,
      'health-check': handleHealthCheck,
      'polar-event': handlePolarEvent,
      'sync-usage': handleSyncUsage,
      'bill-turn': handleBillTurn,
      'refund-turn': handleRefundTurn,
      'expire-credits': handleExpireCredits,
    },
  };
}
