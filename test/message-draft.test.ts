// The answer as it is written: the Bridge's drafts (TEXT_DELTA) reach the web app as `message.draft`
// for web chat turns only, live only, and in order with the turn's other events.
import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { responseValidator } from '../src/api/openapi/spec.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { enqueueStreamEvent, subscribe, type StreamEvent } from '../src/modules/channels/stream.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { handleWebMessage, sendWebMessage } from '../src/modules/orchestrator/process-message.ts';
import { DRAFT_MAX_CHARS, PLATFORM_FAULT_TEXT, runTurn } from '../src/modules/orchestrator/turn.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeVm, type Delivery } from './fakes.ts';
import { chatUser, waitFor } from './helpers.ts';

type Draft = {
  conversationId: string;
  turnId: string;
  messageId: string | null;
  text: string;
  at: string;
};

let vm: ReturnType<typeof installFakeVm>;
beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(() => {
  vm = installFakeVm();
  vm.state.live = true;
});

const metadataOf = (d: Delivery | undefined) =>
  JSON.parse((d as unknown as { metadataJson: string }).metadataJson) as Record<string, unknown>;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Everything published to this user's live stream, in order, until the turn's end. */
async function listen(userId: string) {
  const seen: StreamEvent[] = [];
  const stop = await subscribe(userId, (e) => void seen.push(e));
  const ended = () =>
    waitFor(async () =>
      seen.some(
        (e) => e.type === 'agent.status' && (e.data as { state: string }).state === 'awake',
      ),
    ).finally(stop);
  return { seen, ended };
}

const draftsIn = (seen: StreamEvent[]) =>
  seen.filter((e) => e.type === 'message.draft').map((e) => e.data as Draft);

/** Where the first event that matches is in the stream (-1: not there). */
const indexOf = (seen: StreamEvent[], match: (e: StreamEvent) => boolean) => seen.findIndex(match);

/** The user writes in web chat and the worker runs the turn. */
async function sayInWeb(userId: string, text: string) {
  const { message, eventId } = await sendWebMessage(userId, {
    text,
    clientMessageId: randomUUID(),
  });
  await handleWebMessage({ data: { messageId: message.id, eventId, userId } } as Job);
  return { message, eventId };
}

describe('message.draft', () => {
  it('a web chat turn asks for drafts and passes each one on before the answer, saving none', async () => {
    const user = await chatUser();
    vm.state.agent = async (d, mcp, progress, draft) => {
      draft('Let me check.');
      progress('using get_calendar');
      draft(''); // the lead went on to a tool: it starts over
      draft('You have');
      draft('You have two meetings.');
      await pause(50); // the Bridge sends the answer after its last draft
      await mcp('send_message', { text: 'You have two meetings.', session_key: d.sessionKey });
    };
    const { seen, ended } = await listen(user.id);
    const { message, eventId } = await sayInWeb(user.id, 'what is on today?');
    await ended();

    expect(metadataOf(vm.deliveries.at(-1))).toMatchObject({ stream_text: true });
    const drafts = draftsIn(seen);
    expect(drafts.map((d) => d.text)).toEqual([
      'Let me check.',
      '',
      'You have',
      'You have two meetings.',
    ]);
    const validate = responseValidator('streamEvents', 200)!;
    for (const data of drafts) {
      expect(data).toMatchObject({
        conversationId: message.conversationId,
        turnId: eventId,
        messageId: message.id,
      });
      expect(validate({ type: 'message.draft', data }), JSON.stringify(validate.errors)).toBe(true);
    }
    // Every draft comes before the answer, and before the turn's end.
    const lastDraft = seen.findLastIndex((e) => e.type === 'message.draft');
    const answer = indexOf(
      seen,
      (e) => e.type === 'message.created' && (e.data as { direction: string }).direction === 'out',
    );
    const delivered = indexOf(
      seen,
      (e) =>
        e.type === 'message.status' &&
        (e.data as { id: string; status: string }).id === message.id &&
        (e.data as { status: string }).status === 'delivered',
    );
    expect(lastDraft).toBeLessThan(answer);
    expect(answer).toBeLessThan(delivered);
    // Live only: the conversation holds the question and the answer, nothing else.
    const rows = await db().select().from(messages).where(eq(messages.userId, user.id));
    expect(rows.map((r) => r.text).sort()).toEqual(['You have two meetings.', 'what is on today?']);
  });

  it('a failed turn clears its draft before the user is told', async () => {
    const user = await chatUser();
    vm.state.agent = async (_d, _mcp, _progress, draft) => draft('Half an ans');
    vm.state.turnErrorAfterAgent = { message: 'the agent crashed', platformFault: true };
    const { seen, ended } = await listen(user.id);
    await sayInWeb(user.id, 'do the thing');
    await ended();

    expect(draftsIn(seen).map((d) => d.text)).toEqual(['Half an ans', '']);
    const cleared = seen.findLastIndex((e) => e.type === 'message.draft');
    const apology = indexOf(
      seen,
      (e) =>
        e.type === 'message.created' && (e.data as { text: string }).text === PLATFORM_FAULT_TEXT,
    );
    expect(apology).toBeGreaterThan(cleared);
  });

  it('a failed turn that showed no draft sends no empty one', async () => {
    const user = await chatUser();
    vm.state.turnError = { message: 'the agent could not start', platformFault: true };
    const { seen, ended } = await listen(user.id);
    await sayInWeb(user.id, 'do the thing');
    await ended();
    expect(draftsIn(seen)).toEqual([]);
  });

  it('a Telegram turn asks for none, and a draft sent anyway is not passed on', async () => {
    const user = await chatUser();
    vm.state.agent = async (_d, _mcp, _progress, draft) => draft('Half an ans');
    const { seen, ended } = await listen(user.id);
    await runTurn({
      userId: user.id,
      deliveryId: `evt_${randomUUID()}`,
      kind: 'message',
      sessionKey: 'telegram:42',
      channel: 'telegram',
      text: 'hello',
    });
    await ended();
    expect(metadataOf(vm.deliveries.at(-1))).toMatchObject({ stream_text: false });
    expect(draftsIn(seen)).toEqual([]);
  });

  it('a turn that answers no message names none, and a long draft is cut', async () => {
    const user = await chatUser();
    vm.state.agent = async (_d, _mcp, _progress, draft) => draft('x'.repeat(DRAFT_MAX_CHARS + 500));
    const { seen, ended } = await listen(user.id);
    await runTurn({
      userId: user.id,
      deliveryId: `evt_${randomUUID()}`,
      kind: 'automation',
      sessionKey: 'web',
      channel: 'web',
      text: '[Automation "Brief"] Summarise my inbox',
      // An automation can't switch the drafts off (or on, elsewhere): the platform decides.
      metadata: { stream_text: false },
    });
    await ended();
    expect(metadataOf(vm.deliveries.at(-1))).toMatchObject({ stream_text: true });
    const [draft] = draftsIn(seen);
    expect(draft!.messageId).toBeNull();
    expect(draft!.text).toHaveLength(DRAFT_MAX_CHARS);
  });
});

describe('the queue of a stream connection', () => {
  const draft = (turnId: string, text: string): StreamEvent => ({
    type: 'message.draft',
    data: { conversationId: 'cnv_1', turnId, messageId: null, text, at: '' },
  });
  const created: StreamEvent = { type: 'message.created', data: { id: 'msg_1' } };
  const progress: StreamEvent = { type: 'agent.progress', data: { text: 'using gmail' } };

  it('keeps one waiting draft per turn: the latest, where the first one was', () => {
    const queue: StreamEvent[] = [];
    enqueueStreamEvent(queue, draft('t1', 'Hel'));
    enqueueStreamEvent(queue, progress);
    enqueueStreamEvent(queue, created);
    enqueueStreamEvent(queue, draft('t1', 'Hello'));
    enqueueStreamEvent(queue, draft('t2', 'Other'));
    expect(queue).toEqual([draft('t1', 'Hello'), progress, created, draft('t2', 'Other')]);
  });

  it('adds a draft again once the one before it was written', () => {
    const queue: StreamEvent[] = [];
    enqueueStreamEvent(queue, draft('t1', 'Hel'));
    queue.shift(); // written to the connection
    enqueueStreamEvent(queue, draft('t1', 'Hello'));
    enqueueStreamEvent(queue, created);
    enqueueStreamEvent(queue, created);
    expect(queue).toEqual([draft('t1', 'Hello'), created, created]);
  });
});
