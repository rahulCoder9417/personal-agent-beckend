import { handleBackup } from '../modules/admin/backup.ts';
import { handleHealthCheck } from '../modules/admin/health.ts';
import { handleClerkEvent } from '../modules/auth/jobs.ts';
import {
  handleExpireCredits,
  handlePolarEvent,
  handleRefundTurn,
  handleSyncUsage,
} from '../modules/billing/jobs.ts';
import { handleAutoTopUp } from '../modules/billing/auto-topup.ts';
import { handleRememberAccountEmails } from '../modules/billing/email-marks.ts';
import { handleBillTurn } from '../modules/billing/turn-billing.ts';
import {
  handleAutomationTurn,
  handleComposioTrigger,
  handleExpireRuns,
  handleRunApprovalAnswer,
  handleRunAutomation,
} from '../modules/automations/jobs.ts';
import { handleCrewJob, handleCrewRerunAnswer } from '../modules/automations/crew-jobs.ts';
import { expireDrafts } from '../modules/automations/drafts.ts';
import { handleSendMessage, handleSendRaw } from '../modules/channels/outbound.ts';
import { handleSettleApproval } from '../modules/channels/notify.ts';
import { handleMessageStatus } from '../modules/channels/status.ts';
import {
  handleCheckConnection,
  handleSettleConnection,
  handleComposioEvent,
  handleSyncAllowlist,
} from '../modules/integrations/jobs.ts';
import {
  expireApprovals,
  handleProcessApproval,
  handleRunApprovedAction,
  RUN_APPROVED_JOB,
  withApprovalId,
} from '../modules/orchestrator/approvals.ts';
import { handleSyncBrowser } from '../modules/orchestrator/browser.ts';
import { handleDeleteUser, handleOnboardUser } from '../modules/orchestrator/lifecycle.ts';
import { handlePrewarm } from '../modules/orchestrator/prewarm.ts';
import {
  handleApprovalButton,
  handleProcessMessage,
  handleWebMessage,
} from '../modules/orchestrator/process-message.ts';
import type { Processors } from './runner.ts';
import { handleCleanup } from './schedules.ts';

/** Every job the worker runs, by queue and job name. */
export function processors(): Processors {
  return {
    inbound: {
      'process-message': handleProcessMessage,
      'web-message': handleWebMessage,
      // A "run the crew job again" answer starts the job; an answer to a step of an automation's
      // run with steps goes on with the run (or stops it); any other wakes the agent with it.
      'process-approval': async (given) => {
        const job = await withApprovalId(given);
        const rerun = await handleCrewRerunAnswer(job);
        if (rerun !== undefined) return rerun;
        const step = await handleRunApprovalAnswer(job);
        return step === undefined ? handleProcessApproval(job) : step;
      },
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
      'settle-approval': handleSettleApproval,
    },
    system: {
      'clerk-event': handleClerkEvent,
      'onboard-user': handleOnboardUser,
      'delete-user': handleDeleteUser,
      'sync-allowlist': handleSyncAllowlist,
      'sync-browser': handleSyncBrowser,
      prewarm: handlePrewarm,
      'composio-event': handleComposioEvent,
      'check-connection': handleCheckConnection,
      'settle-connection': handleSettleConnection,
      // An approved app action runs at once: this queue never waits for the user's lock.
      [RUN_APPROVED_JOB]: handleRunApprovedAction,
      'approval-button': handleApprovalButton,
      'expire-approvals': async () => expireApprovals(),
      'expire-automation-drafts': async () => expireDrafts(),
      'expire-automation-runs': async () => handleExpireRuns(),
      cleanup: handleCleanup,
      backup: handleBackup,
      'health-check': handleHealthCheck,
      'polar-event': handlePolarEvent,
      'sync-usage': handleSyncUsage,
      'bill-turn': handleBillTurn,
      'refund-turn': handleRefundTurn,
      'expire-credits': handleExpireCredits,
      'remember-account-emails': handleRememberAccountEmails,
      'auto-topup': handleAutoTopUp,
    },
  };
}
