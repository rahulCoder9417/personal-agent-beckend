// The admin's view of the job queues (docs/backend-report.md, "Admin tools"): list jobs by queue
// and state, count them, run a failed one once more, remove a failed or finished one. Retrying
// does exactly what the queue board's retry button does (BullMQ's own retry), and every job checks
// "already done?" itself, so nothing is done twice. Job data is shown as ids only.
import type { Job } from 'bullmq';
import { conflict, notFound } from '../../shared/errors.ts';
import { QUEUES, queue, type QueueName } from '../events/queues.ts';
import { audit } from './audit.ts';
import { firstLineScrubbed, summarizeJobData } from './redact.ts';

export const JOB_STATES = ['failed', 'waiting', 'active', 'delayed', 'completed'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** BullMQ's lists behind each state. A job waiting with a priority (paid users) is `prioritized`. */
const LISTS: Record<
  JobState,
  Array<'failed' | 'prioritized' | 'waiting' | 'active' | 'delayed' | 'completed'>
> = {
  failed: ['failed'],
  waiting: ['prioritized', 'waiting'],
  active: ['active'],
  delayed: ['delayed'],
  completed: ['completed'],
};

export interface AdminJob {
  id: string;
  queue: QueueName;
  name: string;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  processedAt: string | null;
  finishedAt: string | null;
  dueAt: string | null;
  failedReason: string | null;
  userId: string | null;
  data: Record<string, string | number | string[]>;
  omittedKeys: string[];
}

const iso = (ms: number | undefined | null) => (ms ? new Date(ms).toISOString() : null);

/** When a delayed job is due: BullMQ keeps it as the score in the delayed set (time × 4096). */
async function dueAt(q: QueueName, job: Job): Promise<string | null> {
  try {
    const client = await queue(q).getBackend().client;
    const score = await client.zscore(queue(q).keys.delayed!, job.id!);
    if (score !== null) return iso(Math.floor(Number(score) / 0x1000));
  } catch {
    // Fall back to the job's own delay.
  }
  return iso(job.timestamp + (job.delay ?? 0));
}

async function toAdminJob(job: Job, q: QueueName, state: JobState): Promise<AdminJob> {
  const { data, omittedKeys, userId } = summarizeJobData(job.data);
  return {
    id: job.id!,
    queue: q,
    name: job.name,
    state,
    attempts: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    createdAt: iso(job.timestamp)!,
    processedAt: iso(job.processedOn),
    finishedAt: iso(job.finishedOn),
    dueAt: state === 'delayed' ? await dueAt(q, job) : null,
    failedReason: firstLineScrubbed(job.failedReason),
    userId,
    data,
    omittedKeys,
  };
}

/** The offset a list cursor stands for (the cursor is opaque to callers). */
export function parseJobCursor(cursor: string | undefined): number | null {
  if (!cursor) return 0;
  return /^\d{1,7}$/.test(cursor) ? Number(cursor) : null;
}

/**
 * One page of jobs in `state`, newest first within each list. Without a queue, the four queues are
 * read one after the other, as if they were one list; the cursor is the position in it.
 */
export async function listJobs(opts: {
  queue?: QueueName;
  state: JobState;
  offset: number;
  limit: number;
}): Promise<{ items: AdminJob[]; nextCursor: string | null }> {
  const lists = (opts.queue ? [opts.queue] : [...QUEUES]).flatMap((q) =>
    LISTS[opts.state].map((type) => ({ q, type })),
  );
  const counts = await Promise.all(lists.map((l) => queue(l.q).getJobCountByTypes(l.type)));
  const total = counts.reduce((a, b) => a + b, 0);
  const items: AdminJob[] = [];
  let skip = opts.offset;
  let consumed = 0;
  for (let i = 0; i < lists.length && consumed < opts.limit; i++) {
    const { q, type } = lists[i]!;
    const n = counts[i]!;
    if (skip >= n) {
      skip -= n;
      continue;
    }
    const take = Math.min(opts.limit - consumed, n - skip);
    const jobs = await queue(q).getJobs([type], skip, skip + take - 1, false);
    for (const job of jobs) items.push(await toAdminJob(job, q, opts.state));
    consumed += take;
    skip = 0;
  }
  const next = opts.offset + consumed;
  return { items, nextCursor: consumed > 0 && next < total ? String(next) : null };
}

export type JobCounts = { queue: QueueName } & Record<JobState, number>;

/** How many jobs each queue holds, by state (`waiting` counts the prioritized ones too). */
export async function jobCounts(): Promise<JobCounts[]> {
  return Promise.all(
    QUEUES.map(async (q) => {
      const c = await queue(q).getJobCounts(
        'failed',
        'waiting',
        'prioritized',
        'active',
        'delayed',
        'completed',
      );
      return {
        queue: q,
        failed: c.failed ?? 0,
        waiting: (c.waiting ?? 0) + (c.prioritized ?? 0),
        active: c.active ?? 0,
        delayed: c.delayed ?? 0,
        completed: c.completed ?? 0,
      };
    }),
  );
}

/** A job's state in the admin's words (BullMQ's `prioritized` is waiting). */
function stateWord(state: string): string {
  return state === 'prioritized' || state === 'wait' ? 'waiting' : state;
}

interface JobAction {
  queue: QueueName;
  jobId: string;
  reason: string;
  adminId: string;
}

async function loadJob(q: QueueName, jobId: string): Promise<{ job: Job; state: string }> {
  const job = await queue(q).getJob(jobId);
  if (!job) throw notFound('Job not found');
  return { job, state: stateWord(await job.getState()) };
}

async function auditJob(input: JobAction, job: Job, action: 'job_retried' | 'job_removed') {
  const verb = action === 'job_retried' ? 'Retried' : 'Removed';
  await audit({
    userId: summarizeJobData(job.data).userId,
    actor: 'admin',
    action,
    summary: `${verb} ${input.queue}/${job.name} ${input.jobId}: ${input.reason}`,
    details: {
      adminId: input.adminId,
      queue: input.queue,
      jobId: input.jobId,
      jobName: job.name,
      reason: input.reason,
    },
  });
}

/**
 * Puts a failed job back in line, once more (BullMQ's retry, as the queue board does it; its try
 * count is kept, so the job's own "last try" rules apply to this run). Only a failed job.
 */
export async function retryJob(input: JobAction): Promise<void> {
  const { job, state } = await loadJob(input.queue, input.jobId);
  if (state !== 'failed') throw conflict(`Only a failed job can be retried; this one is ${state}`);
  try {
    await job.retry('failed');
  } catch {
    throw conflict('The job is no longer failed. Read the list again.');
  }
  await auditJob(input, job, 'job_retried');
}

/** Removes a failed or completed job. Never a waiting, delayed or running one. */
export async function removeJob(input: JobAction): Promise<void> {
  const { job, state } = await loadJob(input.queue, input.jobId);
  if (state !== 'failed' && state !== 'completed')
    throw conflict(`Only a failed or completed job can be removed; this one is ${state}`);
  try {
    await job.remove({ removeChildren: false });
  } catch {
    throw conflict('The job is running and cannot be removed. Read the list again.');
  }
  await auditJob(input, job, 'job_removed');
}
