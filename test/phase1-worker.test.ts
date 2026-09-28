import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import { addJob, closeQueues, queue } from '../src/modules/events/queues.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { waitFor } from './helpers.ts';

afterAll(closeQueues);

describe('worker', () => {
  it('two jobs for the same user never run at the same time', async () => {
    const userId = `usr_${randomUUID()}`;
    const other = `usr_${randomUUID()}`;
    const spans: Array<{ user: string; start: number; end: number }> = [];
    const handler = async (job: Job) => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 150));
      spans.push({ user: job.data.userId, start, end: Date.now() });
    };
    const workers = startWorkers(
      { inbound: { t: handler } },
      { concurrency: { inbound: 10 }, busyDelayMs: 50 },
    );
    try {
      for (let i = 0; i < 4; i++) await addJob('inbound', 't', { userId });
      await addJob('inbound', 't', { userId: other });
      await waitFor(async () => spans.length === 5, 20_000);
      const mine = spans.filter((s) => s.user === userId).sort((a, b) => a.start - b.start);
      for (let i = 1; i < mine.length; i++)
        expect(mine[i]!.start).toBeGreaterThanOrEqual(mine[i - 1]!.end);
      // Another user's job is not blocked by the first user's lock.
      const theirs = spans.find((s) => s.user === other)!;
      expect(theirs.start).toBeLessThan(mine[mine.length - 1]!.end);
    } finally {
      await Promise.all(workers.map((w) => w.close()));
    }
  });

  it('a crashed job is retried', async () => {
    let calls = 0;
    const workers = startWorkers(
      {
        system: {
          flaky: async () => {
            calls++;
            if (calls < 3) throw new Error('boom');
            return 'ok';
          },
        },
      },
      { retryDelaysMs: [20, 20, 20, 20] },
    );
    try {
      const id = `flaky-${randomUUID()}`;
      await addJob('system', 'flaky', {}, { jobId: id });
      const job = await waitFor(async () => {
        const j = await queue('system').getJob(id);
        return (await j?.isCompleted()) ? j : undefined;
      });
      expect(calls).toBe(3);
      expect(job!.attemptsMade).toBeGreaterThanOrEqual(2);
      expect(job!.returnvalue).toBe('ok');
    } finally {
      await Promise.all(workers.map((w) => w.close()));
    }
  });
});
