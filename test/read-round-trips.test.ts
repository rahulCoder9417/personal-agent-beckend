// How many database round trips the web app's reads and a chat turn make. With the database on
// Neon in Ohio, each round trip from the Mumbai server takes about 260 ms, so the count is the
// time. The budgets below keep a page from slowly gaining queries again.
//
// To see the time as well: `PERF_RTT_MS=260 PERF_CONNECT_MS=2000 PERF_OUT=perf.md pnpm vitest
// run test/read-round-trips.test.ts` makes every query wait 260 ms and every new connection 2 s,
// and writes a table to perf.md (without PERF_OUT it is printed). `PERF_SQL=<file>` also writes
// the chat turn's queries, each with the moment it was sent, and then the queries of the turn's
// billing job (which runs after the turn, once the user's lock is free).
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../src/modules/admin/audit.ts';
import { createAutomation } from '../src/modules/automations/automations.ts';
import { subscribe } from '../src/modules/channels/stream.ts';
import { closeQueues, queue, QUEUES } from '../src/modules/events/queues.ts';
import { requestApproval } from '../src/modules/orchestrator/approvals.ts';
import { saveMemory } from '../src/modules/orchestrator/memory.ts';
import { setChatCompleter, setJevClient } from '../src/modules/orchestrator/routing.ts';
import { sql } from 'drizzle-orm';
import { closeDb, db, pingDb } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { turnsBilled } from './billing-helpers.ts';
import { installDbMeter, meter, queriesSoFar, setDbDelays } from './db-meter.ts';
import { setTelegramApi, telegramApi } from '../src/modules/channels/adapters/telegram.ts';
import { installFakeTelegram, installFakeVm, telegramUpdate } from './fakes.ts';
import { call, chatUser, testApp, waitFor } from './helpers.ts';

function sendTelegram(update: unknown) {
  return call('/webhooks/telegram', {
    method: 'POST',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
  });
}

const RTT_MS = Number(process.env.PERF_RTT_MS ?? 0);
const CONNECT_MS = Number(process.env.PERF_CONNECT_MS ?? 0);
const REPORT = RTT_MS > 0 || Boolean(process.env.PERF_OUT);

type Row = { what: string; queries: number; connects: number; ms: number };
const report: Row[] = [];

let workers: Worker[];
let user: Awaited<ReturnType<typeof chatUser>>;
let conversationId: string;

/**
 * No job running or waiting to run (a timer's next run excepted). Every query of the process is
 * counted, so a job of the setup still running (the first turn's billing, a reply going out) would
 * be counted as the page's on a busy machine.
 */
async function quiet() {
  await waitFor(async () => {
    for (const name of QUEUES) {
      const n = await queue(name).getJobCounts('active', 'waiting', 'prioritized', 'delayed');
      const delayed = name === 'scheduled' ? 0 : (n.delayed ?? 0);
      if ((n.active ?? 0) + (n.waiting ?? 0) + (n.prioritized ?? 0) + delayed > 0) return false;
    }
    return true;
  }, 30_000);
}

/** The pool as the api and the worker keep it: DB_POOL_MIN connections open and idle. */
async function warm() {
  await quiet();
  await pingDb();
}

async function get(path: string): Promise<void> {
  const res = await call(path, { token: user.token });
  expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
  await res.arrayBuffer();
}

async function measure(what: string, fn: () => Promise<unknown>) {
  const m = await meter(async () => {
    setDbDelays({ rttMs: RTT_MS, connectMs: CONNECT_MS });
    try {
      await fn();
    } finally {
      setDbDelays({});
    }
  });
  report.push({ what, queries: m.queries, connects: m.connects, ms: m.ms });
  return m;
}

beforeAll(async () => {
  installDbMeter();
  wireModules();
  installFakeVm();
  setJevClient({ decide: async () => ({ route: 'task', confidence: 0.9, apps: [] }) });
  setChatCompleter(async () => 'Hello!');
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });

  // One user with some of everything the pages show.
  user = await chatUser({ credits: 5000 });
  const sent = await call('/v1/messages', {
    method: 'POST',
    token: user.token,
    body: { text: 'hello there', clientMessageId: randomUUID() },
  });
  conversationId = ((await sent.json()) as { conversationId: string }).conversationId;
  await waitFor(async () => {
    const res = await call(`/v1/messages?conversationId=${conversationId}`, { token: user.token });
    const body = (await res.json()) as { items: unknown[] };
    return body.items.length >= 2;
  });
  for (let i = 0; i < 5; i++)
    await audit({ userId: user.id, actor: 'agent', action: 'test', summary: `entry ${i}` });
  await requestApproval({ userId: user.id, sessionKey: 'web', summary: 'Send the email' });
  await saveMemory(user.id, { content: 'Likes short answers' });
  await createAutomation({
    userId: user.id,
    title: 'Morning summary',
    instruction: 'Summarise my day',
    cron: '0 8 * * *',
    sessionKey: 'web',
  });
});

afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  setJevClient(undefined);
  setChatCompleter(undefined);
  if (REPORT) {
    const lines = report.map(
      (r) =>
        `| ${r.what} | ${r.queries} | ${r.connects} | ${Number.isNaN(r.ms) ? 'none' : `${(r.ms / 1000).toFixed(2)} s`} |`,
    );
    const table = [
      `Database round trips (each query waits ${RTT_MS} ms, each new connection ${CONNECT_MS} ms)`,
      '| What | Queries | New connections | Time |',
      '|---|---|---|---|',
      ...lines,
    ].join('\n');
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, `${table}\n`);
    else console.log(table);
  }
});

/**
 * Each endpoint alone, the pool warm: [path, the most queries it may make]. Who is signed in comes
 * from the user's copy in Redis (no query); the queries listed run at the same time where there
 * are several (the messages: the list, the conversation check and the chat's start; the apps: the
 * connections and the server's app setups; the automations: the list and the linked chats, for
 * where each one's copies go).
 */
const ENDPOINTS: Array<[string, number]> = [
  ['/v1/me', 1],
  ['/v1/approvals?status=pending&limit=50', 1],
  ['/v1/agent/status', 0],
  ['/v1/billing/plans', 0],
  ['/v1/crew', 0],
  ['/v1/channels', 1],
  ['/v1/conversations?limit=30&kind=chat', 1],
  ['/v1/conversations?limit=1&kind=automations', 1],
  ['/v1/messages?limit=30&conversationId=:conversation', 3],
  ['/v1/activity?limit=30', 1],
  ['/v1/automations', 2],
  ['/v1/agent/settings', 2],
  ['/v1/apps', 2],
  ['/v1/credits', 1],
  ['/v1/credits/ledger?limit=30', 1],
  ['/v1/billing/subscription', 1],
  ['/v1/memories', 1],
  ['/v1/crew-jobs?limit=30', 1],
  ['/v1/byok', 2],
  ['/v1/pr-reviews', 1],
];

describe('the web app reads', () => {
  it.each(ENDPOINTS)('%s stays within its round trips', async (path, budget) => {
    await warm();
    const p = path.replace(':conversation', conversationId);
    const m = await measure(`GET ${p.split('?')[0]}`, () => get(p));
    expect(m.queries, m.sql.join('\n')).toBeLessThanOrEqual(budget);
  });
});

/** What one page asks for at once (the web app's shell plus the page), then what waits on it. */
const SHELL = [
  '/v1/me',
  '/v1/approvals?status=pending&limit=50',
  '/v1/agent/status',
  '/v1/billing/plans',
  '/v1/crew',
];
const CHAT_PAGE = [
  ...SHELL,
  '/v1/channels',
  '/v1/conversations?limit=30&kind=chat',
  '/v1/conversations?limit=1&kind=automations',
];
const CREDITS_PAGE = [
  ...SHELL,
  '/v1/credits',
  '/v1/credits/ledger?limit=30',
  '/v1/billing/subscription',
];

async function openChat() {
  await Promise.all(CHAT_PAGE.map(get));
  await get(`/v1/messages?limit=30&conversationId=${conversationId}`);
}

describe('whole pages', () => {
  it('the chat page, the pool warm', async () => {
    await warm();
    const m = await measure('Chat page, warm (8 calls, then the messages)', openChat);
    // The warm connections are enough for the whole page: none is opened.
    expect(m.connects).toBe(0);
    expect(m.queries, m.sql.join('\n')).toBeLessThanOrEqual(10);
  });

  it('the chat page with no connection open (before 15 October: the first visit after 5 idle minutes)', async () => {
    await closeDb();
    await measure('Chat page, no connection open', openChat);
  });

  it('the credits page, the pool warm', async () => {
    await warm();
    await measure('Credits page, warm (8 calls)', () => Promise.all(CREDITS_PAGE.map(get)));
  });
});

/**
 * After the reply is shown, the turn still saves what the next message depends on before it gives
 * the user's lock back: the end of the agent's send (the conversation, the activity log), the
 * engine's record and the message's last state (at once), the turn's timings and the event. The
 * billing is a job of its own, after the lock (before 15 October: 19 trips in a row here, 12 of
 * them the usage sync).
 */
const AFTER_REPLY_BUDGET = 8;

describe('a chat turn', () => {
  it('from sending a web message to the reply, then to the end of the job', async () => {
    await warm();
    const inbound = workers.find((w) => w.name === 'inbound')!;
    // The billing waits until the turn is over, so what follows the reply is the turn's own work.
    const system = workers.find((w) => w.name === 'system')!;
    await system.pause();
    // Waited for without asking the database, so the waiting adds no round trip.
    let replied!: () => void;
    const reply = new Promise<void>((r) => (replied = r));
    let atReply = 0;
    const unsubscribe = await subscribe(user.id, (e) => {
      if (e.type === 'message.created' && (e.data as { direction?: string }).direction === 'out') {
        atReply = queriesSoFar();
        replied();
      }
    });
    let toReply = 0;
    let toAccepted = 0;
    let toFree = 0;
    let afterReply = 0;
    const m = await measure('Chat turn: send to the end of the job', async () => {
      const start = performance.now();
      // Until the 202, as the browser waits for it (the test helper `call` would also wait for the
      // writes the api does after it).
      const res = await testApp().request('/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${user.token}`, 'content-type': 'application/json' },
        // As the web app sends it: with the conversation open on screen.
        body: JSON.stringify({
          text: 'what is on my calendar',
          clientMessageId: randomUUID(),
          conversationId,
        }),
      });
      expect(res.status).toBe(202);
      toAccepted = Math.round(performance.now() - start);
      const { id } = (await res.json()) as { id: string };
      const done = new Promise<void>((resolve) => {
        const onDone = (job: { data: { messageId?: string } }) => {
          if (job.data.messageId !== id) return;
          inbound.off('completed', onDone);
          resolve();
        };
        inbound.on('completed', onDone);
      });
      await reply;
      toReply = Math.round(performance.now() - start);
      await done;
      toFree = Math.round(performance.now() - start);
      afterReply = queriesSoFar() - atReply;
    });
    unsubscribe();
    report.push(
      {
        what: 'Chat turn: send until the api answers 202',
        queries: NaN,
        connects: NaN,
        ms: toAccepted,
      },
      { what: 'Chat turn: send to the reply shown', queries: NaN, connects: NaN, ms: toReply },
      {
        what: 'Chat turn: the reply shown until the lock is free (the next message can start)',
        queries: afterReply,
        connects: NaN,
        ms: toFree - toReply,
      },
    );
    expect(m.queries).toBeGreaterThan(0);
    expect(afterReply, m.sql.join('\n')).toBeLessThanOrEqual(AFTER_REPLY_BUDGET);

    // Then the billing runs, on its own, with nobody waiting for it.
    const billing = await measure("The turn's billing job (after the lock is free)", async () => {
      system.resume();
      await turnsBilled(user.id);
    });
    if (process.env.PERF_SQL)
      writeFileSync(
        process.env.PERF_SQL,
        [...m.sql, '--- the billing job ---', ...billing.sql].join('\n'),
      );
    expect(billing.queries).toBeGreaterThan(0);
  }, 180_000);
});

/**
 * A Telegram message, as on the server: no Jev (every message is a task), the agent answers at once
 * (the model's time is not in it), the reply goes out through the outbound queue to the Bot API.
 * Times are from the moment Telegram calls the webhook.
 */
describe('a Telegram turn', () => {
  const chatId = 700_000_000 + Math.floor(Math.random() * 1e6);
  let tg: ReturnType<typeof installFakeTelegram>;

  beforeAll(async () => {
    tg = installFakeTelegram();
    const lc = (await (
      await call('/v1/channels/link-codes', {
        method: 'POST',
        token: user.token,
        body: { channel: 'telegram' },
      })
    ).json()) as { code: string };
    await sendTelegram(telegramUpdate(chatId, lc.code));
    await waitFor(async () => tg.sent.find((m) => m.text.startsWith('✅ Linked')));
  });

  it('from the webhook to the reply on Telegram, then to the end of the job', async () => {
    // As on the server today: no Jev key, so the route is decided at once.
    setJevClient(undefined);
    await warm();
    const inbound = workers.find((w) => w.name === 'inbound')!;
    const system = workers.find((w) => w.name === 'system')!;
    await system.pause();
    let start = 0;
    let webhookMs = 0;
    let replyQueries = 0;
    let replyAt = 0;
    const realApi = telegramApi();
    setTelegramApi(async (method, body) => {
      if (method === 'sendMessage' && String(body.chat_id) === String(chatId) && !replyAt) {
        replyAt = performance.now();
        replyQueries = queriesSoFar();
      }
      return realApi(method, body);
    });
    try {
      const m = await measure('Telegram turn: webhook to the end of the job', async () => {
        const done = new Promise<void>((resolve) => {
          const onDone = (job: { name: string }) => {
            if (job.name !== 'process-message') return;
            inbound.off('completed', onDone);
            resolve();
          };
          inbound.on('completed', onDone);
        });
        start = performance.now();
        const res = await sendTelegram(telegramUpdate(chatId, 'what is on my calendar'));
        expect(res.status).toBe(200);
        webhookMs = Math.round(performance.now() - start);
        await done;
      });
      const typing = tg.calls.find(
        (c) => c.method === 'sendChatAction' && c.chatId === String(chatId) && c.at > start,
      );
      expect(replyAt, m.sql.join('\n')).toBeGreaterThan(0);
      report.push(
        { what: 'Telegram turn: webhook answered', queries: NaN, connects: NaN, ms: webhookMs },
        {
          what: 'Telegram turn: the first "typing…" sent',
          queries: NaN,
          connects: NaN,
          ms: typing ? Math.round(typing.at - start) : NaN,
        },
        {
          what: 'Telegram turn: the reply sent to Telegram',
          queries: replyQueries,
          connects: NaN,
          ms: Math.round(replyAt - start),
        },
      );
      if (process.env.PERF_TG_SQL) writeFileSync(process.env.PERF_TG_SQL, m.sql.join('\n'));
    } finally {
      setTelegramApi(realApi);
      system.resume();
      setJevClient({ decide: async () => ({ route: 'task', confidence: 0.9, apps: [] }) });
    }
  }, 180_000);
});

describe('the indexes the hot reads need', () => {
  it("a chat app's message is found by its event without reading the whole table", async () => {
    // The query saveInbound and getInboundByEvent make for every incoming chat app message.
    const plan = await db().transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const { rows } = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`explain select * from messages where event_id = 'evt_x' and direction = 'in'`,
      );
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('messages_event_id_index');
  });
});
