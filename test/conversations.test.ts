// Conversations: a chat (web chat, one Telegram chat) is a row of conversations, one per "New
// chat". Every message belongs to one, each has a context of its own for the agent, and the user
// can go back to an earlier web conversation. (Starting one is in new-chat.test.ts; what the
// migration does with the messages stored before is in conversations-backfill.test.ts.)
import { randomUUID } from 'node:crypto';
import type { Job, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelLinks } from '../src/modules/auth/schema.ts';
import {
  activateConversation,
  activeConversation,
  NEW_CHAT_TITLE,
  titleFromText,
  toApiConversation,
} from '../src/modules/channels/conversations.ts';
import { cleanupMessages, type MessageRow } from '../src/modules/channels/messages.ts';
import { conversations, messages } from '../src/modules/channels/schema.ts';
import { subscribe, type StreamEvent } from '../src/modules/channels/stream.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { events } from '../src/modules/events/schema.ts';
import { markClaudeConnected } from '../src/modules/orchestrator/agent-settings.ts';
import { decideApproval, requestApproval } from '../src/modules/orchestrator/approvals.ts';
import { startNewWebChat } from '../src/modules/orchestrator/chats.ts';
import {
  handleProcessMessage,
  handleWebMessage,
  sendWebMessage,
} from '../src/modules/orchestrator/process-message.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { chatEngines } from '../src/modules/orchestrator/schema.ts';
import { RECAP_END } from '../src/modules/orchestrator/turn-context.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  installFakeTelegram,
  installFakeVm,
  mcpCall,
  telegramUpdate,
  type Delivery,
  type SentTelegram,
} from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[];
let vm: ReturnType<typeof installFakeVm>;
let tg: { sent: SentTelegram[] };

beforeAll(() => {
  wireModules();
  // A user's next job starts as soon as the one before it has let go of the user's lock.
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50], busyDelayMs: 25 });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  // The agent answers every turn with "re: <the turn's own text>" (the last line it was given).
  vm = installFakeVm(async (d, mcp) => {
    await mcp('send_message', {
      text: `re: ${d.text.split('\n').at(-1)}`,
      session_key: d.sessionKey,
    });
  });
  tg = installFakeTelegram();
});

type ApiMessage = { id: string; conversationId: string; text: string; direction: string };

const conversationsOf = (userId: string) =>
  db()
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(conversations.sessionKey, conversations.epoch);

const messagesIn = (userId: string, conversationId: string) =>
  db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId)))
    .orderBy(messages.id);

const textsIn = async (userId: string, conversationId: string) =>
  (await messagesIn(userId, conversationId)).map((m) => m.text);

/** The `metadata_json` of a delivery, read back. */
const metadataOf = (d: Delivery | undefined) =>
  JSON.parse((d as unknown as { metadataJson: string }).metadataJson) as Record<string, unknown>;

/** The delivery whose turn text (its last line) is `text`. */
const deliveryOf = (text: string) => vm.deliveries.find((d) => d.text.split('\n').at(-1) === text);

function recapLines(text: string): string[] {
  const all = text.split('\n');
  const from = all.findIndex((l) => l.startsWith('[Earlier in this chat.'));
  expect(from, `no recap in:\n${text}`).toBeGreaterThanOrEqual(0);
  return all.slice(from + 1, all.indexOf(RECAP_END));
}

/**
 * The user writes in web chat (POST /v1/messages) and the worker runs the turn. Returns once the
 * agent's answer is stored.
 */
async function say(
  user: { id: string; token: string },
  text: string,
  conversationId?: string,
): Promise<{ sent: ApiMessage; reply: MessageRow; delivery: Delivery }> {
  const sent = await expectContract<ApiMessage>(
    'sendMessage',
    await call('/v1/messages', {
      method: 'POST',
      token: user.token,
      body: { text, clientMessageId: randomUUID(), ...(conversationId ? { conversationId } : {}) },
    }),
    202,
  );
  await turnEnded(sent.id);
  const [reply] = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, user.id), eq(messages.text, `re: ${text}`)));
  return { sent, reply: reply!, delivery: deliveryOf(text)! };
}

/** The turn of an incoming message is over (its last step marks the message delivered). */
const turnEnded = (messageId: string) =>
  waitFor(async () => {
    const [row] = await db().select().from(messages).where(eq(messages.id, messageId));
    return row?.status === 'delivered' ? row : undefined;
  });

async function linkedTelegram(userId: string): Promise<number> {
  const chatId = Math.floor(Math.random() * 1e9);
  await db()
    .insert(channelLinks)
    .values({
      id: newId('chl'),
      userId,
      channel: 'telegram',
      externalId: String(chatId),
      displayId: '@u',
    });
  return chatId;
}

/** A Telegram message arrives (the webhook); returns the event once its job has ended. */
async function fromTelegram(chatId: number, text: string) {
  const update = telegramUpdate(chatId, text);
  await expectContract(
    'webhookTelegram',
    await call('/webhooks/telegram', {
      method: 'POST',
      body: update,
      headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
    }),
    200,
  );
  return waitFor(async () => {
    const [row] = await db()
      .select()
      .from(events)
      .where(eq(events.externalId, String(update.update_id)));
    return row && ['done', 'ignored', 'failed'].includes(row.status) ? row : undefined;
  });
}

/** Collects one user's live events until `stop()`. */
async function listen(userId: string) {
  const seen: StreamEvent[] = [];
  const stop = await subscribe(userId, (e) => void seen.push(e));
  const of = (type: StreamEvent['type']) =>
    seen.filter((e) => e.type === type).map((e) => e.data as Record<string, unknown>);
  return { seen, of, stop };
}

describe('the title of a conversation', () => {
  it('is the first incoming message’s text, cut to 60 characters at a word', () => {
    expect(titleFromText('Plan a trip to Goa')).toBe('Plan a trip to Goa');
    expect(titleFromText('  two\n\nlines\tand   spaces ')).toBe('two lines and spaces');
    const long = 'Please plan a five day trip to Goa for four people in December under 800 dollars';
    expect(titleFromText(long)).toBe('Please plan a five day trip to Goa for four people in');
    // Exactly 60 fits; a word that ends at 60 is kept whole; one that would pass it is dropped.
    expect(titleFromText('x'.repeat(60))).toBe('x'.repeat(60));
    expect(titleFromText(`${'a'.repeat(57)} bc def`)).toBe(`${'a'.repeat(57)} bc`);
    expect(titleFromText(`${'a'.repeat(57)} bcd ef`)).toBe('a'.repeat(57));
    // One word longer than 60: cut in the middle, there is no better place.
    expect(titleFromText('y'.repeat(90))).toBe('y'.repeat(60));
    expect(titleFromText('   \n ')).toBeNull();
    expect(titleFromText('')).toBeNull();
  });

  it('is "New chat" while the conversation has no such message', async () => {
    const user = await chatUser();
    const empty = await startNewWebChat(user.id);
    expect(empty.title).toBeNull();
    expect(toApiConversation(empty).title).toBe('New chat');
    expect(NEW_CHAT_TITLE).toBe('New chat');
  });
});

describe('every message belongs to one conversation', () => {
  it('web chat: the first message starts conversation 0, names it, and the answer is in it too', async () => {
    const user = await chatUser();
    const before = Date.now();
    const { sent, reply } = await say(user, 'plan a trip to Goa');
    const [c, ...more] = await conversationsOf(user.id);
    expect(more).toEqual([]);
    expect(c).toMatchObject({
      sessionKey: 'web',
      channel: 'web',
      epoch: 0,
      active: true,
      title: 'plan a trip to Goa',
    });
    expect(c!.id).toMatch(/^cnv_[0-9a-z]{26}$/);
    expect(sent.conversationId).toBe(c!.id);
    expect(reply.conversationId).toBe(c!.id);
    expect(c!.startedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // `lastMessageAt` follows the newest message (whole milliseconds).
    await waitFor(async () => {
      const [now] = await conversationsOf(user.id);
      return now!.lastMessageAt.getTime() === reply.createdAt.getTime();
    });
    // A later message doesn't rename it.
    await say(user, 'for four days');
    expect((await conversationsOf(user.id))[0]!.title).toBe('plan a trip to Goa');
    expect(await textsIn(user.id, c!.id)).toEqual([
      'plan a trip to Goa',
      're: plan a trip to Goa',
      'for four days',
      're: for four days',
    ]);
  });

  it('Telegram: a chat of its own; /new starts the next conversation and later messages go there', async () => {
    const user = await chatUser();
    await ensureSandbox(user.id);
    const chatId = await linkedTelegram(user.id);
    const sessionKey = `telegram:${chatId}`;
    await say(user, 'a web message');
    await fromTelegram(chatId, 'hello from Telegram');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: hello from Telegram'));
    const [first] = (await conversationsOf(user.id)).filter((c) => c.sessionKey === sessionKey);
    expect(first).toMatchObject({
      channel: 'telegram',
      epoch: 0,
      active: true,
      title: 'hello from Telegram',
    });
    expect(await textsIn(user.id, first!.id)).toEqual([
      'hello from Telegram',
      're: hello from Telegram',
    ]);

    await fromTelegram(chatId, '/new');
    await fromTelegram(chatId, 'what is a good laptop?');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: what is a good laptop?'));
    const [old, current, ...more] = (await conversationsOf(user.id)).filter(
      (c) => c.sessionKey === sessionKey,
    );
    expect(more).toEqual([]);
    expect(old).toMatchObject({ id: first!.id, epoch: 0, active: false });
    expect(current).toMatchObject({ epoch: 1, active: true, title: 'what is a good laptop?' });
    expect(await textsIn(user.id, current!.id)).toEqual([
      'what is a good laptop?',
      're: what is a good laptop?',
    ]);
    expect(metadataOf(deliveryOf('what is a good laptop?'))).toMatchObject({ chat_epoch: 1 });
    // The first conversation kept its messages, and web chat is untouched.
    expect(await textsIn(user.id, first!.id)).toHaveLength(2);
    const web = (await conversationsOf(user.id)).filter((c) => c.sessionKey === 'web');
    expect(web).toMatchObject([{ epoch: 0, active: true, title: 'a web message' }]);
  });

  it('a message saved by a job that runs twice is one message in one conversation', async () => {
    const user = await chatUser();
    await ensureSandbox(user.id);
    const chatId = await linkedTelegram(user.id);
    const event = await fromTelegram(chatId, 'only once please');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: only once please'));
    await handleProcessMessage({ data: { eventId: event.id } } as Job);

    const { message, eventId } = await sendWebMessage(user.id, {
      text: 'web once',
      clientMessageId: randomUUID(),
    });
    await turnEnded(message.id);
    await handleWebMessage({ data: { messageId: message.id, eventId, userId: user.id } } as Job);

    const all = await db().select().from(messages).where(eq(messages.userId, user.id));
    expect(all.map((m) => m.text).sort()).toEqual([
      'only once please',
      're: only once please',
      're: web once',
      'web once',
    ]);
    expect(await conversationsOf(user.id)).toHaveLength(2);
    expect(vm.deliveries).toHaveLength(2);
  });
});

describe('each conversation has its own context', () => {
  it('a turn runs in its message’s conversation, and its answer is saved there, also after the user moved on', async () => {
    const user = await chatUser();
    await say(user, 'first chat');
    const [first] = await conversationsOf(user.id);

    // The agent is slow with the next one; meanwhile the user starts a new chat.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const quick = vm.state.agent;
    vm.state.agent = async (d, mcp, progress) => {
      if (d.text.endsWith('slow question')) await gate;
      await quick(d, mcp, progress);
    };
    const slow = await sendWebMessage(user.id, {
      text: 'slow question',
      clientMessageId: randomUUID(),
    });
    await waitFor(async () => deliveryOf('slow question'));
    const second = await startNewWebChat(user.id);
    expect(second).toMatchObject({ epoch: 1, active: true });
    release();
    await turnEnded(slow.message.id);
    expect(await textsIn(user.id, first!.id)).toEqual([
      'first chat',
      're: first chat',
      'slow question',
      're: slow question',
    ]);
    expect(metadataOf(deliveryOf('slow question'))).toMatchObject({ chat_epoch: 0 });
    expect(await textsIn(user.id, second.id)).toEqual([]);

    // With no turn in progress, what the agent sends goes to the chat's active conversation.
    const r = await mcpCall(vm.tokens.get(user.id)!, 'send_message', {
      text: 'a reminder',
      session_key: 'web',
    });
    expect(r.isError, r.text).toBe(false);
    expect(await textsIn(user.id, second.id)).toEqual(['a reminder']);
  });

  it('going back to an earlier conversation delivers its own number, lower than the chat’s highest', async () => {
    const user = await chatUser();
    const one = await say(user, 'about Goa');
    const second = await startNewWebChat(user.id);
    const two = await say(user, 'about laptops');
    expect(two.sent.conversationId).toBe(second.id);
    expect(metadataOf(one.delivery)).toMatchObject({ chat_epoch: 0 });
    expect(metadataOf(two.delivery)).toMatchObject({ chat_epoch: 1 });

    // Back to the first one: it is the active one again, and its turns carry its own number.
    await activateConversation(user.id, one.sent.conversationId);
    const back = await say(user, 'and the hotel?');
    expect(back.sent.conversationId).toBe(one.sent.conversationId);
    expect(back.reply.conversationId).toBe(one.sent.conversationId);
    expect(metadataOf(back.delivery)).toMatchObject({ chat_epoch: 0 });
    // The same engine all along: it has each conversation's context itself, so no recap is sent.
    expect(back.delivery.text).toBe('and the hotel?');
    expect(await textsIn(user.id, one.sent.conversationId)).toEqual([
      'about Goa',
      're: about Goa',
      'and the hotel?',
      're: and the hotel?',
    ]);
    expect(await textsIn(user.id, second.id)).toEqual(['about laptops', 're: about laptops']);
  });

  it('the recap on an engine change holds the conversation’s own messages only', async () => {
    const user = await chatUser();
    const goa = await say(user, 'about Goa');
    const second = await startNewWebChat(user.id);
    await say(user, 'about laptops');

    // The user connects Claude Code, then goes back to the first conversation.
    vm.claudeConnected.add(user.id);
    await markClaudeConnected(user.id);
    await activateConversation(user.id, goa.sent.conversationId);
    const back = await say(user, 'and the hotel?');
    expect(recapLines(back.delivery.text)).toEqual(['User: about Goa', 'You: re: about Goa']);
    expect(back.delivery.text).not.toContain('laptops');

    // And in the second one, only the second one's.
    await activateConversation(user.id, second.id);
    const other = await say(user, 'under 1000 dollars');
    expect(recapLines(other.delivery.text)).toEqual([
      'User: about laptops',
      'You: re: about laptops',
    ]);
    expect(other.delivery.text).not.toContain('Goa');
    // Claude Code now has both: no recap again in either.
    expect((await say(user, 'ok')).delivery.text).toBe('ok');
    await activateConversation(user.id, goa.sent.conversationId);
    expect((await say(user, 'ok then')).delivery.text).toBe('ok then');

    // Which engine ran where is kept per conversation (chat and number).
    const ran = await db().select().from(chatEngines).where(eq(chatEngines.userId, user.id));
    expect(ran.map((r) => `${r.sessionKey}/${r.epoch}/${r.runtime}`).sort()).toEqual([
      'web/0/claude_code',
      'web/0/hermes',
      'web/1/claude_code',
      'web/1/hermes',
    ]);
  });

  it('an approval is answered in the conversation it was asked in', async () => {
    const user = await chatUser();
    await say(user, 'email Priya');
    const [first] = await conversationsOf(user.id);
    const approval = await requestApproval({
      userId: user.id,
      sessionKey: 'web',
      summary: 'Send email to priya@acme.com',
    });
    const second = await startNewWebChat(user.id);
    await decideApproval(user.id, approval.id, true, 'web');
    const delivery = await waitFor(async () => vm.deliveries.find((d) => d.approvalId));
    expect(metadataOf(delivery)).toMatchObject({ chat_epoch: 0 });
    await waitFor(async () =>
      (await textsIn(user.id, first!.id)).find((t) => t.startsWith('re: The user APPROVED')),
    );
    expect(await textsIn(user.id, second.id)).toEqual([]);
  });
});

describe('the live stream', () => {
  it('conversation.updated: when one starts, with each message, and when the active one changes', async () => {
    const user = await chatUser();
    const live = await listen(user.id);
    try {
      const { sent, reply } = await say(user, 'hello there');
      await waitFor(async () => live.of('conversation.updated').length >= 3);
      const updates = live.of('conversation.updated');
      // Started (no title yet), then the incoming message (title), then the answer.
      expect(updates[0]).toMatchObject({ id: sent.conversationId, title: 'New chat', epoch: 0 });
      expect(updates[1]).toMatchObject({ id: sent.conversationId, title: 'hello there' });
      expect(updates.at(-1)).toMatchObject({
        id: sent.conversationId,
        active: true,
        lastMessageAt: reply.createdAt.toISOString(),
      });
      // The message events carry the conversation.
      expect(live.of('message.created').map((m) => m.conversationId)).toEqual([
        sent.conversationId,
        sent.conversationId,
      ]);

      await waitFor(async () => live.of('agent.status').some((s) => s.state === 'awake'));
      live.seen.length = 0;
      const second = await startNewWebChat(user.id);
      await waitFor(async () => live.seen.length >= 2);
      expect(live.of('conversation.updated')).toMatchObject([
        { id: sent.conversationId, active: false },
        { id: second.id, active: true, title: 'New chat', epoch: 1 },
      ]);
      live.seen.length = 0;
      await activateConversation(user.id, sent.conversationId);
      await waitFor(async () => live.seen.length >= 2);
      expect(live.of('conversation.updated')).toMatchObject([
        { id: second.id, active: false },
        { id: sent.conversationId, active: true },
      ]);
      // Opening the one that is active already changes nothing and says nothing.
      live.seen.length = 0;
      await activateConversation(user.id, sent.conversationId);
      await new Promise((r) => setTimeout(r, 150));
      expect(live.seen).toEqual([]);
    } finally {
      live.stop();
    }
  });
});

describe('chat history retention', () => {
  it('a conversation left with no messages goes with them; the active one and newer ones stay', async () => {
    const user = await chatUser();
    const old = await say(user, 'long ago');
    const second = await startNewWebChat(user.id);
    const third = await startNewWebChat(user.id);
    const twoYears = new Date(Date.now() - 2 * 365 * 86400_000);
    const age = (id: string) =>
      db().update(conversations).set({ lastMessageAt: twoYears }).where(eq(conversations.id, id));
    await db()
      .update(messages)
      .set({ createdAt: twoYears })
      .where(eq(messages.conversationId, old.sent.conversationId));
    await age(old.sent.conversationId);
    await age(third.id);
    expect(await cleanupMessages()).toBe(2);
    // The first one's messages are gone and it is old: removed. The second is empty but recent;
    // the third is old and empty but it is the active one.
    expect((await conversationsOf(user.id)).map((c) => c.id)).toEqual([second.id, third.id]);
    expect((await activeConversation(user.id, 'web')).id).toBe(third.id);
  });
});
