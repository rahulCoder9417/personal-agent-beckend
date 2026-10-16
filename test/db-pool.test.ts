// The database pool keeps DB_POOL_MIN connections open and alive, so a request never waits the
// 1.5 to 2.5 s a new connection to Neon costs (docs/backend-report.md, "Where the data lives").
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetConfig } from '../src/shared/config.ts';
import { closeDb, db, dbPoolStats, keepDbWarm, pingDb } from '../src/shared/db/client.ts';
import { waitFor } from './helpers.ts';

beforeAll(async () => {
  process.env.DB_POOL_MIN = '3';
  process.env.DB_PING_SECONDS = '0';
  resetConfig();
  await closeDb();
});

afterAll(async () => {
  delete process.env.DB_POOL_MIN;
  delete process.env.DB_PING_SECONDS;
  resetConfig();
  await closeDb();
});

/** The pids of this database's other sessions (the pool's connections). */
async function poolPids(): Promise<number[]> {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  try {
    const { rows } = await admin.query<{ pid: number }>(
      'select pid from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()',
    );
    return rows.map((r) => r.pid);
  } finally {
    await admin.end();
  }
}

describe('the warm pool', () => {
  it('opens DB_POOL_MIN connections at start and leaves them idle', async () => {
    await keepDbWarm();
    expect(dbPoolStats()).toEqual({ total: 3, idle: 3, waiting: 0 });
    // A connection closed just before (the migrations', the pool closed in beforeAll) stays in
    // pg_stat_activity until its backend has exited, which takes a moment on a busy machine.
    await waitFor(async () => (await poolPids()).length === 3);
  });

  it('a query uses a warm connection instead of opening one', async () => {
    const before = await poolPids();
    await db().execute(sql`select 1`);
    expect(dbPoolStats().total).toBe(3);
    expect((await poolPids()).sort()).toEqual(before.sort());
  });

  it('a connection that died is replaced at the next ping', async () => {
    const [victim] = await poolPids();
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query('select pg_terminate_backend($1)', [victim]);
    await admin.end();
    // The pool notices the closed connection and drops it.
    await waitFor(async () => dbPoolStats().total === 2);
    await pingDb();
    expect(dbPoolStats()).toEqual({ total: 3, idle: 3, waiting: 0 });
    // The ended backend leaves pg_stat_activity only once it has exited.
    await waitFor(async () => !(await poolPids()).includes(victim!));
    expect(await poolPids()).toHaveLength(3);
  });

  it('connections busy with real work are not pinged on top', async () => {
    await db().transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      // One connection is in this transaction: the ping touches the 2 idle ones only.
      await pingDb();
      expect(dbPoolStats().total).toBe(3);
    });
  });
});
