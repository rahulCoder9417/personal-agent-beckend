import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { config } from '../config.ts';
import * as schema from './schema.ts';

export type Db = NodePgDatabase<typeof schema>;
/** A db handle or an open transaction; module functions accept either. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0] | Db;

let pool: pg.Pool | undefined;
let instance: Db | undefined;

export function db(): Db {
  if (!instance) {
    // The database is on Neon, in Ohio: a new connection costs about 1.5 to 2.5 seconds from
    // Mumbai (TLS and sign-in, several round trips of ~260 ms). Idle connections are kept for
    // 5 minutes instead of pg's 10 seconds, so a reply rarely waits for one.
    pool = new pg.Pool({
      connectionString: config().DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 5 * 60_000,
      keepAlive: true,
    });
    instance = drizzle(pool, { schema, casing: 'snake_case' });
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  const p = pool;
  pool = undefined;
  instance = undefined;
  await p?.end();
}
