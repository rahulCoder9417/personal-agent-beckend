// What the api knows about the HTTP request a piece of code runs in: its request id. The request
// log middleware sets it around each request; the logger adds it to every line written while the
// request runs, so a module's own log line can be matched with the request's line.
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

const store = new AsyncLocalStorage<RequestContext>();

export function runInRequest<T>(ctx: RequestContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/** The request id of the request this code runs in. Undefined outside one (the worker, a script). */
export function currentRequestId(): string | undefined {
  return store.getStore()?.requestId;
}
