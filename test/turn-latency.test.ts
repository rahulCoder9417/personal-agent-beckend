// Where a turn's time goes, and the waits cut from it: the quick reply written while Jev decides,
// the container woken while Jev decides, the per-turn timings row (never any text), and a message
// sent right after an answer not losing 2 s to the per-user lock.
import { randomUUID } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { getEvent } from '../src/modules/events/intake.ts';
import { acquireUserLock, releaseUserLock } from '../src/modules/orchestrator/lock.ts';
import { sendWebMessage } from '../src/modules/orchestrator/process-message.ts';
import { runTurn } from '../src/modules/orchestrator/turn.ts';
import {
  QUICK_REPLY_EARLY_MAX_CHARS,
  setChatCompleter,
  setJevClient,
  setRoutingAppsProvider,
  type JevDecision,
} from '../src/modules/orchestrator/routing.ts';
import { agentSettings, turnTimings } from '../src/modules/orchestrator/schema.ts';
import {
  parseBridgeReport,
  recentTurnTimings,
  turnStages,
  verdict,
} from '../src/modules/orchestrator/timings.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakeVm } from './fakes.ts';
import { chatUser, createUser, waitFor } from './helpers.ts';

/** A promise and the function that settles it: lets a test hold Jev or the model at one point. */
function gate<T>() {
  let open!: (v: T) => void;
  const shut = new Promise<T>((r) => (open = r));
  return { shut, open };
}

let workers: Worker[];
let vmFake: ReturnType<typeof installFakeVm>;
/** What happened, in order: `jev:asked`, `jev:answered`, `chat:asked`, `wake`. */
let steps: string[];
let jevAnswer: () => Promise<JevDecision>;
let chatAnswer: () => Promise<string>;
let chatSignals: Array<AbortSignal | undefined>;

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
  setJevClient(undefined);
  setChatCompleter(undefined);
});
beforeEach(() => {
  vmFake = installFakeVm();
  steps = [];
  chatSignals = [];
  vmFake.state.onWake = async () => void steps.push('wake');
  jevAnswer = async () => ({ route: 'task', confidence: 0.9, apps: [] });
  chatAnswer = async () => 'Hello! How can I help?';
  setJevClient({
    async decide() {
      steps.push('jev:asked');
      const answer = await jevAnswer();
      steps.push('jev:answered');
      return answer;
    },
  });
  setChatCompleter(async ({ signal }) => {
    steps.push('chat:asked');
    chatSignals.push(signal);
    return chatAnswer();
  });
  setRoutingAppsProvider(async () => []);
});
afterEach(() => {
  delete process.env.WAKE_WHILE_ROUTING;
  resetConfig();
});

/** Sends a web message and waits until its job ended; returns the event id. */
async function send(userId: string, text: string): Promise<string> {
  const { eventId } = await sendWebMessage(userId, { text, clientMessageId: randomUUID() });
  await waitFor(async () => {
    const status = (await getEvent(eventId))?.status;
    return status === 'done' || status === 'failed' || status === 'ignored';
  });
  return eventId;
}

async function timingRow(deliveryId: string) {
  return waitFor(async () => {
    const [row] = await db()
      .select()
      .from(turnTimings)
      .where(eq(turnTimings.deliveryId, deliveryId));
    return row?.outcome && row.outcome !== 'retry' ? row : undefined;
  });
}

const sentReplies = async (userId: string) =>
  (await db().select().from(messages).where(eq(messages.userId, userId)))
    .filter((m) => m.direction === 'out')
    .map((m) => m.text);

describe('a greeting: the quick reply is written while Jev decides', () => {
  it("a short message's quick reply starts before Jev answers, and is the answer when Jev says simple", async () => {
    const user = await chatUser();
    const jev = gate<JevDecision>();
    jevAnswer = () => jev.shut;
    const sending = send(user.id, 'hlo friend');
    // The model was asked while Jev had not answered yet.
    await waitFor(async () => steps.includes('chat:asked') && steps.includes('jev:asked'));
    expect(steps).not.toContain('jev:answered');
    jev.open({ route: 'simple', confidence: 0.95, apps: [] });
    const eventId = await sending;
    expect(await sentReplies(user.id)).toEqual(['Hello! How can I help?']);
    expect(chatSignals[0]?.aborted).toBe(false);
    expect(vmFake.deliveries).toHaveLength(0);

    const row = await timingRow(eventId);
    expect(row).toMatchObject({
      route: 'simple',
      outcome: 'simple',
      kind: 'message',
      channel: 'web',
    });
    const routing = (row.details as { routing: Record<string, unknown> }).routing;
    expect(routing.quickReplyEarly).toBe(true);
    expect(typeof routing.jevMs).toBe('number');
    expect(typeof routing.quickReplyMs).toBe('number');
    for (const stage of ['queued', 'picked_up', 'turn_started', 'routed', 'answered', 'finished'])
      expect(row.stages[stage], stage).toBeTypeOf('number');
    expect(turnStages(row).map((s) => s.name)).toEqual(['queue', 'prepare', 'route', 'reply']);
    expect(verdict(row)).toMatch(/^biggest: /);
    // Never the message or the answer.
    expect(JSON.stringify(row)).not.toMatch(/friend|How can I help/);
  });

  it('when Jev says task, the quick reply is dropped and its request aborted', async () => {
    const user = await chatUser();
    const model = gate<string>();
    chatAnswer = () => model.shut; // the model is slower than Jev
    await send(user.id, 'what is on my calendar today?');
    model.open('You have nothing today!');
    expect(chatSignals[0]?.aborted).toBe(true);
    expect(vmFake.deliveries).toHaveLength(1);
    expect(await sentReplies(user.id)).toEqual(['echo: what is on my calendar today?']);
  });

  it("a long message's quick reply is asked for only after Jev says simple", async () => {
    const user = await chatUser();
    const long = `please ${'x'.repeat(QUICK_REPLY_EARLY_MAX_CHARS)}`;
    await send(user.id, long);
    expect(steps).not.toContain('chat:asked'); // a task: never asked
    jevAnswer = async () => ({ route: 'simple', confidence: 0.95, apps: [] });
    await send(user.id, `${long} again`);
    expect(steps.indexOf('chat:asked')).toBeGreaterThan(steps.lastIndexOf('jev:answered'));
  });

  it('the quick reply model is told to pass on a follow-up (a yes, a no, a choice)', async () => {
    const { quickReplyPrompt } = await import('../src/modules/orchestrator/routing.ts');
    for (const channel of ['web', 'telegram'] as const) {
      const prompt = quickReplyPrompt(channel);
      expect(prompt).toContain('answers or continues something said earlier in the chat');
      expect(prompt).toContain('ESCALATE');
    }
  });
});

describe('the container wakes while Jev decides', () => {
  it('the wake starts before Jev answers, and the task does not wake twice', async () => {
    const user = await chatUser();
    const jev = gate<JevDecision>();
    jevAnswer = () => jev.shut;
    const sending = send(user.id, 'email Bob the invoice please, with the PDF attached');
    await waitFor(async () => steps.includes('wake'));
    expect(steps).not.toContain('jev:answered');
    jev.open({ route: 'task', confidence: 0.9, apps: [] });
    const eventId = await sending;
    expect(vmFake.wakes).toEqual([user.id]);
    expect(vmFake.deliveries).toHaveLength(1);
    const row = await timingRow(eventId);
    // The wake began before the route was known (the same millisecond at the closest: Jev answered
    // only once the wake was seen above).
    expect(row.stages.wake_started).toBeLessThanOrEqual(row.stages.routed!);
  });

  it('a simple message leaves the woken container idle; with WAKE_WHILE_ROUTING=false nothing wakes', async () => {
    const user = await chatUser();
    jevAnswer = async () => ({ route: 'simple', confidence: 0.95, apps: [] });
    await send(user.id, 'thanks!');
    // Nobody waits for that wake, so it may reach the vm-manager after the answer went out.
    await waitFor(async () => vmFake.wakes.length > 0);
    expect(vmFake.wakes).toEqual([user.id]);
    expect(vmFake.deliveries).toHaveLength(0);

    process.env.WAKE_WHILE_ROUTING = 'false';
    resetConfig();
    await send(user.id, 'thanks again!');
    expect(vmFake.wakes).toEqual([user.id]);
  });

  it('a wake that fails while routing does not fail a simple message', async () => {
    const user = await chatUser();
    jevAnswer = async () => ({ route: 'simple', confidence: 0.95, apps: [] });
    vmFake.state.wakeError = new Error('vm-manager down');
    const eventId = await send(user.id, 'good morning');
    expect((await getEvent(eventId))?.status).toBe('done');
    expect(await sentReplies(user.id)).toEqual(['Hello! How can I help?']);
  });

  it('a Claude plan answers everything itself: no Jev, no quick reply', async () => {
    const user = await chatUser();
    await db().insert(agentSettings).values({
      userId: user.id,
      runtime: 'claude_code',
      claudeConnectedAt: new Date(),
      claudeModel: 'claude-opus-5-5',
      claudeEffort: 'medium',
    });
    const eventId = await send(user.id, 'hlo');
    expect(steps.filter((s) => s !== 'wake')).toEqual([]);
    expect(vmFake.deliveries).toHaveLength(1);
    const meta = JSON.parse(
      (vmFake.deliveries[0] as unknown as { metadataJson: string }).metadataJson,
    );
    // The settings were read once for the engine and the model.
    expect(meta.claude).toEqual({ model: 'claude-opus-5-5', effort: 'medium' });
    const row = await timingRow(eventId);
    expect(row).toMatchObject({ route: 'task', engine: 'claude_code', outcome: 'done' });
  });
});

describe('the timings of an agent turn', () => {
  const bridge = {
    v: 1,
    engine: 'claude_code',
    runs: 1,
    marks: {
      engine_start: 15,
      engine_ready: 1800,
      first_response: 3500,
      first_thinking: 3510,
      first_tool: 4200,
      first_text: 6100,
      engine_done: 9000,
      answer_sent: 9100,
    },
    tools_ms: 700,
    crew_ms: 0,
    crew: [],
    cli: { duration_ms: 7200, duration_api_ms: 6000, num_turns: 2, cache_read_input_tokens: 41000 },
  };

  it('a cold wake and the Bridge report are stored, as stages after the message was queued', async () => {
    const user = await chatUser();
    vmFake.state.wakeTimings = {
      lockWaitMs: 0n,
      capacityWaitMs: 4n,
      evicted: false,
      recreated: false,
      containerStartMs: 1900n,
      bridgeReadyMs: 2600n,
    };
    vmFake.state.bridgeTimings = JSON.stringify(bridge);
    const eventId = await send(user.id, 'what is on my calendar?');
    const row = await timingRow(eventId);
    expect(row).toMatchObject({ route: 'task', wake: 'cold', engine: 'hermes', outcome: 'done' });
    const s = row.stages;
    for (const stage of ['woken', 'deliver_sent', 'accepted', 'turn_done', 'finished'])
      expect(s[stage], stage).toBeTypeOf('number');
    // The Bridge's marks are placed after the moment the worker heard it accept.
    expect(s.engine_ready).toBe(s.accepted! + 1800);
    expect(s.answer_sent).toBe(s.accepted! + 9100);
    const details = row.details as Record<string, Record<string, unknown>>;
    expect(details.wake).toMatchObject({
      wasStopped: true,
      containerStartMs: 1900,
      bridgeReadyMs: 2600,
    });
    expect(details.bridge).toEqual(bridge);
    const names = turnStages(row).map((st) => st.name);
    expect(names).toEqual([
      'queue',
      'prepare',
      'route',
      'wake',
      'context',
      'handover',
      'engine start',
      'first output',
      'work',
      'send answer',
      'wrap up',
    ]);
    const work = turnStages(row).find((st) => st.name === 'work')!;
    expect(work.ms).toBe(9000 - 4200);
    expect(work.note).toContain('tools 0.70 s');
    expect(verdict(row)).toContain('biggest: work');
    expect(JSON.stringify(row)).not.toContain('calendar');
  });

  it('a warm container and an out-of-credits answer are told apart', async () => {
    const user = await chatUser();
    vmFake.state.wasStopped = false;
    const eventId = await send(user.id, 'hey there, can you check my mail');
    expect((await timingRow(eventId)).wake).toBe('warm');

    // At zero credits the worker answers itself (the api refuses first; a message queued before
    // the credits ran out reaches this check).
    const broke = await createUser();
    const outcome = await runTurn({
      userId: broke.id,
      deliveryId: `evt_${randomUUID()}`,
      kind: 'message',
      sessionKey: 'web',
      channel: 'web',
      text: 'hi',
    });
    expect(outcome).toBe('out_of_credits');
    const [row] = await recentTurnTimings(broke.id, 1);
    expect(row).toMatchObject({ route: 'out_of_credits', outcome: 'out_of_credits', wake: null });
    expect(turnStages(row!).map((st) => st.name)).toEqual(['reply']);
  });

  it('a Bridge report with anything but names and numbers is not stored', () => {
    expect(parseBridgeReport('{"v":1,"marks":{"engine_ready":12}}')).toEqual({
      v: 1,
      marks: { engine_ready: 12 },
    });
    expect(parseBridgeReport('{"v":1,"marks":{"the user said hello":12}}')).toBeUndefined();
    expect(
      parseBridgeReport('{"v":1,"crew":[{"member":"Scout: read my email","start":1}]}'),
    ).toBeUndefined();
    expect(parseBridgeReport('{"v":1,"note":"free text","marks":{}}')).toEqual({ v: 1, marks: {} });
    expect(parseBridgeReport('not json')).toBeUndefined();
    expect(parseBridgeReport('')).toBeUndefined();
  });

  it('a turn that fails on our side and is retried keeps the last try', async () => {
    const user = await chatUser();
    let wakes = 0;
    // Only this user's wakes count: an earlier test's wake that nobody waited for may land here.
    vmFake.state.onWake = async (req) => {
      if (req.userId === user.id && wakes++ === 0)
        throw new ConnectError('server full', Code.ResourceExhausted);
    };
    const eventId = await send(user.id, 'book the table for two');
    expect((await getEvent(eventId))?.status).toBe('done');
    const row = await timingRow(eventId);
    expect(row.outcome).toBe('done');
    expect(row.attempt).toBe(2);
    expect((await recentTurnTimings(user.id, 5)).map((r) => r.deliveryId)).toEqual([eventId]);
  });
});

describe('the per-user lock', () => {
  it('a message sent right after an answer waits a moment, not 2 s', async () => {
    const user = await chatUser();
    vmFake.state.wasStopped = false;
    const token = (await acquireUserLock(user.id))!; // the turn before: still finishing
    const { eventId } = await sendWebMessage(user.id, {
      text: 'and one more thing',
      clientMessageId: randomUUID(),
    });
    // The job found the lock taken and went back in line at least once.
    await new Promise((r) => setTimeout(r, 600));
    expect(await queue('inbound').getJob(eventId)).toBeTruthy();
    const freed = Date.now();
    await releaseUserLock(user.id, token);
    await waitFor(async () => (await getEvent(eventId))?.status === 'done');
    const row = await timingRow(eventId);
    const pickedUp = row.startedAt.getTime() + row.stages.picked_up!;
    // Before: the next look came 2 s after the first, so about 1.4 s after the lock was given back.
    expect(pickedUp - freed).toBeLessThan(900);
    expect(row.stages.picked_up).toBeGreaterThanOrEqual(600);
  });
});
