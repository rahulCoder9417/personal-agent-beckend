// Migration 0025 adds the two times that say whether a conversation is unread. What was said
// before it counts as read. This runs the real migration files on a database of its own: the ones
// up to 0024, then conversations and messages as the old code left them, then 0025.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { isUnread } from '../src/modules/channels/conversations.ts';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
/** The last migration before unread conversations. */
const BEFORE = 24;

const adminUrl = inject('pgAdminUrl');
const dbName = `t_unread_backfill_${Date.now().toString(36)}`;
let pool: pg.Pool;
let oldFolder: string;

async function conversation(id: string, user: string, at: string): Promise<void> {
  await pool.query(
    `insert into conversations (id, user_id, session_key, channel, epoch, active, started_at, last_message_at)
     values ($1, $2, 'web', 'web', $3, false, $4, $4)`,
    [id, user, Number(id.at(-1)), at],
  );
}

let n = 0;
async function message(conversationId: string, user: string, direction: 'in' | 'out', at: string) {
  await pool.query(
    `insert into messages (id, user_id, conversation_id, channel, direction, text, session_key, created_at)
     values ($1, $2, $3, 'web', $4, 'x', 'web', $5)`,
    [`msg_${++n}`, user, conversationId, direction, at],
  );
}

type Times = { last_agent_message_at: Date | null; last_read_at: Date | null };
async function timesOf(id: string): Promise<Times> {
  const { rows } = await pool.query<Times>(
    'select last_agent_message_at, last_read_at from conversations where id = $1',
    [id],
  );
  return rows[0]!;
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  pool = new pg.Pool({ connectionString: adminUrl.replace(/\/postgres$/, `/${dbName}`), max: 2 });

  // The migrations as they were before this one: the same files, a shorter journal.
  oldFolder = mkdtempSync(join(tmpdir(), 'pa-migrations-'));
  cpSync(MIGRATIONS, oldFolder, { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  expect(journal.entries.find((e) => e.idx === BEFORE + 1)?.tag).toBe('0025_conversation_unread');
  journal.entries = journal.entries.filter((e) => e.idx <= BEFORE);
  writeFileSync(join(oldFolder, 'meta/_journal.json'), JSON.stringify(journal));
  await migrate(drizzle(pool), { migrationsFolder: oldFolder });

  // cnv_1: the user asked, Tex answered twice. cnv_2: only the user wrote. cnv_3: nothing yet.
  // cnv_4: another user's, with Tex's answer last.
  await conversation('cnv_1', 'A', '2026-10-10T09:00:00Z');
  await message('cnv_1', 'A', 'in', '2026-10-10T09:00:00Z');
  await message('cnv_1', 'A', 'out', '2026-10-10T09:00:05.123456Z');
  await message('cnv_1', 'A', 'out', '2026-10-10T09:00:09.5Z');
  await conversation('cnv_2', 'A', '2026-10-11T09:00:00Z');
  await message('cnv_2', 'A', 'in', '2026-10-11T09:00:00Z');
  await conversation('cnv_3', 'A', '2026-10-12T09:00:00Z');
  await conversation('cnv_4', 'B', '2026-10-13T09:00:00Z');
  await message('cnv_4', 'B', 'in', '2026-10-13T09:00:00Z');
  await message('cnv_4', 'B', 'out', '2026-10-13T09:00:03Z');

  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
});

afterAll(async () => {
  await pool.end();
  rmSync(oldFolder, { recursive: true, force: true });
});

const toApiTimes = (t: Times) => ({
  lastAgentMessageAt: t.last_agent_message_at,
  lastReadAt: t.last_read_at,
});

describe('migration 0025: what was said before counts as read', () => {
  it('a conversation with answers from the agent gets the newest one’s time, read up to it', async () => {
    const one = await timesOf('cnv_1');
    expect(one.last_agent_message_at?.toISOString()).toBe('2026-10-10T09:00:09.500Z');
    expect(one.last_read_at?.toISOString()).toBe('2026-10-10T09:00:09.500Z');
    expect(isUnread(toApiTimes(one))).toBe(false);

    const other = await timesOf('cnv_4');
    expect(other.last_agent_message_at?.toISOString()).toBe('2026-10-13T09:00:03.000Z');
    expect(isUnread(toApiTimes(other))).toBe(false);
  });

  it('a conversation the agent never wrote in has neither time', async () => {
    for (const id of ['cnv_2', 'cnv_3']) {
      const times = await timesOf(id);
      expect(times).toEqual({ last_agent_message_at: null, last_read_at: null });
      expect(isUnread(toApiTimes(times))).toBe(false);
    }
  });
});
