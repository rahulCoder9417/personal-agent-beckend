import { listAuditAll, type AuditEntry } from '../../modules/admin/audit.ts';
import { configView } from '../../modules/admin/config-view.ts';
import { healthReport } from '../../modules/admin/health.ts';
import {
  jobCounts,
  listJobs,
  parseJobCursor,
  removeJob,
  retryJob,
} from '../../modules/admin/jobs.ts';
import { redactDetails, scrubText } from '../../modules/admin/redact.ts';
import { timingsSummary } from '../../modules/orchestrator/timings-summary.ts';
import { badRequest } from '../../shared/errors.ts';
import { route } from '../router.ts';

// Admin only: the router adds requireAdmin for every operation tagged `admin` in the spec.
// Operations: the job queues, the audit log, turn timings, the settings and the health of the
// services. No secret is ever in an answer (see modules/admin/redact.ts and config-view.ts).

/** Every admin action needs a reason, which goes to the audit log. */
function reasonOf(raw: string): string {
  const reason = raw.trim();
  if (!reason) throw badRequest('`reason` must not be empty');
  return reason;
}

const toAdminAudit = (row: AuditEntry) => ({
  id: row.id,
  userId: row.userId,
  actor: row.actor,
  action: row.action,
  summary: scrubText(row.summary),
  details: row.details ? (redactDetails(row.details) as Record<string, unknown>) : null,
  creditsCharged: row.creditsCharged,
  createdAt: row.createdAt.toISOString(),
});

export const adminOpsRoutes = [
  route('adminListJobs', async (c, { query }) => {
    const offset = parseJobCursor(query.cursor);
    if (offset === null) throw badRequest('Invalid cursor');
    const page = await listJobs({
      ...(query.queue ? { queue: query.queue } : {}),
      state: query.state ?? 'failed',
      offset,
      limit: query.limit ?? 30,
    });
    return c.json(page, 200);
  }),

  route('adminJobCounts', async (c) => c.json({ queues: await jobCounts() }, 200)),

  route('adminRetryJob', async (c, { params, body }) => {
    await retryJob({
      queue: params.queue,
      jobId: params.jobId,
      reason: reasonOf(body.reason),
      adminId: c.get('user').id,
    });
    return c.body(null, 204);
  }),

  route('adminRemoveJob', async (c, { params, body }) => {
    await removeJob({
      queue: params.queue,
      jobId: params.jobId,
      reason: reasonOf(body.reason),
      adminId: c.get('user').id,
    });
    return c.body(null, 204);
  }),

  route('adminListAudit', async (c, { query }) => {
    const page = await listAuditAll({
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.actor ? { actor: query.actor } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.from ? { from: new Date(query.from) } : {}),
      ...(query.to ? { to: new Date(query.to) } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
      limit: query.limit ?? 30,
    });
    return c.json({ items: page.items.map(toAdminAudit), nextCursor: page.nextCursor }, 200);
  }),

  route('adminTimingsSummary', async (c, { query }) =>
    c.json(await timingsSummary(query.days ?? 7), 200),
  ),

  route('adminGetConfig', async (c) => c.json(await configView(), 200)),

  route('adminGetHealth', async (c) => c.json(await healthReport(), 200)),
];
