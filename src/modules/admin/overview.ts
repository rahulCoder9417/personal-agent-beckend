// The admin overview (docs/backend-report.md, "Admin tools"): the platform's numbers at a glance.
// Counts only, each asked of the module that owns its table. Two numbers come from outside the
// database: the awake containers (the vm-manager) and the failed jobs (the queues in Redis); when
// one can't be had it is null and the rest still come.
import { userCounts, utcDayStart } from '../auth/users.ts';
import { waitlistCounts } from '../auth/waitlist.ts';
import { creditsSince, monthStart } from '../billing/index.ts';
import { activeUserCount } from '../channels/messages.ts';
import { failedJobCount } from '../events/queues.ts';
import { countOpenApprovals } from '../orchestrator/approvals.ts';
import { countAwakeContainers } from '../orchestrator/sandbox.ts';
import { turnCounts } from '../orchestrator/timings.ts';
import { logger } from '../../shared/logger.ts';

export interface Overview {
  generatedAt: string;
  users: { total: number; newToday: number; new7d: number; active7d: number; deleted: number };
  plans: { free: number; pro: number; max: number };
  turns: { today: number; last7d: number; failedToday: number; failed7d: number };
  containers: { awake: number | null };
  credits: { month: string; granted: number; spent: number };
  approvals: { open: number };
  jobs: { failed: number | null };
  waitlist: { total: number; pending: number };
}

async function failedJobsOrNull(): Promise<number | null> {
  try {
    return await failedJobCount();
  } catch (err) {
    logger().warn({ err: String(err) }, 'failed jobs not counted');
    return null;
  }
}

export async function adminOverview(now = new Date()): Promise<Overview> {
  const day = utcDayStart(now);
  const week = new Date(now.getTime() - 7 * 86400_000);
  const month = monthStart(now);
  const [users, active7d, turns, awake, credits, open, failed, waitlist] = await Promise.all([
    userCounts(now),
    activeUserCount(week),
    turnCounts(day, week),
    countAwakeContainers(),
    creditsSince(month),
    countOpenApprovals(now),
    failedJobsOrNull(),
    waitlistCounts(),
  ]);
  return {
    generatedAt: now.toISOString(),
    users: {
      total: users.total,
      newToday: users.newToday,
      new7d: users.new7d,
      active7d,
      deleted: users.deleted,
    },
    plans: users.plans,
    turns,
    containers: { awake },
    credits: { month: month.toISOString().slice(0, 7), ...credits },
    approvals: { open },
    jobs: { failed },
    waitlist,
  };
}
