import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.ts';
import { logger } from '../logger.ts';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;
/** A db handle or an open transaction; module functions accept either. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;

let pool: pg.Pool | undefined;
let instance: Db | undefined;
let pinger: NodeJS.Timeout | undefined;

export function db(): Db {
  if (!instance) {
    // The database is on Neon, in Ohio: a new connection costs about 1.5 to 2.5 seconds from
    // Mumbai (TLS and sign-in, several round trips of ~260 ms). So the pool never closes its last
    // DB_POOL_MIN connections, however long they sit idle (keepDbWarm opens them at start and
    // keeps them alive); the ones above that close after 5 minutes idle.
    pool = new pg.Pool({
      connectionString: config().DATABASE_URL,
      max: 20,
      min: config().DB_POOL_MIN,
      idleTimeoutMillis: 5 * 60_000,
      keepAlive: true,
    });
    // An idle connection that dies (Neon restarted, the network dropped it) is reported here and
    // leaves the pool. Without a listener, Node treats the event as a crash and the process exits.
    pool.on('error', (err) =>
      logger().warn({ err: err.message }, 'idle database connection lost; it will be replaced'),
    );
    instance = drizzle(pool, { schema, casing: 'snake_case' });
  }
  return instance;
}

/** How many connections the pool has open, how many of them are idle, and who waits for one. */
export function dbPoolStats(): { total: number; idle: number; waiting: number } {
  return {
    total: pool?.totalCount ?? 0,
    idle: pool?.idleCount ?? 0,
    waiting: pool?.waitingCount ?? 0,
  };
}

/**
 * Brings the pool up to DB_POOL_MIN open connections and checks the idle ones: one `select 1` on
 * each, all at once. A connection that died (Neon restarted, the network dropped it) fails its
 * ping, leaves the pool, and a new one takes its place, so a user's request doesn't pay for
 * opening it. Never throws.
 */
export async function pingDb(): Promise<void> {
  const want = config().DB_POOL_MIN;
  if (!want) return;
  db();
  const p = pool!;
  // Connections busy with real work are alive; only the rest are pinged (or opened).
  const n = Math.max(want - (p.totalCount - p.idleCount), 0);
  const results = await Promise.allSettled(Array.from({ length: n }, () => p.query('select 1')));
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed) logger().warn({ failed, of: n }, 'database ping failed');
}

/**
 * For the api and the worker (not scripts): opens the warm connections now and pings them every
 * DB_PING_SECONDS. The timer never keeps the process alive. Resolves once the first round is done.
 */
export async function keepDbWarm(): Promise<void> {
  const every = config().DB_PING_SECONDS;
  if (!pinger && every > 0) {
    pinger = setInterval(() => void pingDb(), every * 1000);
    pinger.unref();
  }
  await pingDb();
}

export async function closeDb(): Promise<void> {
  if (pinger) clearInterval(pinger);
  pinger = undefined;
  const p = pool;
  pool = undefined;
  instance = undefined;
  await p?.end();
}
