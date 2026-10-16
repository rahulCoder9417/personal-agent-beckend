import { cleanupLinkCodes } from '../modules/auth/links.ts';
import { cleanupWaitlistAttempts } from '../modules/auth/waitlist.ts';
import { cleanupDrafts } from '../modules/automations/drafts.ts';
import { cleanupRuns } from '../modules/automations/runs.ts';
import { cleanupMessages } from '../modules/channels/messages.ts';
import { cleanupEvents } from '../modules/events/cleanup.ts';
import { queue } from '../modules/events/queues.ts';
import { cleanupTurnTimings } from '../modules/orchestrator/timings.ts';
import { logger } from '../shared/logger.ts';

/** Repeating system jobs (idempotent: upserted by id on every worker start). */
export async function registerSystemSchedules(): Promise<void> {
  const system = queue('system');
  await system.upsertJobScheduler(
    'expire-approvals',
    { pattern: '0 * * * *' },
    { name: 'expire-approvals', data: {} },
  );
  await system.upsertJobScheduler(
    'expire-automation-drafts',
    { pattern: '15 * * * *' },
    { name: 'expire-automation-drafts', data: {} },
  );
  await system.upsertJobScheduler(
    'expire-automation-runs',
    { pattern: '20 * * * *' },
    { name: 'expire-automation-runs', data: {} },
  );
  await system.upsertJobScheduler(
    'cleanup',
    { pattern: '30 3 * * *' },
    { name: 'cleanup', data: {} },
  );
  await system.upsertJobScheduler('backup', { pattern: '0 2 * * *' }, { name: 'backup', data: {} });
  await system.upsertJobScheduler(
    'health-check',
    { every: 5 * 60 * 1000 },
    { name: 'health-check', data: {} },
  );
}

/**
 * system/cleanup (daily): old events and messages, used link codes, turn timings past 30 days,
 * automation drafts made more than 30 days ago, the step results of automation runs 2 days after
 * they ended and the runs themselves after 30 days.
 */
export async function handleCleanup(): Promise<unknown> {
  const result = {
    events: await cleanupEvents(),
    linkCodes: await cleanupLinkCodes(),
    messages: await cleanupMessages(),
    waitlistAttempts: await cleanupWaitlistAttempts(),
    turnTimings: await cleanupTurnTimings(),
    automationDrafts: await cleanupDrafts(),
    automationRuns: await cleanupRuns(),
  };
  logger().info(result, 'cleanup done');
  return result;
}
