// "Ask Tex to set it up" on the New automation page: `POST /v1/messages` with
// `purpose: automation_draft`. The message goes into the Automations chat (started if there is
// none), the turn's text tells the agent to only draft it or say why it can't, the router never
// answers it quickly, and every message of the turn carries the turn's id, so the page finds the
// answer to its own request even with an automation's run answering in the same chat.
import { randomUUID } from 'node:crypto';
import type { Job, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliverKind } from '../proto-gen/vm/v1/vm_pb.ts';
import { findAutomationsChat, activeConversation } from '../src/modules/channels/conversations.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { events } from '../src/modules/events/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import {
  DRAFT_ASK_NOTE,
  draftAskText,
  handleWebMessage,
} from '../src/modules/orchestrator/process-message.ts';
import { setChatCompleter, setJevClient } from '../src/modules/orchestrator/routing.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakeVm } from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[] = [];
let vm: ReturnType<typeof installFakeVm>;

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50], busyDelayMs: 25 });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});

/** The last line of a turn's text: what the user wrote (the platform's blocks come before it). */
const lastLine = (text: string) => text.split('\n').at(-1)!;

beforeEach(() => {
  // The agent: "every morning …" is drafted with propose_automation; "what's the weather" can't be
  // one, so it says why and suggests a request; anything else is answered "re: <it>".
  vm = installFakeVm(async (d, mcp) => {
    const said = lastLine(d.text);
    if (said.startsWith('every morning')) {
      const r = await mcp('propose_automation', {
        title: 'Morning email',
        instruction: 'Sum up my unread email',
        cron: '0 9 * * *',
        timezone: 'Asia/Kolkata',
        session_key: d.sessionKey,
      });
      expect(r.isError, r.text).toBe(false);
      return;
    }
    if (said.startsWith("what's the weather")) {
      await mcp('send_message', {
        text: 'That is a one-off question, not something to run later.\nTry: "Every morning at 8, tell me the weather in Pune."',
        session_key: d.sessionKey,
      });
      return;
    }
    await mcp('send_message', { text: `re: ${said}`, session_key: d.sessionKey });
  });
});
afterEach(() => {
  setJevClient(undefined);
  setChatCompleter(undefined);
});

type TestUser = { id: string; token: string };
type ApiMessage = {
  id: string;
  conversationId: string;
  direction: 'in' | 'out';
  text: string;
  status: string;
  automationDraftId: string | null;
  turnId?: string | null;
};

const send = (user: TestUser, body: Record<string, unknown>) =>
  call('/v1/messages', {
    method: 'POST',
    token: user.token,
    body: { clientMessageId: randomUUID(), ...body },
  });

/** Asks from the New automation page; returns the saved message once its turn is over. */
async function ask(user: TestUser, text: string, clientMessageId = randomUUID()) {
  const sent = await expectContract<ApiMessage>(
    'sendMessage',
    await send(user, { text, clientMessageId, purpose: 'automation_draft' }),
    202,
  );
  await waitFor(async () => {
    const [row] = await db().select().from(messages).where(eq(messages.id, sent.id));
    return row?.status === 'delivered';
  });
  return sent;
}

/** A conversation's messages as the web app lists them (newest first). */
async function listed(user: TestUser, conversationId: string): Promise<ApiMessage[]> {
  const page = await expectContract<{ items: ApiMessage[] }>(
    'listMessages',
    await call(`/v1/messages?conversationId=${conversationId}`, { token: user.token }),
    200,
  );
  return page.items;
}

const turnsOf = (userId: string) => vm.deliveries.filter((d) => d.userId === userId);

describe('asking from the New automation page', () => {
  it('goes into the Automations chat (started for it), and the active chat stays as it was', async () => {
    const user = await chatUser({ plan: 'pro' });
    const sent = await expectContract<{ conversationId: string }>(
      'sendMessage',
      await send(user, { text: 'hlo' }),
      202,
    );
    const open = sent.conversationId;
    expect(await findAutomationsChat(user.id)).toBeUndefined();

    const asked = await ask(user, 'every morning at 9, sum up my unread email');
    const chat = (await findAutomationsChat(user.id))!;
    expect(asked.conversationId).toBe(chat.id);
    expect(chat.active).toBe(false);
    expect((await activeConversation(user.id, 'web')).id).toBe(open);
    // The next ordinary message still goes into the chat that was open.
    const next = await expectContract<{ conversationId: string }>(
      'sendMessage',
      await send(user, { text: 'back here' }),
      202,
    );
    expect(next.conversationId).toBe(open);
  });

  it('tells the agent, in the turn text, to only draft it or say why not; then the user’s words', async () => {
    const user = await chatUser({ plan: 'pro' });
    const asked = await ask(user, 'every morning at 9, sum up my unread email');
    const [turn] = turnsOf(user.id);
    expect(turn!.kind).toBe(DeliverKind.MESSAGE);
    expect(turn!.text).toContain(DRAFT_ASK_NOTE);
    expect(turn!.text).toContain('propose_automation');
    expect(turn!.text).toContain('Ask no question');
    expect(turn!.text).toContain('do not do the task itself now');
    expect(turn!.text.endsWith(draftAskText('every morning at 9, sum up my unread email'))).toBe(
      true,
    );
    // The message itself is saved as the user typed it: the note is only in the turn.
    const [row] = await db().select().from(messages).where(eq(messages.id, asked.id));
    expect(row?.text).toBe('every morning at 9, sum up my unread email');
    expect(asked.text).toBe('every morning at 9, sum up my unread email');
  });

  it('an ordinary message carries no such note', async () => {
    const user = await chatUser({ plan: 'pro' });
    const sent = await expectContract<ApiMessage>(
      'sendMessage',
      await send(user, { text: 'every morning at 9, sum up my unread email' }),
      202,
    );
    await waitFor(async () => {
      const [row] = await db().select().from(messages).where(eq(messages.id, sent.id));
      return row?.status === 'delivered';
    });
    expect(turnsOf(user.id)[0]!.text).not.toContain(DRAFT_ASK_NOTE);
  });

  it('a draft: the draft’s message carries its id and the turn’s id, as the user’s message does', async () => {
    const user = await chatUser({ plan: 'pro' });
    const asked = await ask(user, 'every morning at 9, sum up my unread email');
    expect(asked.turnId).toBeTruthy();
    const items = await listed(user, asked.conversationId);
    const draft = items.find((m) => m.direction === 'out' && m.automationDraftId);
    expect(draft?.turnId).toBe(asked.turnId);
    expect(items.find((m) => m.id === asked.id)?.turnId).toBe(asked.turnId);
    // The turn's id is the delivery's id: the same id `message.draft` carries.
    expect(turnsOf(user.id)[0]!.deliveryId).toBe(asked.turnId);
  });

  it("can't be one: a plain answer with the same turn id, no draft", async () => {
    const user = await chatUser({ plan: 'pro' });
    const asked = await ask(user, "what's the weather today");
    const answer = (await listed(user, asked.conversationId)).find(
      (m) => m.direction === 'out' && m.turnId === asked.turnId,
    );
    expect(answer?.automationDraftId).toBeNull();
    expect(answer?.text).toContain('Try: "Every morning at 8');
  });

  it('the answer of another turn in the same chat has another turn id', async () => {
    const user = await chatUser({ plan: 'pro' });
    const first = await ask(user, 'hello there');
    const second = await ask(user, "what's the weather today");
    expect(second.conversationId).toBe(first.conversationId);
    expect(second.turnId).not.toBe(first.turnId);
    const items = await listed(user, first.conversationId);
    const answersOf = (turnId: string | null | undefined) =>
      items.filter((m) => m.direction === 'out' && m.turnId === turnId).map((m) => m.text);
    expect(answersOf(first.turnId)).toEqual(['re: hello there']);
    expect(answersOf(second.turnId)).toHaveLength(1);
    expect(answersOf(second.turnId)[0]).toContain('one-off question');
  });

  it('is never answered by the quick router: it always reaches the agent', async () => {
    const user = await chatUser({ plan: 'pro' });
    // A router that would answer anything quickly.
    setJevClient({ decide: async () => ({ route: 'simple', confidence: 1, apps: [] }) });
    setChatCompleter(async () => 'Sure, done!');
    const asked = await ask(user, 'every morning at 9, sum up my unread email');
    expect(turnsOf(user.id)).toHaveLength(1);
    const texts = (await listed(user, asked.conversationId)).map((m) => m.text);
    expect(texts).not.toContain('Sure, done!');
    // An ordinary message would have been answered by the router.
    const plain = await expectContract<ApiMessage>(
      'sendMessage',
      await send(user, { text: 'hi' }),
      202,
    );
    await waitFor(async () => {
      const [row] = await db().select().from(messages).where(eq(messages.id, plain.id));
      return row?.status === 'delivered';
    });
    expect(turnsOf(user.id)).toHaveLength(1);
  });

  it('a request that looks like a coupon code still goes to the agent', async () => {
    const user = await chatUser({ plan: 'pro' });
    await ask(user, 'AGT-ABCD-EFGH-JKLM');
    expect(turnsOf(user.id).map((d) => lastLine(d.text))).toEqual(['AGT-ABCD-EFGH-JKLM']);
  });
});

describe('its checks', () => {
  it('refuses a conversationId beside it (400), and a purpose it does not know (400)', async () => {
    const user = await chatUser({ plan: 'pro' });
    const sent = await expectContract<{ conversationId: string }>(
      'sendMessage',
      await send(user, { text: 'hlo' }),
      202,
    );
    await expectContract(
      'sendMessage',
      await send(user, {
        text: 'every morning at 9, sum up my unread email',
        purpose: 'automation_draft',
        conversationId: sent.conversationId,
      }),
      400,
    );
    await expectContract(
      'sendMessage',
      await send(user, { text: 'every morning', purpose: 'something_else' }),
      400,
    );
  });

  it('at zero credits: 402, nothing saved, and no Automations chat started', async () => {
    const user = await chatUser({ plan: 'pro', credits: 0 });
    await expectContract(
      'sendMessage',
      await send(user, { text: 'every morning at 9', purpose: 'automation_draft' }),
      402,
    );
    expect(await db().select().from(messages).where(eq(messages.userId, user.id))).toEqual([]);
    expect(await findAutomationsChat(user.id)).toBeUndefined();
  });

  it('is the sender’s own: each user’s request goes into their own Automations chat', async () => {
    const a = await chatUser({ plan: 'pro' });
    const b = await chatUser({ plan: 'pro' });
    const askedA = await ask(a, 'every morning at 9, sum up my unread email');
    const askedB = await ask(b, 'every morning at 9, sum up my unread email');
    expect(askedA.conversationId).toBe((await findAutomationsChat(a.id))!.id);
    expect(askedB.conversationId).toBe((await findAutomationsChat(b.id))!.id);
    expect(askedA.conversationId).not.toBe(askedB.conversationId);
    // B can't read A's.
    await expectContract(
      'listMessages',
      await call(`/v1/messages?conversationId=${askedA.conversationId}`, { token: b.token }),
      404,
    );
  });

  it('sent twice with the same id: one message, one turn', async () => {
    const user = await chatUser({ plan: 'pro' });
    const id = randomUUID();
    const first = await ask(user, 'every morning at 9, sum up my unread email', id);
    const again = await expectContract<ApiMessage>(
      'sendMessage',
      await send(user, {
        text: 'every morning at 9, sum up my unread email',
        clientMessageId: id,
        purpose: 'automation_draft',
      }),
      202,
    );
    expect(again.id).toBe(first.id);
    expect(again.turnId).toBe(first.turnId);
    await new Promise((r) => setTimeout(r, 300));
    expect(turnsOf(user.id)).toHaveLength(1);
  });

  it('a job added again from its saved event alone (Redis lost it) still carries the note', async () => {
    const user = await chatUser({ plan: 'pro' });
    const asked = await ask(user, 'every morning at 9, sum up my unread email');
    const [event] = await db().select().from(events).where(eq(events.id, asked.turnId!));
    expect(event?.payload).toEqual({ messageId: asked.id, purpose: 'automation_draft' });
    // As if the turn never ran: the message waits, and the job has only the event's id.
    await db().update(messages).set({ status: 'queued' }).where(eq(messages.id, asked.id));
    vm.deliveries.length = 0;
    await handleWebMessage({ data: { eventId: asked.turnId, userId: user.id } } as unknown as Job);
    expect(turnsOf(user.id)).toHaveLength(1);
    expect(turnsOf(user.id)[0]!.text).toContain(DRAFT_ASK_NOTE);
    // And once it has run, a job that runs again does nothing.
    await handleWebMessage({ data: { eventId: asked.turnId, userId: user.id } } as unknown as Job);
    expect(turnsOf(user.id)).toHaveLength(1);
    expect(await queue('inbound').getJob(asked.turnId!)).toBeTruthy();
  });
});
