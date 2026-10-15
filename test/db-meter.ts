// Counts the database round trips a piece of work makes, and can make each one slow on purpose.
//
// Every query the app sends goes through pg's Client (the pool's clients, and transactions), so
// wrapping `Client.prototype.query` sees each round trip once: BEGIN and COMMIT count too, as they
// do on the wire. With `rttMs` set, each query waits that long before it is sent, like a database
// far away (Neon in Ohio is about 260 ms from Mumbai); with `connectMs`, so does opening a new
// connection (1.5 to 2.5 s there). Queries that run in parallel wait in parallel, so the time a
// request takes shows how many of its round trips run one after another.
import pg from 'pg';

export interface DbMeter {
  queries: number;
  connects: number;
  /** The first words of each query, in order, with when it was sent (ms from the start). */
  sql: string[];
}

const settings = { rttMs: 0, connectMs: 0 };
/** Queries to refuse once each (failNextQuery). */
const failing: RegExp[] = [];
let current: DbMeter = { queries: 0, connects: 0, sql: [] };
let startedAt = performance.now();
let installed = false;

type AnyFn = (...args: unknown[]) => unknown;

function textOf(arg: unknown): string {
  const text = typeof arg === 'string' ? arg : (arg as { text?: string } | null)?.text;
  return (text ?? '?').replace(/\s+/g, ' ').trim().slice(0, 90);
}

/** Wraps pg's Client once per test file. Delays are off until `setDbDelays` turns them on. */
export function installDbMeter(): void {
  if (installed) return;
  installed = true;
  const proto = pg.Client.prototype as unknown as { query: AnyFn; connect: AnyFn };
  const query = proto.query;
  proto.query = function (this: unknown, ...args: unknown[]) {
    const full =
      typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string } | null)?.text ?? '');
    const fail = failing.findIndex((p) => p.test(full));
    if (fail >= 0) {
      failing.splice(fail, 1);
      const err = new Error('injected database failure');
      const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as AnyFn) : undefined;
      if (cb) {
        setImmediate(() => cb(err));
        return undefined;
      }
      return Promise.reject(err);
    }
    current.queries++;
    current.sql.push(`${Math.round(performance.now() - startedAt)}ms ${textOf(args[0])}`);
    if (!settings.rttMs) return query.apply(this, args);
    const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as AnyFn) : undefined;
    if (cb) {
      setTimeout(() => query.apply(this, [...args, cb]), settings.rttMs);
      return undefined;
    }
    return new Promise((r) => setTimeout(r, settings.rttMs)).then(() => query.apply(this, args));
  };
  const connect = proto.connect;
  proto.connect = function (this: unknown, ...args: unknown[]) {
    current.connects++;
    if (!settings.connectMs) return connect.apply(this, args);
    const cb = typeof args[0] === 'function' ? (args[0] as AnyFn) : undefined;
    if (cb) {
      setTimeout(() => connect.apply(this, [cb]), settings.connectMs);
      return undefined;
    }
    return new Promise((r) => setTimeout(r, settings.connectMs)).then(() =>
      connect.apply(this, args),
    );
  };
}

export function setDbDelays(d: { rttMs?: number; connectMs?: number }): void {
  settings.rttMs = d.rttMs ?? 0;
  settings.connectMs = d.connectMs ?? 0;
}

/** Round trips counted so far by the meter that is running (to count a part of its work). */
export function queriesSoFar(): number {
  return current.queries;
}

/**
 * The next query whose SQL matches `pattern` fails (once), as if the database had refused it.
 * The query is not sent.
 */
export function failNextQuery(pattern: RegExp): void {
  failing.push(pattern);
}

/**
 * How many rounds of queries a piece of work waited for, one after another: the queries of a
 * meter's `sql` sent within `gapMs` of the first one of their round ran at the same time and count
 * once. Meaningful with a delay on every query (`setDbDelays`) of more than twice `gapMs`. Only
 * the queries sent between `fromMs` and `toMs` (from the meter's start) count.
 */
export function roundsOf(sql: string[], gapMs: number, fromMs = 0, toMs = Infinity): number {
  let rounds = 0;
  let roundStart = -Infinity;
  for (const line of sql) {
    const at = Number(/^(\d+)ms /.exec(line)?.[1]);
    if (!(at >= fromMs && at <= toMs)) continue;
    if (at - roundStart > gapMs) {
      rounds++;
      roundStart = at;
    }
  }
  return rounds;
}

/** Runs `fn` and returns what it cost: round trips, new connections and the time taken. */
export async function meter<T>(fn: () => Promise<T>): Promise<DbMeter & { ms: number; result: T }> {
  const before = current;
  current = { queries: 0, connects: 0, sql: [] };
  const start = (startedAt = performance.now());
  try {
    const result = await fn();
    return { ...current, ms: Math.round(performance.now() - start), result };
  } finally {
    current = before;
  }
}
