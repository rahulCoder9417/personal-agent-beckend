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
    pool = new pg.Pool({ connectionString: config().DATABASE_URL, max: 20 });
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
