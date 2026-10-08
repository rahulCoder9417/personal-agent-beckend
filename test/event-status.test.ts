// An event's status after its job: the api writes `queued` just after it adds the job, so a job
// that ends first (a quick reply) must not be put back to `queued`. A row left `queued` is queued
// again on every worker start (requeuePendingEvents).
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getEvent, ingestEvent, requeuePendingEvents } from '../src/modules/events/intake.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import type * as Queues from '../src/modules/events/queues.ts';
import { IGNORED, startWorkers } from '../src/worker/runner.ts';

/** While on, adding a job returns only after the worker has finished it: an api that is slow
 *  between adding the job and its next line. */
const slowApi = vi.hoisted(() => ({ on: false }));

vi.mock('../src/modules/events/queues.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Queues>();
  return {
    ...real,
    addJob: async (...args: Parameters<typeof real.addJob>) => {
      await real.addJob(...args);
      const jobId = args[3]?.jobId;
      if (!slowApi.on || !jobId) return;
      for (let i = 0; i < 500; i++) {
        const job = await real.queue(args[0]).getJob(jobId);
        if (job && (await job.isCompleted())) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`job ${jobId} never finished`);
    },
  };
});

let workers: Worker[] = [];
afterEach(async () => {
  slowApi.on = false;
  await Promise.all(workers.map((w) => w.close()));
  workers = [];
});
afterAll(closeQueues);

describe('event status', () => {
  it('a job that ends before the api writes `queued` keeps its final status', async () => {
    workers = startWorkers({ system: { quick: async () => null, nothing: async () => IGNORED } });
    slowApi.on = true;
    const done = await ingestEvent({
      source: 'test',
      externalId: randomUUID(),
      type: 'quick',
      payload: {},
      queue: 'system',
      jobName: 'quick',
    });
    const ignored = await ingestEvent({
      source: 'test',
      externalId: randomUUID(),
      type: 'nothing',
      payload: {},
      queue: 'system',
      jobName: 'nothing',
    });
    expect((await getEvent(done.eventId))!.status).toBe('done');
    expect((await getEvent(ignored.eventId))!.status).toBe('ignored');
    // So a worker start finds nothing to queue again.
    expect(await requeuePendingEvents()).toBe(0);
  });

  it('an event whose job has not run yet is still marked `queued`', async () => {
    const { eventId } = await ingestEvent({
      source: 'test',
      externalId: randomUUID(),
      type: 'later',
      payload: {},
      queue: 'system',
      jobName: 'later',
    });
    expect((await getEvent(eventId))!.status).toBe('queued');
  });
});
