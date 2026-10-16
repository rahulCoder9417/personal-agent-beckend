// Automations with steps, phase 4 (docs/automations-steps-proposal.md, option C). 4a: steps saved,
// checked per step, read back (old automations unchanged), proposed by Tex and saved from a draft,
// an app's actions for the step panel. 4b: the runner, on Priya's example with stand-ins: no email
// stops the run after step 1 with one line; an urgent email runs steps 2 and 3, then asks; the yes
// sends once and charges 1 credit; a no skips step 4; calls outside the current step are refused;
// a job run twice sends once; a new run supersedes a waiting one; the call limits.
import { randomUUID } from 'node:crypto';
import type { Job, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliverKind } from '../proto-gen/vm/v1/vm_pb.ts';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { createAutomation, setMinIntervalMs } from '../src/modules/automations/automations.ts';
import { handleRunApprovalAnswer } from '../src/modules/automations/jobs.ts';
import {
  cleanupRuns,
  expireWaitingRuns,
  gateAppAction,
  MAX_CALLS_PER_RUN,
  MAX_CALLS_PER_STEP,
  startRun,
} from '../src/modules/automations/runs.ts';
import {
  automationDrafts,
  automationRuns,
  automations,
  type AutomationStep,
} from '../src/modules/automations/schema.ts';
import { automationsChat } from '../src/modules/channels/conversations.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import type { ComposioTool } from '../src/modules/integrations/composio.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { approvals } from '../src/modules/orchestrator/schema.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { setTurnHooks } from '../src/modules/orchestrator/turn.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  installFakeComposio,
  installFakeTelegram,
  installFakeVm,
  mcpCall,
  type Delivery,
  type McpResult,
  type SentTelegram,
} from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[] = [];
let tg: { sent: SentTelegram[] };
let vmFake: ReturnType<typeof installFakeVm>;
let composioFake: Awaited<ReturnType<typeof installFakeComposio>>;

const FETCH = 'GMAIL_FETCH_EMAILS';
const SEND = 'GMAIL_SEND_EMAIL';
const LABELS = 'GMAIL_LIST_LABELS';
const GMAIL_TOOLS: ComposioTool[] = [
  {
    slug: FETCH,
    toolkit: 'gmail',
    name: 'Fetch emails',
    description: 'Fetch emails matching a query',
    inputParameters: {
      type: 'object',
      properties: { query: { type: 'string' }, max_results: { type: 'integer' } },
    },
    tags: ['readOnlyHint'],
  },
  {
    slug: SEND,
    toolkit: 'gmail',
    name: 'Send email',
    description: 'Send an email',
    inputParameters: {
      type: 'object',
      properties: {
        recipient_email: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['recipient_email', 'body'],
    },
    tags: [],
  },
  {
    slug: LABELS,
    toolkit: 'gmail',
    name: 'List labels',
    description: 'List the labels',
    inputParameters: { type: 'object', properties: {} },
    tags: ['readOnlyHint'],
  },
];

beforeAll(() => {
  wireModules();
  setMinIntervalMs(15 * 60 * 1000);
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(async () => {
  tg = installFakeTelegram();
  composioFake = await installFakeComposio();
  composioFake.state.tools.set('gmail', GMAIL_TOOLS);
  setTurnHooks({ hasCredits: async () => true });
  vmFake = installFakeVm();
});

async function connect(userId: string, app: string) {
  await db()
    .insert(connections)
    .values({
      id: newId('con'),
      userId,
      app,
      composioAccountId: `ca_${randomUUID()}`,
      status: 'active',
    });
}

async function person(opts: { telegram?: boolean } = {}) {
  const u = await chatUser({ plan: 'pro', timezone: 'Asia/Kolkata' });
  const chatId = Math.floor(Math.random() * 1e9);
  if (opts.telegram)
    await db()
      .insert(channelLinks)
      .values({
        id: newId('chl'),
        userId: u.id,
        channel: 'telegram',
        externalId: String(chatId),
        displayId: '@me',
      });
  await connect(u.id, 'gmail');
  await connect(u.id, 'github');
  await ensureSandbox(u.id);
  const token = vmFake.tokens.get(u.id)!;
  return {
    ...u,
    chatId,
    tool: (name: string, args: Record<string, unknown>): Promise<McpResult> =>
      mcpCall(token, name, args),
  };
}
type Person = Awaited<ReturnType<typeof person>>;

/** Priya's "Urgent mail from my boss", as the canvas gives it. */
const PRIYA_STEPS = [
  {
    id: 'fetch',
    type: 'action',
    app: 'gmail',
    action: FETCH,
    inputs: { query: 'from:boss@acme.com is:unread newer_than:1d' },
  },
  {
    id: 'pick',
    type: 'tex',
    instruction: 'Pick the emails that are urgent and say why',
    onlyIf: { kind: 'found' },
  },
  {
    id: 'draft',
    type: 'tex',
    instruction: 'Draft a two-line reply to each urgent one',
    onlyIf: { kind: 'mentions', words: ['Urgent'] },
    showResult: true,
  },
  { id: 'send', type: 'action', app: 'gmail', action: SEND, askFirst: false },
];
const priya = {
  title: 'Urgent mail from my boss',
  instruction: 'Reply fast to urgent mail from my boss',
  cron: '0 8 * * 1-5',
  timezone: 'Asia/Kolkata',
  steps: PRIYA_STEPS,
};

type ApiStep = AutomationStep & { risky: boolean };
type ApiAutomation = { id: string; enabled: boolean; apps: string[]; steps: ApiStep[] };
type Problem = { step: string | null; stepId: string | null; code: string; message: string };
type ApiRun = {
  id: string;
  state: string;
  test: boolean;
  stopReason: string | null;
  steps: Array<{ stepId: string; state: string; result: string | null; reason: string | null }>;
  resultsRemoved: boolean;
};

const check = async (u: Person, body: Record<string, unknown>) =>
  (
    await expectContract<{ ok: boolean; problems: Problem[] }>(
      'checkAutomation',
      await call('/v1/automations/check', { method: 'POST', token: u.token, body }),
      200,
    )
  ).problems;
const create = async (u: Person, body: Record<string, unknown>) =>
  expectContract<ApiAutomation>(
    'createAutomation',
    await call('/v1/automations', {
      method: 'POST',
      token: u.token,
      body: { clientRequestId: randomUUID(), ...body },
    }),
    201,
  );
const runsOf = async (u: Person, id: string) =>
  (
    await expectContract<{ items: ApiRun[] }>(
      'listAutomationRuns',
      await call(`/v1/automations/${id}/runs`, { token: u.token }),
      200,
    )
  ).items;
/** The timer fires, as the scheduler would (a real run, not a test). */
const fire = (a: { id: string }) =>
  queue('scheduled').add('run-automation', { automationId: a.id }, { jobId: randomUUID() });
const chatTexts = async (userId: string) => {
  const chat = await automationsChat(userId);
  const rows = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.conversationId, chat.id), eq(messages.direction, 'out')));
  return rows.map((m) => m.text);
};
const decide = (u: Person, id: string, decision: 'approve' | 'reject') =>
  call(`/v1/approvals/${id}/decision`, { method: 'POST', token: u.token, body: { decision } });
/** Priya's automation, as if made in her Telegram chat (so each answer is copied there). */
async function madeInTelegram(u: Person) {
  const a = await create(u, priya);
  await db()
    .update(automations)
    .set({ sessionKey: `telegram:${u.chatId}` })
    .where(eq(automations.id, a.id));
  return a;
}
const json = (r: McpResult | undefined) => JSON.parse(r!.text) as Record<string, unknown>;

// ---------------------------------------------------------------- 4a

describe('4a: steps saved, checked per step, read back', () => {
  it("Priya's steps are saved whole: ids, titles, the send's ask-first locked on; apps from the steps", async () => {
    const u = await person();
    expect(await check(u, priya)).toEqual([]);
    const a = await create(u, { ...priya, apps: ['github'] });
    expect(a.apps).toEqual(['gmail']);
    expect(a.steps.map((s) => [s.id, s.type, s.askFirst, s.risky])).toEqual([
      ['fetch', 'action', false, false],
      ['pick', 'tex', false, false],
      ['draft', 'tex', false, false],
      ['send', 'action', true, true],
    ]);
    expect(a.steps[0]!.title).toBe('Gmail: fetch emails');
    expect(a.steps[2]).toMatchObject({
      onlyIf: { kind: 'mentions', words: ['Urgent'] },
      showResult: true,
    });
    // Read back the same; an automation made before steps has none.
    const got = await expectContract<ApiAutomation>(
      'getAutomation',
      await call(`/v1/automations/${a.id}`, { token: u.token }),
      200,
    );
    expect(got.steps).toEqual(a.steps);
    const old = await createAutomation({
      userId: u.id,
      title: 'Brief',
      instruction: 'Brief me',
      cron: '0 7 * * *',
      sessionKey: 'web',
    });
    const oldRead = await expectContract<ApiAutomation>(
      'getAutomation',
      await call(`/v1/automations/${old.id}`, { token: u.token }),
      200,
    );
    expect(oldRead.steps).toEqual([]);
    expect(await runsOf(u, old.id)).toEqual([]);
  });

  it('every problem names its step; 7 steps are refused on the list itself', async () => {
    const u = await person();
    const problems = await check(u, {
      ...priya,
      steps: [
        { id: 'a', type: 'action', app: 'gmail', action: FETCH, onlyIf: { kind: 'found' } },
        { id: 'b', type: 'tex' },
        { id: 'c', type: 'action', app: 'gmail', action: SEND, inputs: { to: 'x@y.z' } },
        { id: 'd', type: 'action', app: 'gmail', action: 'GITHUB_LIST_ISSUES' },
        { id: 'e', type: 'action', app: 'notion', action: 'NOTION_SEARCH' },
        { id: 'f', type: 'tex', instruction: 'x', onlyIf: { kind: 'mentions', words: [] } },
      ],
    });
    const by = (id: string) => problems.filter((p) => p.stepId === id).map((p) => p.message);
    expect(problems.every((p) => p.step === 'steps')).toBe(true);
    expect(by('a')).toEqual(['Step 1: the first step always runs, so it has no "only if".']);
    expect(by('b')).toEqual(['Step 2: write what Tex does in this step.']);
    expect(by('c')[0]).toMatch(
      /^Step 3: Gmail's GMAIL_SEND_EMAIL has no input `to`\. Its inputs: recipient_email, subject, body\.$/,
    );
    expect(by('d')[0]).toMatch(/^Step 4: GITHUB_LIST_ISSUES is not one of Gmail's actions/);
    expect(by('e')[0]).toMatch(/^Step 5: Notion is not connected/);
    expect(by('f')).toEqual(['Step 6: give at least one word for "mentions".']);

    const seven = Array.from({ length: 7 }, (_, i) => ({
      id: `t${i}`,
      type: 'tex',
      instruction: 'Say hi',
    }));
    expect(await check(u, { ...priya, steps: seven })).toContainEqual({
      step: 'steps',
      stepId: null,
      code: 'invalid',
      message: 'An automation has up to 6 steps.',
    });
    // The save refuses the same, per step.
    const res = await call('/v1/automations', {
      method: 'POST',
      token: u.token,
      body: { clientRequestId: randomUUID(), ...priya, steps: seven },
    });
    expect(res.status).toBe(400);
  });

  it("an app's actions for the step panel: risky marked, a search narrows; unknown app 404", async () => {
    const u = await person();
    const list = await expectContract<{
      items: Array<{
        slug: string;
        requiresApproval: boolean;
        changesSomething: boolean;
        inputs: Array<{ name: string; required: boolean }>;
      }>;
    }>('listAppActions', await call('/v1/apps/gmail/actions', { token: u.token }), 200);
    expect(list.items.map((a) => a.slug)).toEqual([FETCH, SEND, LABELS]);
    expect(list.items[1]).toMatchObject({ requiresApproval: true, changesSomething: true });
    expect(list.items[0]).toMatchObject({ requiresApproval: false, changesSomething: false });
    expect(list.items[1]!.inputs.find((i) => i.name === 'recipient_email')).toMatchObject({
      required: true,
    });
    const found = await expectContract<{ items: Array<{ slug: string }> }>(
      'listAppActions',
      await call('/v1/apps/gmail/actions?search=label', { token: u.token }),
      200,
    );
    expect(found.items.map((a) => a.slug)).toEqual([LABELS]);
    expect((await call('/v1/apps/nope/actions', { token: u.token })).status).toBe(404);
  });

  it('Tex proposes a stepped draft (outline lists the steps); a problem names the step; Save makes it', async () => {
    const u = await person({ telegram: true });
    const bad = await u.tool('propose_automation', {
      title: 'Boss mail',
      instruction: 'Reply fast to urgent mail from my boss',
      cron: '0 8 * * 1-5',
      steps: [
        { type: 'action', app: 'gmail', action: FETCH },
        { type: 'action', app: 'gmail', action: SEND, inputs: { to: 'boss@acme.com' } },
      ],
      session_key: `telegram:${u.chatId}`,
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/Step 2: Gmail's GMAIL_SEND_EMAIL has no input `to`/);

    const ok = await u.tool('propose_automation', {
      title: 'Boss mail',
      instruction: 'Reply fast to urgent mail from my boss',
      cron: '0 8 * * 1-5',
      steps: [
        {
          id: 'fetch',
          type: 'action',
          app: 'gmail',
          action: FETCH,
          inputs: { query: 'from:boss' },
        },
        {
          id: 'pick',
          type: 'tex',
          instruction: 'Pick the urgent ones',
          only_if: { kind: 'found' },
        },
        { id: 'send', type: 'action', app: 'gmail', action: SEND },
      ],
      session_key: `telegram:${u.chatId}`,
    });
    expect(ok.isError, ok.text).toBe(false);
    const draftId = String(json(ok).draft_id);
    const [d] = await db().select().from(automationDrafts).where(eq(automationDrafts.id, draftId));
    expect(d!.steps.map((s) => s.id)).toEqual(['fetch', 'pick', 'send']);
    expect(d!.apps).toEqual(['gmail']);
    // The outline in Telegram, one line per step.
    await waitFor(async () => tg.sent.some((m) => m.text.includes('Steps:')));
    const outline = tg.sent.find((m) => m.text.includes('Steps:'))!.text;
    expect(outline).toContain('1. Gmail: fetch emails (query: from:boss)');
    expect(outline).toContain('2. Tex: Pick the urgent ones — only if step 1 found something');
    expect(outline).toMatch(/3\. Gmail: send email — asks first/);

    const saved = await expectContract<{ automation: ApiAutomation }>(
      'saveAutomationDraft',
      await call(`/v1/automation-drafts/${draftId}/save`, {
        method: 'POST',
        token: u.token,
        body: {},
      }),
      200,
    );
    expect(saved.automation.steps.map((s) => s.id)).toEqual(['fetch', 'pick', 'send']);
    expect(saved.automation.enabled).toBe(true);
  });

  it('a change Tex proposes, saved without saying on or paused, keeps a paused automation paused', async () => {
    const u = await person();
    const a = await create(u, { ...priya, enabled: false });
    expect(a.enabled).toBe(false);
    const proposed = await u.tool('propose_automation', {
      title: priya.title,
      instruction: priya.instruction,
      cron: '30 8 * * 1-5',
      change_of: a.id,
      session_key: 'web',
    });
    expect(proposed.isError, proposed.text).toBe(false);
    const [d] = await db()
      .select()
      .from(automationDrafts)
      .where(and(eq(automationDrafts.userId, u.id), eq(automationDrafts.changeOf, a.id)));
    const saved = await expectContract<{ automation: ApiAutomation & { cron: string } }>(
      'saveAutomationDraft',
      await call(`/v1/automation-drafts/${d!.id}/save`, { method: 'POST', token: u.token }),
      200,
    );
    expect(saved.automation).toMatchObject({ id: a.id, enabled: false, cron: '30 8 * * 1-5' });
    // The change had no steps: it is a one-instruction automation now.
    expect(saved.automation.steps).toEqual([]);
  });

  it('where the runs answer mentions the Telegram switch "Automation runs finish"', async () => {
    const u = await person();
    const made = await u.tool('schedule_reminder', {
      text: 'Call mum',
      run_at: new Date(Date.now() + 3 * 3600_000).toISOString(),
      session_key: 'web',
    });
    expect(made.isError, made.text).toBe(false);
    expect(String(json(made).where_results_go)).toMatch(
      /No copy goes to Telegram\. If they want one there, they link a Telegram chat and turn on "Automation runs finish"/,
    );
  });
});

// ---------------------------------------------------------------- 4b

/** Priya's run with a stand-in Tex: it follows "next" in every answer, as Tex is told to. */
function priyaTex(u: Person, opts: { urgent: boolean; stray?: boolean }) {
  const seen: Record<string, McpResult> = {};
  const deliveries: Delivery[] = [];
  vmFake.state.agent = async (d, mcp) => {
    if (d.userId !== u.id) return;
    deliveries.push(d);
    if (d.kind === DeliverKind.AUTOMATION) {
      if (opts.stray) {
        seen.otherStep = await mcp('run_app_action', { action: SEND, arguments: {} });
        seen.otherApp = await mcp('run_app_action', { action: 'GITHUB_LIST_EMAILS' });
        seen.changedFixed = await mcp('run_app_action', {
          action: FETCH,
          arguments: { query: 'everything' },
        });
        seen.lookup = await mcp('run_app_action', { action: LABELS });
      }
      seen.fetch = await mcp('run_app_action', { action: FETCH });
      if (!opts.urgent) return;
      if (opts.stray)
        seen.texChanges = await mcp('run_app_action', { action: SEND, arguments: {} });
      seen.pick = await mcp('finish_step', {
        step_id: 'pick',
        result: 'One is urgent: the board deck is due today.',
      });
      seen.draft = await mcp('finish_step', {
        step_id: 'draft',
        result: 'Hi, I will send the deck by 3 PM. Priya',
      });
      if (opts.stray)
        seen.sendWithoutYes = await mcp('run_app_action', {
          action: SEND,
          arguments: { recipient_email: 'boss@acme.com', body: 'Deck by 3 PM' },
        });
      seen.ask = await mcp('request_approval', {
        summary: 'send the reply to your boss',
        action: SEND,
        arguments: { recipient_email: 'boss@acme.com', subject: 'Re: deck', body: 'Deck by 3 PM' },
        session_key: d.sessionKey,
      });
      await mcp('send_message', {
        text: 'Drafted a reply to the urgent email; it waits for your OK.',
        session_key: d.sessionKey,
      });
    } else if (d.kind === DeliverKind.APPROVAL_ANSWER && d.approved) {
      seen.send = await mcp('run_app_action', { action: SEND, approval_id: d.approvalId });
      await mcp('send_message', { text: 'Sent the reply.', session_key: d.sessionKey });
    }
  };
  return { seen, deliveries };
}

const URGENT_FETCH = {
  messages: [
    {
      messageId: 'm1',
      sender: 'boss@acme.com',
      subject: 'URGENT: board deck',
      messageText: 'Need the deck today',
    },
  ],
};

describe("4b: the runner, on Priya's example", () => {
  it('no email: the run stops after step 1, one line in the Automations chat, no Telegram copy, nothing charged', async () => {
    const u = await person({ telegram: true });
    composioFake.state.executeData.set(FETCH, { messages: [] });
    const { seen } = priyaTex(u, { urgent: false });
    const a = await madeInTelegram(u);
    await fire(a);
    await waitFor(async () => (await runsOf(u, a.id))[0]?.state === 'stopped', 15_000);
    const [run] = await runsOf(u, a.id);
    expect(run!.steps.map((s) => s.state)).toEqual(['done', 'skipped', 'skipped', 'skipped']);
    expect(run!.stopReason).toMatch(/Nothing to do: step 2 runs only if step 1 found something/);
    expect(json(seen.fetch)).toMatchObject({ ok: true, credits_charged: 0 });
    expect(String(json(seen.fetch).next)).toMatch(/The run ends here/);
    // The fixed query was put in.
    expect(composioFake.executed).toEqual([
      expect.objectContaining({
        slug: FETCH,
        arguments: expect.objectContaining({ query: 'from:boss@acme.com is:unread newer_than:1d' }),
      }),
    ]);
    await waitFor(async () => (await chatTexts(u.id)).some((t) => t.includes('Nothing to do')));
    const line = (await chatTexts(u.id)).find((t) => t.includes('Nothing to do'))!;
    expect(line).toMatch(/Steps: 1 ✓ 2 skipped 3 skipped 4 skipped/);
    // No copy of the stop to Telegram (decision 2); it is not a failure.
    await new Promise((r) => setTimeout(r, 300));
    expect(tg.sent.some((m) => m.text.includes('Nothing to do'))).toBe(false);
    const [row] = await db().select().from(automations).where(eq(automations.id, a.id));
    expect(row!.failCount).toBe(0);
  });

  it('an urgent email: steps 2 and 3, then a question; the yes sends once and charges 1 credit', async () => {
    const u = await person({ telegram: true });
    composioFake.state.executeData.set(FETCH, URGENT_FETCH);
    const { seen, deliveries } = priyaTex(u, { urgent: true, stray: true });
    const a = await madeInTelegram(u);
    await fire(a);
    await waitFor(async () => (await runsOf(u, a.id))[0]?.state === 'waiting', 15_000);

    // Refused: another step's action, another app, a changed fixed input, a change in a Tex step,
    // a send without a yes. Allowed: a look-up in the step's own app.
    expect(seen.otherStep!.isError).toBe(true);
    expect(seen.otherStep!.text).toMatch(/GMAIL_SEND_EMAIL is not step 1's action/);
    expect(seen.otherApp!.isError).toBe(true);
    expect(seen.changedFixed!.isError).toBe(true);
    expect(seen.changedFixed!.text).toMatch(/input `query` is fixed/);
    expect(seen.lookup!.isError, seen.lookup!.text).toBe(false);
    expect(seen.texChanges!.isError).toBe(true);
    expect(seen.texChanges!.text).toMatch(/Step 2 is a Tex step/);
    expect(seen.sendWithoutYes!.isError).toBe(true);
    expect(String(json(seen.fetch).next)).toMatch(/Now step 2/);
    expect(json(seen.pick)).toMatchObject({ saved: true, run_state: 'running' });
    expect(String(json(seen.draft).next)).toMatch(/Now step 4: run GMAIL_SEND_EMAIL/);
    expect(json(seen.ask)).toMatchObject({ status: 'pending', step_id: 'send' });
    expect(composioFake.executed.map((e) => e.slug)).toEqual([LABELS, FETCH]);

    const [waiting] = await runsOf(u, a.id);
    expect(waiting!.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'waiting']);
    await waitFor(async () =>
      (await chatTexts(u.id)).some((t) => t.includes('4 waiting for your OK')),
    );
    // An automation's question goes to Telegram too (the switch "An automation needs my OK", on at first).
    await waitFor(async () => tg.sent.some((m) => m.text.includes('send the reply to your boss')));
    // The answer is copied to Telegram with its trail.
    await waitFor(async () =>
      tg.sent.some((m) => m.text.includes('waits for your OK') && m.text.includes('Steps: 1 ✓')),
    );

    // The yes: Tex runs the approved send once, 1 credit.
    const approvalId = String(json(seen.ask).approval_id);
    expect((await decide(u, approvalId, 'approve')).status).toBe(200);
    await waitFor(async () => (await runsOf(u, a.id))[0]?.state === 'done', 15_000);
    expect(json(seen.send)).toMatchObject({ ok: true, credits_charged: 1 });
    expect(composioFake.executed.filter((e) => e.slug === SEND)).toHaveLength(1);
    expect(composioFake.executed.find((e) => e.slug === SEND)!.arguments).toEqual({
      recipient_email: 'boss@acme.com',
      subject: 'Re: deck',
      body: 'Deck by 3 PM',
    });
    await waitFor(async () => (await chatTexts(u.id)).some((t) => t === 'Steps: 1 ✓ 2 ✓ 3 ✓ 4 ✓'));
    expect(deliveries.map((d) => d.kind)).toEqual([
      DeliverKind.AUTOMATION,
      DeliverKind.APPROVAL_ANSWER,
    ]);

    // The answer's job runs again: nothing is sent twice.
    const [ap] = await db().select().from(approvals).where(eq(approvals.id, approvalId));
    expect(ap!.automationRunId).toBe(waiting!.id);
    await handleRunApprovalAnswer({
      data: { approvalId, userId: u.id, eventId: `again-${randomUUID()}` },
    } as unknown as Job);
    await new Promise((r) => setTimeout(r, 300));
    expect(composioFake.executed.filter((e) => e.slug === SEND)).toHaveLength(1);
  });

  it('a no skips step 4: the run stops with one line and no turn', async () => {
    const u = await person();
    composioFake.state.executeData.set(FETCH, URGENT_FETCH);
    const { seen, deliveries } = priyaTex(u, { urgent: true });
    const a = await create(u, priya);
    await fire(a);
    await waitFor(async () => (await runsOf(u, a.id))[0]?.state === 'waiting', 15_000);
    await decide(u, String(json(seen.ask).approval_id), 'reject');
    await waitFor(async () => (await runsOf(u, a.id))[0]?.state === 'stopped', 15_000);
    const [run] = await runsOf(u, a.id);
    expect(run!.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'skipped']);
    expect(run!.stopReason).toBe('You said no to step 4, so it did not run.');
    await waitFor(async () =>
      (await chatTexts(u.id)).some((t) => t.includes('You said no to step 4')),
    );
    expect(deliveries).toHaveLength(1);
    expect(composioFake.executed.some((e) => e.slug === SEND)).toBe(false);
  });

  it('a new run while one waits for a yes: the older is superseded, its question replaced', async () => {
    const u = await person();
    composioFake.state.executeData.set(FETCH, URGENT_FETCH);
    const { seen } = priyaTex(u, { urgent: true });
    const a = await create(u, priya);
    await fire(a);
    await waitFor(async () => (await runsOf(u, a.id))[0]?.state === 'waiting', 15_000);
    const firstAsk = String(json(seen.ask).approval_id);
    await fire(a);
    await waitFor(
      async () =>
        (await runsOf(u, a.id)).length === 2 && (await runsOf(u, a.id))[0]!.state === 'waiting',
      15_000,
    );
    const [newer, older] = await runsOf(u, a.id);
    expect(older!.state).toBe('superseded');
    expect(older!.steps[3]!.state).toBe('skipped');
    expect(newer!.state).toBe('waiting');
    const [ap] = await db().select().from(approvals).where(eq(approvals.id, firstAsk));
    expect(ap!.status).toBe('replaced');
    // The old question can't be answered any more.
    expect((await decide(u, firstAsk, 'approve')).status).not.toBe(200);
  });

  it('Tex ending early fails the run at its step; it counts as a failure', async () => {
    const u = await person();
    composioFake.state.executeData.set(FETCH, URGENT_FETCH);
    vmFake.state.agent = async (d, mcp) => {
      if (d.userId !== u.id) return;
      await mcp('run_app_action', { action: FETCH });
      await mcp('send_message', { text: 'Done.', session_key: d.sessionKey });
    };
    const a = await create(u, priya);
    await fire(a);
    await waitFor(async () => (await runsOf(u, a.id))[0]?.state === 'failed', 15_000);
    const [run] = await runsOf(u, a.id);
    expect(run!.stopReason).toBe('Stopped at step 2: Tex ended before finishing it.');
    await waitFor(
      async () =>
        (await db().select().from(automations).where(eq(automations.id, a.id)))[0]!.failCount === 1,
    );
  });

  it('at most 10 app calls in a step and 30 in a run; a job run again finds the same run', async () => {
    const u = await person();
    const made = await create(u, {
      ...priya,
      steps: [
        { id: 'read', type: 'tex', instruction: 'Read my labels', readApps: ['gmail'] },
        { id: 'more', type: 'tex', instruction: 'Read more' },
      ],
    });
    const [a] = await db().select().from(automations).where(eq(automations.id, made.id));
    const eventId = `evt-${randomUUID()}`;
    const { run } = await startRun(a!, eventId);
    const again = await startRun(a!, eventId);
    expect(again).toMatchObject({ created: false, run: { id: run.id } });
    const read = () => gateAppAction(u.id, run.id, { action: LABELS, args: {}, changes: false });
    for (let i = 0; i < MAX_CALLS_PER_STEP; i++) expect((await read()).ok).toBe(true);
    const eleventh = await read();
    expect(eleventh).toMatchObject({ ok: false });
    const [failed] = await db().select().from(automationRuns).where(eq(automationRuns.id, run.id));
    expect(failed!.state).toBe('failed');
    expect(failed!.stopReason).toMatch(/step 1 made 10 app calls/);

    // The whole run: 30 calls, then the 31st is refused.
    const { run: second } = await startRun(a!, `evt-${randomUUID()}`);
    await db()
      .update(automationRuns)
      .set({ appCalls: MAX_CALLS_PER_RUN })
      .where(eq(automationRuns.id, second.id));
    const thirtyFirst = await gateAppAction(u.id, second.id, {
      action: LABELS,
      args: {},
      changes: false,
    });
    expect(thirtyFirst).toMatchObject({ ok: false });
    if (!thirtyFirst.ok) expect(thirtyFirst.refusal).toMatch(/the run made 30 app calls/);
  });

  it('a run waiting 24 hours stops; results go after 2 days, runs after 30', async () => {
    const u = await person();
    const made = await create(u, priya);
    const [a] = await db().select().from(automations).where(eq(automations.id, made.id));
    const { run } = await startRun(a!, `evt-${randomUUID()}`);
    const longAgo = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await db()
      .update(automationRuns)
      .set({
        state: 'waiting',
        steps: run.steps.map((s, i) =>
          i === 0
            ? { ...s, state: 'waiting' as const, waitingSince: longAgo, result: 'secret' }
            : s,
        ),
      })
      .where(eq(automationRuns.id, run.id));
    const stopped = await expireWaitingRuns();
    expect(stopped.map((r) => r.id)).toContain(run.id);
    const [ended] = await db().select().from(automationRuns).where(eq(automationRuns.id, run.id));
    expect(ended!.state).toBe('stopped');

    await db()
      .update(automationRuns)
      .set({ endedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) })
      .where(eq(automationRuns.id, run.id));
    await cleanupRuns();
    const [cleared] = await runsOf(u, made.id);
    expect(cleared!.resultsRemoved).toBe(true);
    expect(cleared!.steps.every((s) => s.result === null)).toBe(true);
    await db()
      .update(automationRuns)
      .set({ startedAt: new Date(Date.now() - 31 * 24 * 3600 * 1000) })
      .where(eq(automationRuns.id, run.id));
    await cleanupRuns();
    expect(await runsOf(u, made.id)).toEqual([]);
  });

  it('steps switched off on the server: one line, nothing runs', async () => {
    const u = await person();
    process.env.AUTOMATION_STEPS = 'false';
    resetConfig();
    try {
      const a = await create(u, priya);
      await fire(a);
      await waitFor(async () =>
        (await chatTexts(u.id)).some((t) => t.includes('switched off on this server')),
      );
      expect(await runsOf(u, a.id)).toEqual([]);
      expect(composioFake.executed).toEqual([]);
    } finally {
      delete process.env.AUTOMATION_STEPS;
      resetConfig();
    }
  });
});
