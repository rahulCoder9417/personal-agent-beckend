// What the worker knows about the job a piece of code runs in: when it was queued, when the worker
// took it (after the per-user lock), and which try it is. The worker sets it around each job's
// handler; code deep in the job (a turn's timings) reads it without every caller passing it on.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface JobContext {
  /** When the job was queued, or became due (a delayed job): epoch milliseconds. */
  queuedAt: number;
  /** When the worker took it, holding the user's lock when it takes one: epoch milliseconds. */
  pickedUpAt: number;
  /** 1 for the first try. */
  attempt: number;
}

const store = new AsyncLocalStorage<JobContext>();

export function runInJob<T>(ctx: JobContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}

/** The job this code runs in. Undefined outside a job (the api, a script, a test calling directly). */
export function currentJob(): JobContext | undefined {
  return store.getStore();
}
