// Migration 0015 puts what was stored before conversations existed into conversations. This runs
// the real migration files on a database of its own: the ones up to 0014, then rows as the old
// code left them, then 0015.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { titleFromText } from '../src/modules/channels/conversations.ts';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');
/** The last migration before conversations. */
const BEFORE = 14;

const adminUrl = inject('pgAdminUrl');
const dbName = `t_backfill_${Date.now().toString(36)}`;
let pool: pg.Pool;
let oldFolder: string;

type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> =>
  (await pool.query(sql, params)).rows as Row[];

const at = (iso: string) => new Date(iso);
/** When user B and user C started their latest new chat. */
const START = '2026-10-08T12:00:00.001Z';

let n = 0;
async function message(m: {
  user: string;
  channel?: string;
  sessionKey?: string | null;
  direction: 'in' | 'out';
  text: string;
  at: string;
}): Promise<string> {
  const id = `msg_${String(++n).padStart(4, '0')}`;
  await pool.query(
    `insert into messages (id, user_id, channel, direction, text, session_key, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      m.user,
      m.channel ?? 'web',
      m.direction,
      m.text,
      m.sessionKey === undefined ? 'web' : m.sessionKey,
      m.at,
    ],
  );
  return id;
}

const conversationsOf = (user: string) =>
  rows(
    `select c.*, (select array_agg(m.id order by m.id) from messages m where m.conversation_id = c.id) as message_ids
     from conversations c where c.user_id = $1 order by c.session_key, c.epoch`,
    [user],
  );

const LONG =
  'Please   plan a five day trip to Goa\nfor four people in December with a budget of 800 dollars';

/** One user each (T0, T1, …) whose only message is one of these: the title must match the code's. */
const TITLE_TEXTS = [
  'short',
  '  spaced \n\n out\ttext  ',
  'x'.repeat(60),
  'x'.repeat(61),
  'x'.repeat(200),
  `${'word '.repeat(11)}tail`,
  `${'a'.repeat(59)} b`,
  `${'a'.repeat(60)} b`,
  `${'a'.repeat(61)} b`,
  `a ${'b'.repeat(80)}`,
  'नमस्ते दुनिया '.repeat(8),
  'café 😀 '.repeat(12),
];

const ids: Record<string, string> = {};

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
  expect(journal.entries.find((e) => e.idx === BEFORE + 1)?.tag).toBe('0015_conversations');
  journal.entries = journal.entries.filter((e) => e.idx <= BEFORE);
  writeFileSync(join(oldFolder, 'meta/_journal.json'), JSON.stringify(journal));
  await migrate(drizzle(pool), { migrationsFolder: oldFolder });

  // A: web chat, never a new chat. One very old row has no session key.
  ids.a1 = await message({ user: 'A', direction: 'in', text: LONG, at: '2026-10-01T10:00:00Z' });
  ids.a2 = await message({
    user: 'A',
    direction: 'out',
    text: 'Sure.',
    sessionKey: null,
    at: '2026-10-01T10:00:05Z',
  });
  ids.a3 = await message({
    user: 'A',
    direction: 'in',
    text: 'thanks',
    at: '2026-10-02T09:30:00.123456Z',
  });
  await pool.query(
    `insert into chat_engines (user_id, session_key, runtime, last_turn_at) values ('A', 'web', 'hermes', '2026-10-02T09:30:01Z')`,
  );

  // B: web chat on its third new chat; messages before and after the latest start. Hermes last ran
  // before that start, Claude Code after it.
  await pool.query(
    `insert into chat_epochs (user_id, session_key, epoch, started_at) values ('B', 'web', 3, $1)`,
    [START],
  );
  ids.b1 = await message({
    user: 'B',
    direction: 'out',
    text: 'Welcome!',
    at: '2026-10-07T08:00:00Z',
  });
  ids.b2 = await message({
    user: 'B',
    direction: 'in',
    text: 'what is a good laptop?',
    at: '2026-10-08T11:00:00Z',
  });
  ids.b3 = await message({ user: 'B', direction: 'in', text: 'hello again', at: START });
  ids.b4 = await message({
    user: 'B',
    direction: 'out',
    text: 'Hi!',
    at: '2026-10-08T12:00:09Z',
  });
  await pool.query(
    `insert into chat_engines (user_id, session_key, runtime, last_turn_at) values
       ('B', 'web', 'hermes', '2026-10-08T11:00:10Z'),
       ('B', 'web', 'claude_code', '2026-10-08T12:00:10Z')`,
  );
  // B's Telegram chat: `/new` twice, and messages only since the latest one.
  await pool.query(
    `insert into chat_epochs (user_id, session_key, epoch, started_at, start_key) values ('B', 'telegram:77', 2, $1, 'evt_x')`,
    [START],
  );
  ids.b5 = await message({
    user: 'B',
    channel: 'telegram',
    sessionKey: 'telegram:77',
    direction: 'in',
    text: 'ping',
    at: '2026-10-08T13:00:00Z',
  });

  // C: clicked "New chat" once and never wrote anything.
  await pool.query(
    `insert into chat_epochs (user_id, session_key, epoch, started_at) values ('C', 'web', 1, $1)`,
    [START],
  );

  // D: a Telegram chat whose first incoming message was a photo with no text.
  ids.d1 = await message({
    user: 'D',
    channel: 'telegram',
    sessionKey: 'telegram:555',
    direction: 'in',
    text: '',
    at: '2026-10-03T10:00:00Z',
  });
  ids.d2 = await message({
    user: 'D',
    channel: 'telegram',
    sessionKey: 'telegram:555',
    direction: 'in',
    text: 'what is in this photo?',
    at: '2026-10-03T10:00:02Z',
  });

  for (const [i, text] of TITLE_TEXTS.entries())
    await message({ user: `T${i}`, direction: 'in', text, at: '2026-10-04T10:00:00Z' });

  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
});

afterAll(async () => {
  await pool.end();
  rmSync(oldFolder, { recursive: true, force: true });
});

describe('migration 0015: stored messages are put into conversations', () => {
  it('a chat that never had a new chat is one conversation, number 0, with all its messages', async () => {
    const [c, ...more] = await conversationsOf('A');
    expect(more).toEqual([]);
    expect(c).toMatchObject({
      session_key: 'web',
      channel: 'web',
      epoch: 0,
      active: true,
      started_at: at('2026-10-01T10:00:00Z'),
      // Whole milliseconds: the list's cursor is built from this time.
      last_message_at: at('2026-10-02T09:30:00.123Z'),
      message_ids: [ids.a1, ids.a2, ids.a3],
    });
    expect(String(c!.id)).toMatch(/^cnv_[0-9a-f]{32}$/);
    // The title is the first incoming message, cut at a word, exactly as the code cuts it.
    expect(c!.title).toBe('Please plan a five day trip to Goa for four people in');
    expect(c!.title).toBe(titleFromText(LONG));
    expect(String(c!.title).length).toBeLessThanOrEqual(60);
    // The chat gets its counter, and the engine record stays with conversation 0.
    expect(await rows(`select epoch from chat_epochs where user_id = 'A'`)).toEqual([{ epoch: 0 }]);
    expect(await rows(`select epoch, runtime from chat_engines where user_id = 'A'`)).toEqual([
      { epoch: 0, runtime: 'hermes' },
    ]);
  });

  it('after a new chat: what was said before the latest start is the conversation before it', async () => {
    // Ordered by chat, then number: telegram:77 sorts before web.
    const [telegram, before, current, ...more] = await conversationsOf('B');
    expect(more).toEqual([]);
    expect(telegram).toMatchObject({
      session_key: 'telegram:77',
      channel: 'telegram',
      epoch: 2,
      active: true,
      title: 'ping',
      started_at: at(START),
      last_message_at: at('2026-10-08T13:00:00Z'),
      message_ids: [ids.b5],
    });
    expect(before).toMatchObject({
      session_key: 'web',
      epoch: 2,
      active: false,
      title: 'what is a good laptop?',
      started_at: at('2026-10-07T08:00:00Z'),
      last_message_at: at('2026-10-08T11:00:00Z'),
      message_ids: [ids.b1, ids.b2],
    });
    expect(current).toMatchObject({
      session_key: 'web',
      epoch: 3,
      active: true,
      title: 'hello again',
      started_at: at(START),
      last_message_at: at('2026-10-08T12:00:09Z'),
      // A message saved at the very moment of the start belongs to the new conversation.
      message_ids: [ids.b3, ids.b4],
    });
    // The counters keep their numbers; the engine records go to the conversation they ran in.
    expect(
      await rows(
        `select session_key, epoch, start_key from chat_epochs where user_id = 'B' order by 1`,
      ),
    ).toEqual([
      { session_key: 'telegram:77', epoch: 2, start_key: 'evt_x' },
      { session_key: 'web', epoch: 3, start_key: null },
    ]);
    expect(
      await rows(`select runtime, epoch from chat_engines where user_id = 'B' order by 1`),
    ).toEqual([
      { runtime: 'claude_code', epoch: 3 },
      { runtime: 'hermes', epoch: 2 },
    ]);
  });

  it('a new chat nothing was written in yet is an empty conversation with no title', async () => {
    expect(await conversationsOf('C')).toMatchObject([
      {
        epoch: 1,
        active: true,
        title: null,
        started_at: at(START),
        last_message_at: at(START),
        message_ids: null,
      },
    ]);
  });

  it('the title skips an incoming message that has no text', async () => {
    expect(await conversationsOf('D')).toMatchObject([
      {
        session_key: 'telegram:555',
        channel: 'telegram',
        epoch: 0,
        active: true,
        title: 'what is in this photo?',
        message_ids: [ids.d1, ids.d2],
      },
    ]);
  });

  it('every message has a conversation of its own user and chat, and none can be without one', async () => {
    expect(
      await rows(
        `select m.id from messages m join conversations c on c.id = m.conversation_id
         where c.user_id <> m.user_id or c.session_key <> coalesce(m.session_key, m.channel)`,
      ),
    ).toEqual([]);
    await expect(
      pool.query(
        `insert into messages (id, user_id, channel, direction) values ('msg_x', 'A', 'web', 'in')`,
      ),
    ).rejects.toThrow(/conversation_id/);
    await expect(
      pool.query(
        `insert into messages (id, user_id, conversation_id, channel, direction) values ('msg_x', 'A', 'cnv_nope', 'web', 'in')`,
      ),
    ).rejects.toThrow(/foreign key/);
  });

  it('cuts a title like the code does, for any text', async () => {
    for (const [i, text] of TITLE_TEXTS.entries()) {
      const [row] = await rows(`select title from conversations where user_id = $1`, [`T${i}`]);
      expect(row!.title, JSON.stringify(text)).toBe(titleFromText(text));
    }
  });
});
