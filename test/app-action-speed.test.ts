// "Check my email" (15 October: 62 s, 13 model rounds), replayed on our side of the turn: what the
// agent is sent back by our app tools, and how many database round trips the message and the tool
// calls wait for. Gmail has 63 actions with full input schemas, and Composio's email fetch returns
// whole bodies unless asked not to (gmail-fixture.ts). Every query waits 260 ms, as with the
// database on Neon in Ohio seen from Mumbai; Composio and the agent take no time here.
//
// The table: `PERF_OUT=perf.md pnpm vitest run test/app-action-speed.test.ts` (printed without
// PERF_OUT). Tokens are estimated as characters ÷ 3.5 (JSON and English mixed).
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeQueues } from '../src/modules/events/queues.ts';
import { composio, setComposioApi } from '../src/modules/integrations/composio.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { laterSettled } from '../src/shared/later.ts';
import { installDbMeter, meter, setDbDelays } from './db-meter.ts';
import { fetchEmails, gmailTools } from './gmail-fixture.ts';
import { installFakeComposio, installFakeVm, mcpCall } from './fakes.ts';
import { call, chatUser, testApp } from './helpers.ts';

process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({ gmail: 'ac_gmail' });
resetConfig();

const RTT_MS = 260;
const tokens = (chars: number) => Math.round(chars / 3.5);

type Row = { what: string; chars?: number; queries?: number; rounds?: number; ms?: number };
const report: Row[] = [];

let token: string;
let sessionToken: string;
let conversationId: string;
/** Arguments of every GMAIL_FETCH_EMAILS that reached Composio. */
const fetches: Array<Record<string, unknown>> = [];

/** A tool call, returning with its answer as the agent gets it (the activity log may follow). */
async function tool(name: string, args: Record<string, unknown> = {}) {
  const r = await mcpCall(token, name, args, { settle: false });
  expect(r.isError, r.text).toBe(false);
  return r.text;
}

/**
 * One measured piece of work, every query 260 ms away, until its answer. `waited`: the round trips
 * the answer waited for, one after another (its time over 260 ms); `queries` also counts the
 * writes that go on after the answer (the activity log, an event's mark).
 */
async function slow<T>(fn: () => Promise<T>) {
  let answerMs = 0;
  const m = await meter(async () => {
    setDbDelays({ rttMs: RTT_MS });
    try {
      const began = performance.now();
      const result = await fn();
      answerMs = Math.round(performance.now() - began);
      await laterSettled();
      return result;
    } finally {
      setDbDelays({});
    }
  });
  return { ...m, ms: answerMs, waited: Math.round(answerMs / RTT_MS) };
}

beforeAll(async () => {
  installDbMeter();
  wireModules();
  const vm = installFakeVm();
  await installFakeComposio();
  const fake = composio();
  setComposioApi({
    ...fake,
    listTools: async (toolkits) => (toolkits.includes('gmail') ? gmailTools() : []),
    tool: async (slug) => gmailTools().find((t) => t.slug === slug) ?? null,
    execute: async (slug, input) => {
      if (slug !== 'GMAIL_FETCH_EMAILS') return fake.execute(slug, input);
      fetches.push(input.arguments);
      return { successful: true, data: fetchEmails(input.arguments), error: null };
    },
  });
  const user = await chatUser({ plan: 'max', credits: 5000 });
  sessionToken = user.token;
  await db()
    .insert(connections)
    .values({
      id: newId('con'),
      userId: user.id,
      app: 'gmail',
      composioAccountId: `ca_${randomUUID()}`,
      status: 'active',
    });
  await ensureSandbox(user.id);
  token = vm.tokens.get(user.id)!;
  // As on the server mid-conversation: web chat has its conversation, the container's token and
  // the user's copy are known, and Composio's listing of Gmail was asked for before.
  const first = await call('/v1/messages', {
    method: 'POST',
    token: sessionToken,
    body: { text: 'hello', clientMessageId: randomUUID() },
  });
  conversationId = ((await first.json()) as { conversationId: string }).conversationId;
  await tool('get_profile');
  await mcpCall(token, 'list_app_actions', { app: 'gmail' });
});

afterAll(async () => {
  await closeQueues();
  const lines = report.map(
    (r) =>
      `| ${r.what} | ${r.chars === undefined ? '' : `${r.chars.toLocaleString('en')} (~${tokens(r.chars).toLocaleString('en')} tokens)`} | ${r.queries ?? ''} | ${r.rounds ?? ''} | ${r.ms === undefined ? '' : `${(r.ms / 1000).toFixed(2)} s`} |`,
  );
  const table = [
    `"Check my email" on our side (every query waits ${RTT_MS} ms)`,
    '| What | Sent back to the agent (characters) | Queries | Waited for, one after another | Time |',
    '|---|---|---|---|---|',
    ...lines,
  ].join('\n');
  if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, `${table}\n`);
  else console.log(table);
});

describe('"check my email"', () => {
  it('the message: POST /v1/messages waits for few round trips', async () => {
    const m = await slow(async () => {
      // Until the 202, as the web app waits for it.
      const res = await testApp().request('/v1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
        // As the web app sends it: with the conversation open on screen.
        body: JSON.stringify({
          text: 'check my email',
          clientMessageId: randomUUID(),
          conversationId,
        }),
      });
      expect(res.status).toBe(202);
    });
    report.push({ what: 'POST /v1/messages', queries: m.queries, rounds: m.waited, ms: m.ms });
    expect(m.waited, m.sql.join('\n')).toBeLessThanOrEqual(3);
  });

  it('list_app_actions: names and one line each, no input schemas', async () => {
    const m = await slow(() => tool('list_app_actions'));
    const text = m.result;
    const listing = JSON.parse(text) as { actions: Array<Record<string, unknown>> };
    report.push({
      what: 'list_app_actions (63 Gmail actions)',
      chars: text.length,
      queries: m.queries,
      rounds: m.waited,
      ms: m.ms,
    });
    expect(listing.actions).toHaveLength(63);
    expect(listing.actions.every((a) => !('input_schema' in a))).toBe(true);
    expect(text.length).toBeLessThan(16_000);
    expect(m.waited, m.sql.join('\n')).toBeLessThanOrEqual(1);
  });

  it("describe_app_action: one action's inputs, when the agent needs them", async () => {
    const m = await slow(() => tool('describe_app_action', { action: 'GMAIL_SEND_EMAIL' }));
    const described = JSON.parse(m.result) as { input_schema: { properties: object } };
    report.push({
      what: 'describe_app_action (GMAIL_SEND_EMAIL)',
      chars: m.result.length,
      queries: m.queries,
      rounds: m.waited,
      ms: m.ms,
    });
    expect(Object.keys(described.input_schema.properties)).toContain('recipient_email');
    expect(m.waited, m.sql.join('\n')).toBeLessThanOrEqual(1);
  });

  it('run_app_action GMAIL_FETCH_EMAILS: a short summary of each email, not the whole bodies', async () => {
    const m = await slow(() =>
      tool('run_app_action', {
        action: 'GMAIL_FETCH_EMAILS',
        arguments: { query: 'is:unread', max_results: 10 },
      }),
    );
    const result = JSON.parse(m.result) as { data: { messages: Array<Record<string, unknown>> } };
    report.push({
      what: 'run_app_action GMAIL_FETCH_EMAILS (10 emails)',
      chars: m.result.length,
      queries: m.queries,
      rounds: m.waited,
      ms: m.ms,
    });
    expect(fetches.at(-1)).toMatchObject({ verbose: false, include_payload: false });
    expect(result.data.messages).toHaveLength(10);
    expect(result.data.messages[0]).toMatchObject({
      from: 'Priya 1 <priya1@acme.com>',
      subject: 'Proposal follow-up #1',
    });
    expect(m.result.length).toBeLessThan(8_000);
    expect(m.waited, m.sql.join('\n')).toBeLessThanOrEqual(1);
  });

  it('a body asked for is sent, cut at about 8k tokens with a way to get the rest', async () => {
    const text = await tool('run_app_action', {
      action: 'GMAIL_FETCH_EMAILS',
      arguments: { query: 'is:unread', max_results: 10, verbose: true, include_payload: true },
    });
    report.push({
      what: 'run_app_action GMAIL_FETCH_EMAILS, bodies asked for',
      chars: text.length,
    });
    expect(text.length).toBeLessThanOrEqual(32_000);
    expect(text).toContain('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID');
  });
});
