// How many database round trips the web app's reads and a chat turn make. With the database on
// Neon in Ohio, each round trip from the Mumbai server takes about 260 ms, so the count is the
// time. The budgets below keep a page from slowly gaining queries again.
//
// To see the time as well: `PERF_RTT_MS=260 PERF_CONNECT_MS=2000 PERF_OUT=perf.md pnpm vitest
// run test/read-round-trips.test.ts` makes every query wait 260 ms and every new connection 2 s,
// and writes a table to perf.md (without PERF_OUT it is printed). `PERF_SQL=<file>` also writes
// the chat turn's queries, each with the moment it was sent.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit } from '../src/modules/admin/audit.ts';
import { createAutomation } from '../src/modules/automations/automations.ts';
import { subscribe } from '../src/modules/channels/stream.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { requestApproval } from '../src/modules/orchestrator/approvals.ts';
import { saveMemory } from '../src/modules/orchestrator/memory.ts';
import { setChatCompleter, setJevClient } from '../src/modules/orchestrator/routing.ts';
import { closeDb, db } from '../src/shared/db/client.ts';
import { sql } from 'drizzle-orm';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installDbMeter, meter, setDbDelays } from './db-meter.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, waitFor } from './helpers.ts';

const RTT_MS = Number(process.env.PERF_RTT_MS ?? 0);
const CONNECT_MS = Number(process.env.PERF_CONNECT_MS ?? 0);
const REPORT = RTT_MS > 0 || Boolean(process.env.PERF_OUT);

type Row = { what: string; queries: number; connects: number; ms: number };
const report: Row[] = [];

let workers: Worker[];
let user: Awaited<ReturnType<typeof chatUser>>;
let conversationId: string;

/** Opens `n` connections and leaves them idle in the pool (the pool is then "warm"). */
async function warm(n: number) {
  await Promise.all(Array.from({ length: n }, () => db().execute(sql`select 1`)));
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
      (r) => `| ${r.what} | ${r.queries} | ${r.connects} | ${(r.ms / 1000).toFixed(2)} s |`,
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

/** Each endpoint alone, the pool warm: [path, the most queries it may make, auth included]. */
const ENDPOINTS: Array<[string, number]> = [
  ['/v1/me', 3],
  ['/v1/approvals?status=pending&limit=50', 2],
  ['/v1/agent/status', 1],
  ['/v1/billing/plans', 1],
  ['/v1/crew', 1],
  ['/v1/channels', 2],
  ['/v1/conversations?limit=30&kind=chat', 2],
  ['/v1/conversations?limit=1&kind=automations', 2],
  ['/v1/messages?limit=30&conversationId=:conversation', 4],
  ['/v1/activity?limit=30', 2],
  ['/v1/automations', 2],
  ['/v1/agent/settings', 3],
  ['/v1/apps', 4],
  ['/v1/credits', 3],
  ['/v1/credits/ledger?limit=30', 2],
  ['/v1/billing/subscription', 2],
  ['/v1/memories', 2],
  ['/v1/crew-jobs?limit=30', 2],
  ['/v1/byok', 3],
  ['/v1/pr-reviews', 2],
];

describe('the web app reads', () => {
  it.each(ENDPOINTS)('%s stays within its round trips', async (path, budget) => {
    await warm(6);
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
    await warm(6);
    await measure('Chat page, warm (8 calls, then the messages)', openChat);
  });

  it('the chat page after the pool emptied (the first visit after a few idle minutes)', async () => {
    await closeDb();
    await measure('Chat page, after idle minutes', openChat);
  });

  it('the credits page, the pool warm', async () => {
    await warm(6);
    await measure('Credits page, warm (8 calls)', () => Promise.all(CREDITS_PAGE.map(get)));
  });
});

describe('a chat turn', () => {
  it('from sending a web message to the reply, then to the end of the job', async () => {
    await warm(6);
    const inbound = workers.find((w) => w.name === 'inbound')!;
    // Waited for without asking the database, so the waiting adds no round trip.
    let replied!: () => void;
    const reply = new Promise<void>((r) => (replied = r));
    const unsubscribe = await subscribe(user.id, (e) => {
      if (e.type === 'message.created' && (e.data as { direction?: string }).direction === 'out')
        replied();
    });
    let toReply = 0;
    let toAccepted = 0;
    const m = await measure('Chat turn: send to the end of the job', async () => {
      const start = performance.now();
      const res = await call('/v1/messages', {
        method: 'POST',
        token: user.token,
        body: { text: 'what is on my calendar', clientMessageId: randomUUID() },
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
    });
    unsubscribe();
    if (process.env.PERF_SQL) writeFileSync(process.env.PERF_SQL, m.sql.join('\n'));
    report.push(
      {
        what: 'Chat turn: send until the api answers 202',
        queries: NaN,
        connects: NaN,
        ms: toAccepted,
      },
      { what: 'Chat turn: send to the reply shown', queries: NaN, connects: NaN, ms: toReply },
    );
    expect(m.queries).toBeGreaterThan(0);
  }, 180_000);
});
