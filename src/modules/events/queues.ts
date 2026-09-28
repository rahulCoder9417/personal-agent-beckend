import { Queue, type JobsOptions } from 'bullmq';
import { config } from '../../shared/config.ts';
import { createRedis } from '../../shared/redis.ts';

/** HLD 0.2: four queues so slow work never blocks fast work. */
export const QUEUES = ['inbound', 'outbound', 'scheduled', 'system'] as const;
export type QueueName = (typeof QUEUES)[number];

/** Retry delays: 5 s, 30 s, 2 min, 10 min (5 tries in total). */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];
export const MAX_ATTEMPTS = 5;

export const defaultJobOptions: JobsOptions = {
  attempts: MAX_ATTEMPTS,
  backoff: { type: 'custom' },
  // Keep finished jobs a while so a repeated jobId (event id) is still deduplicated.
  removeOnComplete: { age: 7 * 24 * 3600, count: 50_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

const queues = new Map<QueueName, Queue>();

export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: createRedis(),
      prefix: config().QUEUE_PREFIX,
      defaultJobOptions,
    });
    queues.set(name, q);
  }
  return q;
}

export async function addJob(
  name: QueueName,
  jobName: string,
  data: Record<string, unknown>,
  opts: JobsOptions = {},
): Promise<void> {
  await queue(name).add(jobName, data, opts);
}

export async function closeQueues(): Promise<void> {
  const all = [...queues.values()];
  queues.clear();
  await Promise.all(all.map((q) => q.close()));
}
