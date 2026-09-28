import { cleanupLinkCodes } from '../modules/auth/links.ts';
import { cleanupMessages } from '../modules/channels/messages.ts';
import { cleanupEvents } from '../modules/events/cleanup.ts';
import { queue } from '../modules/events/queues.ts';
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

/** system/cleanup (daily): old events and messages, used link codes. */
export async function handleCleanup(): Promise<unknown> {
  const result = {
    events: await cleanupEvents(),
    linkCodes: await cleanupLinkCodes(),
    messages: await cleanupMessages(),
  };
  logger().info(result, 'cleanup done');
  return result;
}
