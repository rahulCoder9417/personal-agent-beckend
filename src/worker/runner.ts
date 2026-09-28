import { DelayedError, Worker, type Job } from 'bullmq';
import { alert } from '../modules/admin/alerts.ts';
import { inc } from '../modules/admin/metrics.ts';
import { markEvent } from '../modules/events/intake.ts';
import { QUEUES, RETRY_DELAYS_MS, type QueueName } from '../modules/events/queues.ts';
import { acquireUserLock, releaseUserLock } from '../modules/orchestrator/lock.ts';
import { config } from '../shared/config.ts';
import { logger } from '../shared/logger.ts';
import { createRedis } from '../shared/redis.ts';
import { IGNORED } from './ignored.ts';

export { IGNORED };

export type JobHandler = (job: Job) => Promise<unknown>;
export type Processors = Partial<Record<QueueName, Record<string, JobHandler>>>;

export interface RunnerOptions {
  concurrency?: Partial<Record<QueueName, number>>;
  retryDelaysMs?: number[];
  /** A busy user's job is pushed back this long (HLD 0.2: 2 s). */
  busyDelayMs?: number;
  /** Queues whose jobs take the per-user lock. */
  lockedQueues?: QueueName[];
}

const DEFAULT_CONCURRENCY: Record<QueueName, number> = {
  inbound: 20,
  outbound: 20,
  scheduled: 5,
  system: 5,
};

export function startWorkers(processors: Processors, opts: RunnerOptions = {}): Worker[] {
  const retry = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const busyDelay = opts.busyDelayMs ?? 2000;
  const locked = new Set(opts.lockedQueues ?? ['inbound']);
  const log = logger();

  return QUEUES.filter((q) => processors[q]).map((queueName) => {
    const handlers = processors[queueName]!;
    const worker = new Worker(
      queueName,
      async (job, token) => {
        const handler = handlers[job.name];
        if (!handler) throw new Error(`no handler for ${queueName}/${job.name}`);
        const userId = (job.data as { userId?: string | null }).userId;
        let lockToken: string | null = null;
        if (locked.has(queueName) && userId) {
          lockToken = await acquireUserLock(userId);
          if (!lockToken) {
            await job.moveToDelayed(Date.now() + busyDelay, token);
            throw new DelayedError();
          }
        }
        try {
          const result = await handler(job);
          const eventId = (job.data as { eventId?: string }).eventId;
          if (eventId) await markEvent(eventId, result === IGNORED ? 'ignored' : 'done');
          return result === IGNORED ? 'ignored' : (result ?? null);
        } finally {
          if (lockToken && userId) await releaseUserLock(userId, lockToken);
        }
      },
      {
        connection: createRedis(),
        prefix: config().QUEUE_PREFIX,
        concurrency: opts.concurrency?.[queueName] ?? DEFAULT_CONCURRENCY[queueName],
        settings: {
          backoffStrategy: (attemptsMade: number) =>
            retry[Math.min(attemptsMade, retry.length) - 1] ?? retry[retry.length - 1] ?? 5000,
        },
      },
    );
    worker.on('failed', (job, err) => {
      if (!job) return;
      const final = job.attemptsMade >= (job.opts.attempts ?? 1);
      log.warn(
        {
          queue: queueName,
          job: job.name,
          jobId: job.id,
          attempt: job.attemptsMade,
          final,
          err: err.message,
        },
        'job failed',
      );
      inc('jobs_failed_total', { queue: queueName, job: job.name, final: String(final) });
      const eventId = (job.data as { eventId?: string }).eventId;
      if (final && eventId) void markEvent(eventId, 'failed', err.message).catch(() => {});
      if (final)
        void alert('Job failed after all retries', {
          queue: queueName,
          job: job.name,
          jobId: job.id,
          err: err.message,
        });
    });
    worker.on('error', (err) => log.error({ queue: queueName, err: err.message }, 'worker error'));
    return worker;
  });
}
