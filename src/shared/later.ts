// Writes a request does not wait for: they start at once, and the answer goes back without
// waiting for their round trip to the database (about 0.26 s each on Neon). Only for writes that
// nothing in the answer depends on. A failed one is logged as an error with its context (never
// secrets or message text); shutdown and tests wait for the ones still running (`laterSettled`).
import { logger } from './logger.ts';

const running = new Set<Promise<void>>();

export function runLater(
  what: string,
  work: () => Promise<unknown>,
  context: Record<string, unknown> = {},
): void {
  const done = (async () => {
    try {
      await work();
    } catch (err) {
      logger().error({ ...context, err: String(err) }, `${what} failed`);
    }
  })();
  running.add(done);
  void done.finally(() => running.delete(done));
}

/** Waits until every write started with runLater so far has ended (and any they started). */
export async function laterSettled(): Promise<void> {
  while (running.size > 0) await Promise.allSettled([...running]);
}
