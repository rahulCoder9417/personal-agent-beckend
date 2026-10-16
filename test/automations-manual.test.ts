// Automations on a canvas, phase 3 (docs/automations-flow-proposal.md, option A): building and
// changing one by hand. The checks without saving (every problem on its box, the next three run
// times), a save by hand once per key, a change in place (a changed app event's new watch before
// the old one goes), "Run once now" as a marked test run, Composio's list of events, the user's
// own drafts for "Ask Tex", and a run held to its automation's apps and "ask me first".
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliverKind } from '../proto-gen/vm/v1/vm_pb.ts';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { createAutomation, setMinIntervalMs } from '../src/modules/automations/automations.ts';
import { automationDrafts, automations } from '../src/modules/automations/schema.ts';
import { automationsChat } from '../src/modules/channels/conversations.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { composio, setComposioApi } from '../src/modules/integrations/composio.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { setTurnHooks } from '../src/modules/orchestrator/turn.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { redis } from '../src/shared/redis.ts';
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
  setTurnHooks({ hasCredits: async () => true });
  vmFake = installFakeVm();
});

type ApiAutomation = {
  id: string;
  kind: string;
  title: string;
  enabled: boolean;
  pausedReason: string | null;
  apps: string[];
  askFirst: string;
  copyTo: string | null;
  cron: string | null;
  runAt: string | null;
  timezone: string | null;
  trigger: { app: string; event: string; config: Record<string, unknown> } | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
};
type Problem = { step: string | null; code: string; message: string };
type Check = { ok: boolean; problems: Problem[]; kind: string | null; nextRuns: string[] };
type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };

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

async function person(
  opts: { plan?: 'free' | 'pro' | 'max'; telegram?: boolean; apps?: string[] } = {},
) {
  const u = await chatUser({ plan: opts.plan ?? 'pro', timezone: 'Asia/Kolkata' });
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
  for (const app of opts.apps ?? []) await connect(u.id, app);
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

const weekly = {
  title: 'Monday PRs',
  instruction: 'List my open pull requests in acme/web',
  cron: '0 9 * * 1',
  timezone: 'Asia/Kolkata',
  apps: ['github'],
};
const bossMail = {
  title: 'Boss emails',
  instruction: 'Say who wrote and what they want, in two lines',
  trigger: {
    app: 'gmail',
    event: 'GMAIL_NEW_GMAIL_MESSAGE',
    config: { query: 'from:boss@acme.com' },
  },
};

const check = async (u: Person, body: Record<string, unknown>) =>
  expectContract<Check>(
    'checkAutomation',
    await call('/v1/automations/check', { method: 'POST', token: u.token, body }),
    200,
  );
const create = (u: Person, body: Record<string, unknown>, key: string = randomUUID()) =>
  call('/v1/automations', {
    method: 'POST',
    token: u.token,
    body: { clientRequestId: key, ...body },
  });
const change = (u: Person, id: string, body: Record<string, unknown>) =>
  call(`/v1/automations/${id}`, { method: 'PUT', token: u.token, body });
const runNow = (u: Person, id: string, key: string = randomUUID()) =>
  call(`/v1/automations/${id}/run`, {
    method: 'POST',
    token: u.token,
    body: { clientRequestId: key },
  });
const automationsOf = (userId: string) =>
  db().select().from(automations).where(eq(automations.userId, userId));
const rowOf = async (id: string) =>
  (await db().select().from(automations).where(eq(automations.id, id)))[0]!;

async function timersOf(userId: string): Promise<number> {
  const delayed = (await queue('scheduled').getDelayed()).filter(
    (j) => (j.data as { userId?: string }).userId === userId && !j.id?.startsWith('repeat:'),
  );
  const schedulers = (await queue('scheduled').getJobSchedulers()).filter(
    (s) => (s.template?.data as { userId?: string } | undefined)?.userId === userId,
  );
  return delayed.length + schedulers.length;
}

/** Every call to Composio's triggers, in order: what was made and what was removed. */
function watchLog(): string[] {
  const log: string[] = [];
  const api = composio();
  setComposioApi({
    ...api,
    createTrigger: async (...args) => {
      const made = await api.createTrigger(...args);
      log.push(`create ${args[1]} ${made.triggerId}`);
      return made;
    },
    deleteTrigger: async (id) => {
      log.push(`delete ${id}`);
      await api.deleteTrigger(id);
    },
  });
  return log;
}

describe('check without saving: every problem on its box, and when it runs', () => {
  it('empty parts: the trigger and the instruction are named, nothing is saved', async () => {
    const u = await person();
    const r = await check(u, {});
    expect(r.ok).toBe(false);
    expect(r.kind).toBeNull();
    expect(r.problems.map((p) => p.step).sort()).toEqual(['instruction', 'instruction', 'trigger']);
    expect(await automationsOf(u.id)).toEqual([]);
  });

  it('a weekly schedule: no problems, its next three runs in the time zone', async () => {
    const u = await person({ apps: ['github'] });
    const r = await check(u, weekly);
    expect(r).toMatchObject({ ok: true, problems: [], kind: 'repeat' });
    expect(r.nextRuns).toHaveLength(3);
    for (const at of r.nextRuns) {
      const local = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(at));
      expect(local).toBe('Mon 09:00');
    }
    expect(Date.parse(r.nextRuns[1]!) - Date.parse(r.nextRuns[0]!)).toBe(7 * 24 * 3600 * 1000);
  });

  it('each refusal lands on its box', async () => {
    const u = await person({ plan: 'free', apps: ['gmail'] });
    const on = async (body: Record<string, unknown>) => (await check(u, body)).problems;
    const base = { title: 'T', instruction: 'Do it' };

    expect(await on({ ...base, runAt: new Date(Date.now() - 3600_000).toISOString() })).toEqual([
      {
        step: 'trigger',
        stepId: null,
        code: 'past',
        message: 'That moment has passed. Pick a later one.',
      },
    ]);
    expect((await on({ ...base, cron: '*/5 * * * *' }))[0]).toMatchObject({
      step: 'trigger',
      message: expect.stringMatching(/at most every 15 minutes/),
    });
    expect((await on({ ...base, cron: 'not a schedule' }))[0]!.message).toMatch(/five parts/);
    expect((await on({ ...base, cron: '0 9 * * *', timezone: 'Mars/Base' }))[0]).toMatchObject({
      step: 'trigger',
      message: '"Mars/Base" is not a time zone we know.',
    });
    expect(
      (
        await on({
          ...base,
          cron: '0 9 * * *',
          runAt: new Date(Date.now() + 3600_000).toISOString(),
        })
      )[0]!.message,
    ).toBe('Pick only one way for it to run.');
    // An app event: not connected, not an event the app has, a required setting empty.
    expect(
      (await on({ ...base, trigger: { app: 'slack', event: 'SLACK_RECEIVE_MESSAGE' } }))[0],
    ).toMatchObject({ step: 'trigger', message: expect.stringMatching(/Connect Slack first/) });
    expect(
      (await on({ ...base, trigger: { app: 'gmail', event: 'GMAIL_NO_SUCH_THING' } }))[0]!.message,
    ).toBe('Gmail has no event "GMAIL_NO_SUCH_THING". Pick one from the list.');
    expect(
      await on({
        ...base,
        trigger: { app: 'gmail', event: 'GMAIL_NEW_GMAIL_MESSAGE', config: { interval: 'often' } },
      }),
    ).toEqual([
      { step: 'trigger', stepId: null, code: 'invalid', message: '"Interval" must be a number.' },
    ]);
    // Apps: unknown, not connected; the copy: no Telegram chat linked.
    const apps = await on({ ...base, cron: '0 9 * * *', apps: ['nope', 'gmail', 'notion'] });
    expect(apps.map((p) => p.step)).toEqual(['apps', 'apps']);
    expect(apps[0]!.message).toBe('"nope" is not an app we know.');
    const copy = await on({ ...base, cron: '0 9 * * *', copyTo: 'telegram' });
    expect(copy).toEqual([
      {
        step: 'results',
        stepId: null,
        code: 'invalid',
        message: expect.stringMatching(/No Telegram chat is linked/),
      },
    ]);
  });

  it('a full plan is a problem of the whole; a change of one of its own is not counted', async () => {
    const u = await person({ plan: 'free' });
    const first = await createAutomation({
      userId: u.id,
      title: 'Daily',
      instruction: 'Brief me',
      cron: '0 8 * * *',
      sessionKey: 'web',
    });
    const r = await check(u, { title: 'Second', instruction: 'x', cron: '0 9 * * *' });
    expect(r.problems).toEqual([
      {
        step: null,
        stepId: null,
        code: 'plan_limit',
        message: 'Your Free plan allows 1 automation, and it is in use. Delete one or upgrade.',
      },
    ]);
    const asChange = await check(u, {
      title: 'Daily',
      instruction: 'Brief me',
      cron: '30 8 * * *',
      automationId: first.id,
    });
    expect(asChange.ok).toBe(true);
    // Someone else's automation can't be named.
    const other = await person();
    const res = await call('/v1/automations/check', {
      method: 'POST',
      token: other.token,
      body: { automationId: first.id },
    });
    expect(res.status).toBe(404);
  });
});

describe('save by hand', () => {
  it('each kind can be built: once, a schedule, an app event; timers and watches set', async () => {
    const u = await person({ apps: ['gmail', 'github'] });
    const once = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, {
        title: 'Call the bank',
        instruction: 'Remind me to call the bank',
        runAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
      }),
      201,
    );
    expect(once).toMatchObject({ kind: 'once', enabled: true, askFirst: 'risky', copyTo: null });
    const repeat = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, { ...weekly, askFirst: 'changes' }),
      201,
    );
    expect(repeat).toMatchObject({ kind: 'repeat', apps: ['github'], askFirst: 'changes' });
    const event = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, bossMail),
      201,
    );
    expect(event.trigger).toEqual(bossMail.trigger);
    expect(await timersOf(u.id)).toBe(2);
    expect(composioFake.triggers.map((t) => t.slug)).toEqual(['GMAIL_NEW_GMAIL_MESSAGE']);
    expect((await rowOf(event.id)).triggerRef).toBe(composioFake.triggers[0]!.triggerId);
  });

  it('Save paused: no timer; the same key again makes nothing more; two at once make one', async () => {
    const u = await person({ apps: ['github', 'gmail'] });
    const key = randomUUID();
    const paused = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, { ...weekly, enabled: false }, key),
      201,
    );
    expect(paused).toMatchObject({ enabled: false, pausedReason: 'user' });
    expect(await timersOf(u.id)).toBe(0);
    const again = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, { ...weekly, enabled: false }, key),
      200,
    );
    expect(again.id).toBe(paused.id);

    // A double click on an app event: one automation, one watch.
    const twice = randomUUID();
    const [a, b] = await Promise.all([create(u, bossMail, twice), create(u, bossMail, twice)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const ids = new Set([
      ((await a.json()) as { id: string }).id,
      ((await b.json()) as { id: string }).id,
    ]);
    expect(ids.size).toBe(1);
    expect(await automationsOf(u.id)).toHaveLength(2);
    expect(composioFake.triggers).toHaveLength(1);
  });

  it('a refusal says what, per box (400); a full plan is 403 with the problem', async () => {
    const u = await person({ plan: 'free' });
    const bad = await create(u, { title: '', instruction: 'x', cron: '*/5 * * * *' });
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as ErrorBody;
    expect((body.error.details!.problems as Problem[]).map((p) => p.step)).toEqual([
      'instruction',
      'trigger',
    ]);
    await expectContract('createAutomation', await create(u, { ...weekly, apps: [] }), 201);
    const full = await create(u, { ...weekly, apps: [], title: 'Another' });
    expect(full.status).toBe(403);
    const fb = (await full.json()) as ErrorBody;
    expect(fb.error.code).toBe('plan_limit');
    expect((fb.error.details!.problems as Problem[])[0]!.code).toBe('plan_limit');
    expect(await automationsOf(u.id)).toHaveLength(1);
  });

  it('a copy to the linked Telegram chat; a draft open on the canvas is marked saved with it', async () => {
    const u = await person({ telegram: true, apps: ['github'] });
    const proposed = JSON.parse(
      (await u.tool('propose_automation', { ...weekly, session_key: 'web' })).text,
    ) as { draft_id: string };
    const made = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, {
        ...weekly,
        cron: '30 8 * * 1',
        copyTo: 'telegram',
        draftId: proposed.draft_id,
      }),
      201,
    );
    expect(made.copyTo).toBe('telegram');
    expect((await rowOf(made.id)).sessionKey).toBe(`telegram:${u.chatId}`);
    const [d] = await db()
      .select()
      .from(automationDrafts)
      .where(eq(automationDrafts.id, proposed.draft_id));
    expect(d).toMatchObject({ status: 'saved', automationId: made.id });
    // Saved once: the same draft again is 409, and nothing more is made.
    const again = await create(u, { ...weekly, draftId: proposed.draft_id });
    expect(again.status).toBe(409);
    expect(((await again.json()) as ErrorBody).error.details).toMatchObject({ status: 'saved' });
    expect(await automationsOf(u.id)).toHaveLength(1);
  });
});

describe('change in place', () => {
  it('a new schedule keeps the id and moves the timer; "enabled" left out keeps it paused', async () => {
    const u = await person({ apps: ['github'] });
    const a = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, { ...weekly, enabled: false }),
      201,
    );
    const changed = await expectContract<ApiAutomation>(
      'changeAutomation',
      await change(u, a.id, { ...weekly, cron: '0 10 * * 2', title: 'Tuesday PRs' }),
      200,
    );
    expect(changed).toMatchObject({
      id: a.id,
      cron: '0 10 * * 2',
      title: 'Tuesday PRs',
      enabled: false,
    });
    expect(await timersOf(u.id)).toBe(0);
    const on = await expectContract<ApiAutomation>(
      'changeAutomation',
      await change(u, a.id, { ...weekly, cron: '0 10 * * 2', enabled: true }),
      200,
    );
    expect(on.enabled).toBe(true);
    expect((await queue('scheduled').getJobScheduler(`auto-${a.id}`))?.pattern).toBe('0 10 * * 2');
    // Back to a moment: the schedule goes, a one-time timer comes.
    await expectContract(
      'changeAutomation',
      await change(u, a.id, {
        title: 'Once',
        instruction: 'x',
        runAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
      200,
    );
    expect(await queue('scheduled').getJobScheduler(`auto-${a.id}`)).toBeFalsy();
    expect(await timersOf(u.id)).toBe(1);
    expect(await automationsOf(u.id)).toHaveLength(1);
  });

  it('a changed app event: the new watch first, then the old one goes; exactly one is left', async () => {
    const u = await person({ apps: ['gmail', 'github'] });
    const a = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, bossMail),
      201,
    );
    const oldRef = (await rowOf(a.id)).triggerRef!;
    const log = watchLog();

    // The same event and settings, only the words changed: the watch stays as it is.
    await expectContract(
      'changeAutomation',
      await change(u, a.id, { ...bossMail, instruction: 'One line only' }),
      200,
    );
    expect(log).toEqual([]);
    expect((await rowOf(a.id)).triggerRef).toBe(oldRef);

    // Another sender: a new watch, then the old one removed.
    await expectContract(
      'changeAutomation',
      await change(u, a.id, {
        ...bossMail,
        trigger: { ...bossMail.trigger, config: { query: 'from:ceo@acme.com' } },
      }),
      200,
    );
    const newRef = (await rowOf(a.id)).triggerRef!;
    expect(newRef).not.toBe(oldRef);
    expect(log).toEqual([`create GMAIL_NEW_GMAIL_MESSAGE ${newRef}`, `delete ${oldRef}`]);
    expect(composioFake.triggers.map((t) => t.triggerId)).toEqual([newRef]);

    // Composio refuses the next watch: nothing changes, the current watch stays.
    composioFake.state.triggerError = new Error('composio down');
    const refused = await change(u, a.id, {
      ...bossMail,
      trigger: {
        app: 'github',
        event: 'GITHUB_PULL_REQUEST_EVENT',
        config: { owner: 'acme', repo: 'web' },
      },
    });
    expect(refused.status).toBe(503);
    expect((await rowOf(a.id)).trigger?.app).toBe('gmail');
    expect(composioFake.triggers.map((t) => t.triggerId)).toEqual([newRef]);

    // From an app event to a schedule: the watch goes.
    await expectContract('changeAutomation', await change(u, a.id, weekly), 200);
    expect(composioFake.triggers).toEqual([]);
    expect((await rowOf(a.id)).triggerRef).toBeNull();
  });

  it('pull-request review, a finished reminder and another user’s automation are refused', async () => {
    const u = await person({ apps: ['github'] });
    const review = await createAutomation({
      userId: u.id,
      title: 'Review pull requests in acme/web',
      instruction: 'Have Patch review it',
      trigger: {
        app: 'github',
        event: 'GITHUB_PULL_REQUEST_EVENT',
        config: { owner: 'acme', repo: 'web' },
      },
      preset: 'pr_review',
      sessionKey: 'web',
    });
    expect((await change(u, review.id, weekly)).status).toBe(409);
    const done = await createAutomation({
      userId: u.id,
      title: 'Done',
      instruction: 'x',
      runAt: new Date(Date.now() + 3600_000),
      sessionKey: 'web',
    });
    await db()
      .update(automations)
      .set({ completedAt: new Date() })
      .where(eq(automations.id, done.id));
    expect((await change(u, done.id, weekly)).status).toBe(409);
    const other = await person({ apps: ['github'] });
    expect((await change(other, review.id, weekly)).status).toBe(404);
  });

  it('a change Tex proposed, edited and saved on the canvas: in place, the draft marked saved', async () => {
    const u = await person({ apps: ['github'] });
    const a = await expectContract<ApiAutomation>('createAutomation', await create(u, weekly), 201);
    const proposed = JSON.parse(
      (
        await u.tool('propose_automation', {
          ...weekly,
          cron: '0 8 * * 1',
          change_of: a.id,
          session_key: 'web',
        })
      ).text,
    ) as { draft_id: string };
    // A draft of a change can't be saved as a new automation.
    expect((await create(u, { ...weekly, draftId: proposed.draft_id })).status).toBe(409);
    await expectContract(
      'changeAutomation',
      await change(u, a.id, { ...weekly, cron: '15 8 * * 1', draftId: proposed.draft_id }),
      200,
    );
    expect((await rowOf(a.id)).cron).toBe('15 8 * * 1');
    const [d] = await db()
      .select()
      .from(automationDrafts)
      .where(eq(automationDrafts.id, proposed.draft_id));
    expect(d!.status).toBe('saved');
  });
});

describe('run once now', () => {
  it('a paused automation runs once, marked as a test; its schedule and state stay', async () => {
    const u = await person({ telegram: true, apps: ['github'] });
    const deliveries: Delivery[] = [];
    vmFake.state.agent = async (d, mcp) => {
      if (d.userId !== u.id) return;
      deliveries.push(d);
      await mcp('send_message', {
        text: 'Test run: 2 open pull requests.',
        session_key: d.sessionKey,
      });
    };
    const a = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, { ...weekly, enabled: false, copyTo: 'telegram' }),
      201,
    );
    const key = randomUUID();
    const queued = await expectContract<{ eventId: string }>(
      'runAutomationNow',
      await runNow(u, a.id, key),
      202,
    );
    await waitFor(async () => deliveries.length > 0 && tg.sent.length > 0, 15_000);
    expect(deliveries[0]!.kind).toBe(DeliverKind.AUTOMATION);
    expect(deliveries[0]!.text).toMatch(
      /^\[Test run of automation "Monday PRs", started by the user/,
    );
    expect(JSON.parse(deliveries[0]!.metadataJson!)).toMatchObject({
      test_run: true,
      automationId: a.id,
    });

    // The line before it in the Automations chat; the copy on Telegram marked "Test run".
    const chat = await automationsChat(u.id);
    const lines = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, u.id), eq(messages.conversationId, chat.id)));
    expect(lines.map((m) => m.text)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^🧪 Test run of "Monday PRs", started by you/),
        'Test run: 2 open pull requests.',
      ]),
    );
    expect(tg.sent.at(-1)!.text).toMatch(/^🧪 Test run: Monday PRs/);

    // Still paused, its next run and last run untouched, no failure counted.
    const row = await rowOf(a.id);
    expect(row).toMatchObject({
      enabled: false,
      pausedReason: 'user',
      failCount: 0,
      lastRunAt: null,
    });
    // The same key again: the same run, no second delivery.
    const again = await expectContract<{ eventId: string }>(
      'runAutomationNow',
      await runNow(u, a.id, key),
      202,
    );
    expect(again.eventId).toBe(queued.eventId);
    await new Promise((r) => setTimeout(r, 300));
    expect(deliveries).toHaveLength(1);
  });

  it('a one-time reminder is not finished by its test; an app event’s test says there is no event', async () => {
    const u = await person({ apps: ['gmail'] });
    const texts: string[] = [];
    vmFake.state.agent = async (d, mcp) => {
      if (d.userId !== u.id) return;
      texts.push(d.text);
      await mcp('send_message', { text: 'ok', session_key: d.sessionKey });
    };
    const once = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, {
        title: 'Bank',
        instruction: 'Remind me',
        runAt: new Date(Date.now() + 3600_000).toISOString(),
      }),
      201,
    );
    await expectContract('runAutomationNow', await runNow(u, once.id), 202);
    await waitFor(async () => texts.length === 1, 15_000);
    const row = await rowOf(once.id);
    expect(row.completedAt).toBeNull();
    expect(row.enabled).toBe(true);
    expect(await timersOf(u.id)).toBe(1);

    const event = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, bossMail),
      201,
    );
    await expectContract('runAutomationNow', await runNow(u, event.id), 202);
    await waitFor(async () => texts.length === 2, 15_000);
    expect(texts[1]).toMatch(/No app event happened, so there is no event data/);
  });

  it('at most 10 an hour; 402 at zero credits; pull-request review has none', async () => {
    const u = await person({ apps: ['github'] });
    vmFake.state.agent = async () => {};
    const a = await expectContract<ApiAutomation>('createAutomation', await create(u, weekly), 201);
    for (let i = 0; i < 10; i++) expect((await runNow(u, a.id)).status).toBe(202);
    expect((await runNow(u, a.id)).status).toBe(429);
    // The ten runs are not what this test is about: they are taken off the queue. A worker may take
    // one between the listing and the removal (it is then locked): that one just runs.
    for (const job of await queue('inbound').getJobs(['waiting', 'prioritized', 'delayed']))
      if ((job.data as { automationId?: string }).automationId === a.id)
        await job.remove().catch((err: unknown) => {
          if (!/locked by another worker/.test(String(err))) throw err;
        });

    const broke = await person({ apps: ['github'] });
    const b = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(broke, weekly),
      201,
    );
    setTurnHooks({ hasCredits: async (id) => id !== broke.id });
    expect((await runNow(broke, b.id)).status).toBe(402);
    setTurnHooks({ hasCredits: async () => true });

    const review = await createAutomation({
      userId: broke.id,
      title: 'Review',
      instruction: 'x',
      trigger: {
        app: 'github',
        event: 'GITHUB_PULL_REQUEST_EVENT',
        config: { owner: 'a', repo: 'b' },
      },
      preset: 'pr_review',
      sessionKey: 'web',
    });
    expect((await runNow(broke, review.id)).status).toBe(409);
    expect((await runNow(u, review.id)).status).toBe(404);
  });
});

describe("Composio's list of events", () => {
  it("an app's events with their settings, kept for a while; an unknown app 404; Composio down 503", async () => {
    const u = await person();
    const list = await expectContract<{ items: Array<{ slug: string; settings: unknown[] }> }>(
      'listAppEvents',
      await call('/v1/apps/github/events', { token: u.token }),
      200,
    );
    expect(list.items.map((e) => e.slug)).toEqual([
      'GITHUB_PULL_REQUEST_EVENT',
      'GITHUB_COMMIT_EVENT',
    ]);
    expect(list.items[0]!.settings).toEqual([
      {
        name: 'owner',
        title: 'Owner',
        description: 'Owner of the repository',
        type: 'string',
        required: true,
      },
      {
        name: 'repo',
        title: 'Repo',
        description: 'Repository name',
        type: 'string',
        required: true,
      },
    ]);
    await call('/v1/apps/github/events', { token: u.token });
    expect(composioFake.state.triggerTypeLookups).toEqual(['github']);
    expect((await call('/v1/apps/nope/events', { token: u.token })).status).toBe(404);
    composioFake.state.triggerTypesError = new Error('down');
    expect((await call('/v1/apps/slack/events', { token: u.token })).status).toBe(503);
  });

  it('a draft Tex proposes with an event the app does not have is refused at once', async () => {
    const u = await person({ apps: ['gmail'] });
    const r = await u.tool('propose_automation', {
      ...bossMail,
      trigger: { app: 'gmail', event: 'GMAIL_NEW_EMAIL_FROM_BOSS' },
      session_key: 'web',
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Gmail has no event "GMAIL_NEW_EMAIL_FROM_BOSS"/);
  });
});

describe('the user’s own draft, for "Ask Tex to change this"', () => {
  it('kept as madeBy user, not posted in a chat; it replaces the draft it started from; Tex’s new one keeps the change', async () => {
    const u = await person({ apps: ['github'] });
    const a = await expectContract<ApiAutomation>('createAutomation', await create(u, weekly), 201);
    const texDraft = JSON.parse(
      (
        await u.tool('propose_automation', {
          ...weekly,
          cron: '0 8 * * 1',
          change_of: a.id,
          session_key: 'web',
        })
      ).text,
    ) as { draft_id: string };
    const before = await db().select().from(messages).where(eq(messages.userId, u.id));

    const mine = await expectContract<{
      id: string;
      madeBy: string;
      changeOf: string;
      askFirst: string;
    }>(
      'createAutomationDraft',
      await call('/v1/automation-drafts', {
        method: 'POST',
        token: u.token,
        body: {
          ...weekly,
          cron: '0 7 * * 1',
          askFirst: 'changes',
          replacesDraftId: texDraft.draft_id,
        },
      }),
      201,
    );
    expect(mine).toMatchObject({ madeBy: 'user', changeOf: a.id, askFirst: 'changes' });
    const [old] = await db()
      .select()
      .from(automationDrafts)
      .where(eq(automationDrafts.id, texDraft.draft_id));
    expect(old).toMatchObject({ status: 'replaced', replacedBy: mine.id });
    expect(await db().select().from(messages).where(eq(messages.userId, u.id))).toHaveLength(
      before.length,
    );

    // Tex reads it and proposes again, replacing it; the change is still of the same automation.
    const read = await u.tool('get_automation_draft', { draft_id: mine.id });
    expect(JSON.parse(read.text)).toMatchObject({ madeBy: 'user', cron: '0 7 * * 1' });
    const next = JSON.parse(
      (
        await u.tool('propose_automation', {
          ...weekly,
          cron: '0 7 * * 1',
          replaces_draft_id: mine.id,
          session_key: 'web',
        })
      ).text,
    ) as { draft_id: string; review_link: string };
    expect(next.review_link).toContain(`/automations/${a.id}?draft=`);
    // Nothing ran: still one automation, on its old schedule.
    expect((await rowOf(a.id)).cron).toBe('0 9 * * 1');
  });

  it('it needs one way to run; another user’s automation or draft is not taken', async () => {
    const u = await person();
    const r = await call('/v1/automation-drafts', {
      method: 'POST',
      token: u.token,
      body: { title: 'x', instruction: 'y' },
    });
    expect(r.status).toBe(400);
    const owner = await person();
    const theirs = await createAutomation({
      userId: owner.id,
      title: 'T',
      instruction: 'x',
      cron: '0 9 * * *',
      sessionKey: 'web',
    });
    const r2 = await call('/v1/automation-drafts', {
      method: 'POST',
      token: u.token,
      body: { title: 'x', instruction: 'y', cron: '0 9 * * *', changeOf: theirs.id },
    });
    expect(r2.status).toBe(400);
  });
});

describe("a run is held to its automation's apps and its 'ask me first'", () => {
  it('only the apps on its canvas (and the trigger’s); approvals for another app refused; a message turn is free', async () => {
    const u = await person({ apps: ['gmail', 'github'] });
    const results: Record<string, McpResult> = {};
    vmFake.state.agent = async (d, mcp) => {
      if (d.userId !== u.id) return;
      if (d.kind === DeliverKind.AUTOMATION) {
        results.other = await mcp('run_app_action', { action: 'GITHUB_LIST_EMAILS' });
        results.own = await mcp('run_app_action', { action: 'GMAIL_LIST_EMAILS' });
        results.ask = await mcp('request_approval', {
          summary: 'Send it',
          action: 'GITHUB_SEND_EMAIL',
          arguments: {},
        });
      } else {
        results.message = await mcp('run_app_action', { action: 'GITHUB_LIST_EMAILS' });
      }
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    const a = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, {
        title: 'Inbox',
        instruction: 'Read my inbox',
        cron: '0 9 * * *',
        apps: ['gmail'],
      }),
      201,
    );
    await expectContract('runAutomationNow', await runNow(u, a.id), 202);
    await waitFor(async () => results.ask, 15_000);
    expect(results.other!.isError).toBe(true);
    expect(results.other!.text).toMatch(/The automation "Inbox" may only use Gmail/);
    expect(results.own!.isError, results.own!.text).toBe(false);
    expect(results.ask!.isError).toBe(true);
    expect(results.ask!.text).toMatch(/may only use Gmail/);
    expect(composioFake.executed.map((e) => e.slug)).toEqual(['GMAIL_LIST_EMAILS']);

    // The user's own message: any connected app.
    await call('/v1/messages', {
      method: 'POST',
      token: u.token,
      body: { text: 'check github', clientMessageId: randomUUID() },
    });
    await waitFor(async () => results.message, 15_000);
    expect(results.message!.isError, results.message!.text).toBe(false);
  });

  it('none named: any connected app; the trigger’s app always', async () => {
    const u = await person({ apps: ['gmail', 'github'] });
    const results: McpResult[] = [];
    vmFake.state.agent = async (d, mcp) => {
      if (d.userId !== u.id) return;
      results.push(await mcp('run_app_action', { action: 'GITHUB_LIST_EMAILS' }));
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    const any = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, { title: 'Any', instruction: 'x', cron: '0 9 * * *' }),
      201,
    );
    await expectContract('runAutomationNow', await runNow(u, any.id), 202);
    const watch = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, {
        title: 'PRs',
        instruction: 'x',
        trigger: {
          app: 'github',
          event: 'GITHUB_PULL_REQUEST_EVENT',
          config: { owner: 'a', repo: 'b' },
        },
        apps: ['gmail'],
      }),
      201,
    );
    await expectContract('runAutomationNow', await runNow(u, watch.id), 202);
    await waitFor(async () => results.length === 2, 15_000);
    expect(
      results.map((r) => r.isError),
      results.map((r) => r.text).join(' | '),
    ).toEqual([false, false]);
  });

  it('"ask me first" before any change: a change that is not risky waits for a yes in that run', async () => {
    const u = await person({ apps: ['gmail'] });
    const results: McpResult[] = [];
    vmFake.state.agent = async (d, mcp) => {
      if (d.userId !== u.id) return;
      results.push(
        await mcp('run_app_action', { action: 'GMAIL_CREATE_LABEL', arguments: { name: 'x' } }),
      );
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    const strict = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, {
        title: 'Strict',
        instruction: 'x',
        cron: '0 9 * * *',
        askFirst: 'changes',
      }),
      201,
    );
    await expectContract('runAutomationNow', await runNow(u, strict.id), 202);
    await waitFor(async () => results.length === 1, 15_000);
    expect(results[0]!.isError).toBe(true);
    expect(results[0]!.text).toMatch(/asks the user first before anything that changes something/);

    const usual = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, { title: 'Usual', instruction: 'x', cron: '0 10 * * *' }),
      201,
    );
    await expectContract('runAutomationNow', await runNow(u, usual.id), 202);
    await waitFor(async () => results.length === 2, 15_000);
    expect(results[1]!.isError, results[1]!.text).toBe(false);
  });

  it('a note of the turn that cannot be read refuses the action', async () => {
    const u = await person({ apps: ['gmail'] });
    let result: McpResult | undefined;
    vmFake.state.agent = async (d, mcp) => {
      if (d.userId !== u.id) return;
      await redis().set(`turn-conversation:${u.id}`, '{not json', 'EX', 60);
      result = await mcp('run_app_action', { action: 'GMAIL_LIST_EMAILS' });
      await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    };
    const a = await expectContract<ApiAutomation>(
      'createAutomation',
      await create(u, { title: 'Inbox', instruction: 'x', cron: '0 9 * * *', apps: ['gmail'] }),
      201,
    );
    await expectContract('runAutomationNow', await runNow(u, a.id), 202);
    await waitFor(async () => result, 15_000);
    expect(result!.isError).toBe(true);
    expect(result!.text).toMatch(/Could not check this turn just now/);
  });
});
