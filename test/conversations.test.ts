// Conversations: a chat (web chat, one Telegram chat) is a row of conversations, one per "New
// chat". Every message belongs to one, each has a context of its own for the agent, and the user
// can go back to an earlier web conversation. (Starting one is in new-chat.test.ts; what the
// migration does with the messages stored before is in conversations-backfill.test.ts.)
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Job, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { channelLinks } from '../src/modules/auth/schema.ts';
import {
  activateConversation,
  activeConversation,
  NEW_CHAT_TITLE,
  titleFromText,
  toApiConversation,
} from '../src/modules/channels/conversations.ts';
import { cleanupMessages, type MessageRow } from '../src/modules/channels/messages.ts';
import { attachments, conversations, messages } from '../src/modules/channels/schema.ts';
import { subscribe, type StreamEvent } from '../src/modules/channels/stream.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { events } from '../src/modules/events/schema.ts';
import { markClaudeConnected } from '../src/modules/orchestrator/agent-settings.ts';
import { decideApproval, requestApproval } from '../src/modules/orchestrator/approvals.ts';
import { NEW_CHATS_PER_HOUR, startNewWebChat } from '../src/modules/orchestrator/chats.ts';
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
import { call, chatUser, createUser, expectContract, testApp, waitFor } from './helpers.ts';

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
type ApiConversation = {
  id: string;
  channel: string;
  epoch: number;
  startedAt: string;
  lastMessageAt: string;
  title: string;
  active: boolean;
};
type Page<T> = { items: T[]; nextCursor: string | null };
type ApiError = { error: { code: string; message: string } };
type TestUser = { id: string; token: string };

const listConversations = (user: TestUser, query = '') =>
  call(`/v1/conversations${query}`, { token: user.token });

async function conversationList(user: TestUser, query = ''): Promise<ApiConversation[]> {
  const page = await expectContract<Page<ApiConversation>>(
    'listConversations',
    await listConversations(user, query),
    200,
  );
  return page.items;
}

const newConversation = (user: TestUser) =>
  call('/v1/conversations', { method: 'POST', token: user.token });

async function startConversation(user: TestUser): Promise<ApiConversation> {
  return expectContract<ApiConversation>('createConversation', await newConversation(user), 201);
}

const patchConversation = (user: TestUser, id: string, body: unknown) =>
  call(`/v1/conversations/${id}`, { method: 'PATCH', token: user.token, body });

const removeConversation = (user: TestUser, id: string) =>
  call(`/v1/conversations/${id}`, { method: 'DELETE', token: user.token });

async function messageTexts(user: TestUser, query: string): Promise<string[]> {
  const page = await expectContract<Page<ApiMessage>>(
    'listMessages',
    await call(`/v1/messages${query}`, { token: user.token }),
    200,
  );
  return page.items.map((m) => m.text);
}

/** The user's activity log entries of one kind. */
const activity = (userId: string, action: string) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.action, action)));

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

describe('many requests at once', () => {
  it('a chat’s first messages arriving together start one conversation, not several', async () => {
    const user = await chatUser();
    const got = await Promise.all(
      Array.from({ length: 12 }, () => activeConversation(user.id, 'web')),
    );
    expect(new Set(got.map((c) => c.id)).size).toBe(1);
    expect(await conversationsOf(user.id)).toMatchObject([{ epoch: 0, active: true }]);
  });

  it('new chats started together each get their own number, and one is the active one', async () => {
    const user = await chatUser();
    const started = await Promise.all(Array.from({ length: 6 }, () => startNewWebChat(user.id)));
    expect(started.map((c) => c.epoch).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    const all = await conversationsOf(user.id);
    expect(all).toHaveLength(6);
    expect(all.filter((c) => c.active).map((c) => c.epoch)).toEqual([6]);
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
      // Count the conversation events only: an agent.status event may arrive in between.
      await waitFor(async () => live.of('conversation.updated').length >= 2);
      expect(live.of('conversation.updated')).toMatchObject([
        { id: sent.conversationId, active: false },
        { id: second.id, active: true, title: 'New chat', epoch: 1 },
      ]);
      live.seen.length = 0;
      await activateConversation(user.id, sent.conversationId);
      await waitFor(async () => live.of('conversation.updated').length >= 2);
      expect(live.of('conversation.updated')).toMatchObject([
        { id: second.id, active: false },
        { id: sent.conversationId, active: true },
      ]);
      // Opening the one that is active already changes nothing and says nothing.
      live.seen.length = 0;
      await activateConversation(user.id, sent.conversationId);
      await new Promise((r) => setTimeout(r, 150));
      expect(live.of('conversation.updated')).toEqual([]);
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

describe('GET /v1/conversations', () => {
  it('lists the user’s own, the one with the newest message first; `channel` narrows it', async () => {
    const user = await chatUser();
    const other = await chatUser();
    await ensureSandbox(user.id);
    await expectContract('listConversations', await call('/v1/conversations'), 401);
    expect(await conversationList(user)).toEqual([]);

    const goa = await say(user, 'about Goa');
    const chatId = await linkedTelegram(user.id);
    await fromTelegram(chatId, 'hello from Telegram');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: hello from Telegram'));
    const laptops = await startConversation(user);
    await say(other, 'someone else’s chat');

    const all = await conversationList(user);
    expect(all.map((c) => [c.channel, c.title, c.epoch, c.active])).toEqual([
      ['web', 'New chat', 1, true],
      ['telegram', 'hello from Telegram', 0, true],
      ['web', 'about Goa', 0, false],
    ]);
    expect(all[0]!.id).toBe(laptops.id);
    expect(all[0]!.lastMessageAt).toBe(all[0]!.startedAt);
    expect(all[2]).toMatchObject({
      id: goa.sent.conversationId,
      lastMessageAt: goa.reply.createdAt.toISOString(),
    });
    expect((await conversationList(user, '?channel=web')).map((c) => c.title)).toEqual([
      'New chat',
      'about Goa',
    ]);
    expect((await conversationList(user, '?channel=telegram')).map((c) => c.title)).toEqual([
      'hello from Telegram',
    ]);
    expect(await conversationList(user, '?channel=whatsapp')).toEqual([]);
    await expectContract('listConversations', await listConversations(user, '?channel=sms'), 400);

    // A new message moves its conversation to the top.
    await say(user, 'and the hotel?', goa.sent.conversationId);
    expect((await conversationList(user)).map((c) => c.title)).toEqual([
      'about Goa',
      'New chat',
      'hello from Telegram',
    ]);
  });

  it('pages with cursor and nextCursor, each conversation once, in order', async () => {
    const user = await chatUser();
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await startConversation(user)).id);
    // Two of them share a time: the order between them is by id, and paging still splits cleanly.
    const same = new Date(Date.now() - 60_000);
    await db()
      .update(conversations)
      .set({ lastMessageAt: same })
      .where(and(eq(conversations.userId, user.id), eq(conversations.epoch, 2)));
    await db()
      .update(conversations)
      .set({ lastMessageAt: same })
      .where(and(eq(conversations.userId, user.id), eq(conversations.epoch, 3)));
    const whole = (await conversationList(user, '?limit=100')).map((c) => c.id);
    expect(whole).toHaveLength(5);
    expect([...whole].sort()).toEqual([...made].sort());

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Page<ApiConversation> = await expectContract(
        'listConversations',
        await listConversations(user, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`),
        200,
      );
      seen.push(...page.items.map((c) => c.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(whole);

    const bad = await expectContract<ApiError>(
      'listConversations',
      await listConversations(user, '?cursor=not-a-cursor'),
      400,
    );
    expect(bad.error.code).toBe('invalid_request');
    await expectContract('listConversations', await listConversations(user, '?limit=500'), 400);
  });
});

describe('POST /v1/conversations', () => {
  it('starts an empty web conversation and makes it the active one; no turn, no charge', async () => {
    const user = await createUser(); // no credits
    await expectContract(
      'createConversation',
      await call('/v1/conversations', { method: 'POST' }),
      401,
    );
    const first = await startConversation(user);
    expect(first).toMatchObject({ channel: 'web', epoch: 1, title: 'New chat', active: true });
    expect(first.lastMessageAt).toBe(first.startedAt);
    const second = await startConversation(user);
    expect(second).toMatchObject({ epoch: 2, active: true });
    expect(Date.parse(second.startedAt)).toBeGreaterThan(Date.parse(first.startedAt));
    expect((await conversationList(user)).map((c) => [c.id, c.active])).toEqual([
      [second.id, true],
      [first.id, false],
    ]);
    expect(vm.deliveries).toHaveLength(0);
    expect(await db().select().from(messages).where(eq(messages.userId, user.id))).toEqual([]);
    // The activity log names the channel, nothing else.
    expect((await activity(user.id, 'chat_started')).map((e) => [e.actor, e.summary])).toEqual([
      ['user', 'Started a new chat in web chat'],
      ['user', 'Started a new chat in web chat'],
    ]);
  });

  it(`shares the limit of ${NEW_CHATS_PER_HOUR} an hour with its older name, POST /v1/chats/new`, async () => {
    const user = await createUser();
    for (let i = 0; i < NEW_CHATS_PER_HOUR - 1; i++) await startConversation(user);
    const old = await expectContract<{ chatStartedAt: string }>(
      'startNewChat',
      await call('/v1/chats/new', { method: 'POST', token: user.token }),
      200,
    );
    // The older name starts a conversation like the new one does.
    const [newest] = await conversationList(user, '?limit=1');
    expect(newest).toMatchObject({ epoch: NEW_CHATS_PER_HOUR, active: true });
    expect(newest!.startedAt).toBe(old.chatStartedAt);
    await expectContract('createConversation', await newConversation(user), 429);
    await expectContract(
      'startNewChat',
      await call('/v1/chats/new', { method: 'POST', token: user.token }),
      429,
    );
    expect(await conversationList(user, '?limit=100')).toHaveLength(NEW_CHATS_PER_HOUR);
  });
});

describe('PATCH /v1/conversations/{id}', () => {
  it('renames: 1 to 80 characters, trimmed; a later message does not rename it back', async () => {
    const user = await chatUser();
    const other = await chatUser();
    const { sent } = await say(user, 'about Goa');
    const id = sent.conversationId;
    const live = await listen(user.id);
    try {
      const renamed = await expectContract<ApiConversation>(
        'updateConversation',
        await patchConversation(user, id, { title: '  Winter trip  ' }),
        200,
      );
      expect(renamed).toMatchObject({ id, title: 'Winter trip', active: true });
      await waitFor(async () => live.of('conversation.updated').length >= 1);
      expect(live.of('conversation.updated')).toMatchObject([{ id, title: 'Winter trip' }]);
    } finally {
      live.stop();
    }
    await say(user, 'for four days');
    expect((await conversationList(user))[0]!.title).toBe('Winter trip');

    // A name given to an empty conversation is not replaced by its first message either.
    const empty = await startConversation(user);
    await expectContract(
      'updateConversation',
      await patchConversation(user, empty.id, { title: 'x'.repeat(80) }),
      200,
    );
    await say(user, 'first words here');
    expect((await conversationList(user))[0]).toMatchObject({
      id: empty.id,
      title: 'x'.repeat(80),
    });

    for (const body of [
      { title: '' },
      { title: '   ' },
      { title: 'x'.repeat(81) },
      {},
      { active: false },
      { title: 'ok', colour: 'red' },
    ])
      await expectContract('updateConversation', await patchConversation(user, id, body), 400);
    await expectContract(
      'updateConversation',
      await patchConversation(other, id, { title: 'mine' }),
      404,
    );
    await expectContract(
      'updateConversation',
      await patchConversation(user, 'cnv_nope', { title: 'x' }),
      404,
    );
    await expectContract(
      'updateConversation',
      await call(`/v1/conversations/${id}`, { method: 'PATCH', body: { title: 'x' } }),
      401,
    );
    expect((await conversationList(user)).find((c) => c.id === id)!.title).toBe('Winter trip');
  });

  it('`active: true` opens an earlier web conversation; a Telegram one cannot be opened (409)', async () => {
    const user = await chatUser();
    const other = await chatUser();
    await ensureSandbox(user.id);
    const goa = await say(user, 'about Goa');
    const second = await startConversation(user);
    const opened = await expectContract<ApiConversation>(
      'updateConversation',
      await patchConversation(user, goa.sent.conversationId, { active: true }),
      200,
    );
    expect(opened).toMatchObject({ id: goa.sent.conversationId, active: true });
    expect((await conversationList(user)).map((c) => [c.id, c.active])).toEqual([
      [second.id, false],
      [goa.sent.conversationId, true],
    ]);
    // Web chat's next message goes there, with that conversation's number.
    const next = await say(user, 'and the hotel?');
    expect(next.sent.conversationId).toBe(goa.sent.conversationId);
    expect(metadataOf(next.delivery)).toMatchObject({ chat_epoch: 0 });

    // Both fields at once.
    const both = await expectContract<ApiConversation>(
      'updateConversation',
      await patchConversation(user, second.id, { title: 'Laptops', active: true }),
      200,
    );
    expect(both).toMatchObject({ id: second.id, title: 'Laptops', active: true });

    const chatId = await linkedTelegram(user.id);
    await fromTelegram(chatId, 'hello from Telegram');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: hello from Telegram'));
    await fromTelegram(chatId, '/new');
    const [, earlier] = await conversationList(user, '?channel=telegram');
    expect(earlier).toMatchObject({ epoch: 0, active: false });
    const refused = await expectContract<ApiError>(
      'updateConversation',
      await patchConversation(user, earlier!.id, { active: true }),
      409,
    );
    expect(refused.error.code).toBe('conflict');
    expect((await conversationList(user, '?channel=telegram')).map((c) => c.active)).toEqual([
      true,
      false,
    ]);
    // It can be renamed, though.
    await expectContract(
      'updateConversation',
      await patchConversation(user, earlier!.id, { title: 'Old Telegram chat' }),
      200,
    );
    // Not someone else's.
    await expectContract(
      'updateConversation',
      await patchConversation(other, second.id, { active: true }),
      404,
    );
    expect((await conversationList(user, '?channel=web')).map((c) => [c.id, c.active])).toEqual([
      [goa.sent.conversationId, false],
      [second.id, true],
    ]);
  });
});

describe('POST /v1/messages with conversationId', () => {
  it('writes in that web conversation, which becomes the active one first', async () => {
    const user = await chatUser();
    const goa = await say(user, 'about Goa');
    const second = await startConversation(user);
    await say(user, 'about laptops');

    const back = await say(user, 'and the hotel?', goa.sent.conversationId);
    expect(back.sent.conversationId).toBe(goa.sent.conversationId);
    expect(back.reply.conversationId).toBe(goa.sent.conversationId);
    expect(metadataOf(back.delivery)).toMatchObject({ chat_epoch: 0 });
    expect((await conversationList(user)).map((c) => [c.id, c.active])).toEqual([
      [goa.sent.conversationId, true],
      [second.id, false],
    ]);
    // Without an id the next message follows the active one.
    expect((await say(user, 'thanks')).sent.conversationId).toBe(goa.sent.conversationId);
    // Naming the active one changes nothing.
    expect((await say(user, 'bye', goa.sent.conversationId)).sent.conversationId).toBe(
      goa.sent.conversationId,
    );
  });

  it('404 for a conversation that is not the user’s, 409 for a Telegram one; nothing is saved or switched', async () => {
    const user = await chatUser();
    const other = await chatUser();
    await ensureSandbox(user.id);
    const mine = await say(user, 'my chat');
    const theirs = await say(other, 'their chat');
    const chatId = await linkedTelegram(user.id);
    await fromTelegram(chatId, 'hello from Telegram');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: hello from Telegram'));
    const [telegram] = await conversationList(user, '?channel=telegram');
    const before = await db().select().from(messages).where(eq(messages.userId, user.id));

    const send = (conversationId: string) =>
      call('/v1/messages', {
        method: 'POST',
        token: user.token,
        body: { text: 'sneaky', clientMessageId: randomUUID(), conversationId },
      });
    await expectContract('sendMessage', await send('cnv_nope'), 404);
    await expectContract('sendMessage', await send(theirs.sent.conversationId), 404);
    const refused = await expectContract<ApiError>('sendMessage', await send(telegram!.id), 409);
    expect(refused.error.code).toBe('conflict');

    expect(await db().select().from(messages).where(eq(messages.userId, user.id))).toEqual(before);
    expect(await textsIn(other.id, theirs.sent.conversationId)).toEqual([
      'their chat',
      're: their chat',
    ]);
    expect((await conversationList(user, '?channel=web')).map((c) => [c.id, c.active])).toEqual([
      [mine.sent.conversationId, true],
    ]);
  });

  it('the same message sent again does not switch the conversation back', async () => {
    const user = await chatUser();
    const goa = await say(user, 'about Goa');
    const second = await startConversation(user);
    const body = {
      text: 'and the hotel?',
      clientMessageId: randomUUID(),
      conversationId: goa.sent.conversationId,
    };
    const post = () => call('/v1/messages', { method: 'POST', token: user.token, body });
    const first = await expectContract<ApiMessage>('sendMessage', await post(), 202);
    await turnEnded(first.id);
    // The user opens the other one; then the browser repeats the earlier request.
    await expectContract(
      'updateConversation',
      await patchConversation(user, second.id, { active: true }),
      200,
    );
    const again = await expectContract<ApiMessage>('sendMessage', await post(), 202);
    expect(again).toMatchObject({ id: first.id, conversationId: goa.sent.conversationId });
    expect((await conversationList(user)).find((c) => c.active)!.id).toBe(second.id);
    expect(vm.deliveries.filter((d) => d.text.endsWith('and the hotel?'))).toHaveLength(1);
  });
});

describe('GET /v1/messages', () => {
  it('by conversation; `channel=web` is the active web conversation; no filter is everything', async () => {
    const user = await chatUser();
    const other = await chatUser();
    await ensureSandbox(user.id);
    // Web chat has no conversation yet.
    expect(await messageTexts(user, '?channel=web')).toEqual([]);

    const goa = await say(user, 'about Goa');
    const second = await startConversation(user);
    await say(user, 'about laptops');
    const chatId = await linkedTelegram(user.id);
    await fromTelegram(chatId, 'hello from Telegram');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: hello from Telegram'));
    await fromTelegram(chatId, '/new');
    await fromTelegram(chatId, 'second Telegram chat');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: second Telegram chat'));

    expect(await messageTexts(user, `?conversationId=${goa.sent.conversationId}`)).toEqual([
      're: about Goa',
      'about Goa',
    ]);
    expect(await messageTexts(user, `?conversationId=${second.id}`)).toEqual([
      're: about laptops',
      'about laptops',
    ]);
    // The active web conversation is the second one.
    expect(await messageTexts(user, '?channel=web')).toEqual([
      're: about laptops',
      'about laptops',
    ]);
    await expectContract(
      'updateConversation',
      await patchConversation(user, goa.sent.conversationId, { active: true }),
      200,
    );
    expect(await messageTexts(user, '?channel=web')).toEqual(['re: about Goa', 'about Goa']);
    // Another channel without a conversation: all of that channel. A Telegram conversation can be
    // read by its id.
    expect(await messageTexts(user, '?channel=telegram')).toEqual([
      're: second Telegram chat',
      'second Telegram chat',
      're: hello from Telegram',
      'hello from Telegram',
    ]);
    const [, firstTelegram] = await conversationList(user, '?channel=telegram');
    expect(await messageTexts(user, `?conversationId=${firstTelegram!.id}`)).toEqual([
      're: hello from Telegram',
      'hello from Telegram',
    ]);
    // No filter: every message, as before.
    expect(await messageTexts(user, '')).toHaveLength(8);

    // Paging inside one conversation.
    await say(user, 'and the hotel?');
    const p1 = await expectContract<Page<ApiMessage>>(
      'listMessages',
      await call(`/v1/messages?conversationId=${goa.sent.conversationId}&limit=3`, {
        token: user.token,
      }),
      200,
    );
    expect(p1.items.map((m) => m.text)).toEqual([
      're: and the hotel?',
      'and the hotel?',
      're: about Goa',
    ]);
    expect(p1.items.every((m) => m.conversationId === goa.sent.conversationId)).toBe(true);
    expect(
      await messageTexts(
        user,
        `?conversationId=${goa.sent.conversationId}&limit=3&cursor=${p1.nextCursor}`,
      ),
    ).toEqual(['about Goa']);

    // Not this user's, or not there: 404, and nothing of the other user's is shown.
    await expectContract(
      'listMessages',
      await call(`/v1/messages?conversationId=${goa.sent.conversationId}`, { token: other.token }),
      404,
    );
    await expectContract(
      'listMessages',
      await call('/v1/messages?conversationId=cnv_nope', { token: user.token }),
      404,
    );
  });
});

describe('DELETE /v1/conversations/{id}', () => {
  async function upload(user: TestUser, name: string): Promise<string> {
    const form = new FormData();
    form.append('file', new File([`contents of ${name}`], name, { type: 'text/plain' }));
    const res = await testApp().request('/v1/attachments', {
      method: 'POST',
      headers: { authorization: `Bearer ${user.token}` },
      body: form,
    });
    return (await expectContract<{ id: string }>('uploadAttachment', res, 201)).id;
  }

  const fileOf = async (id: string) =>
    (await db().select().from(attachments).where(eq(attachments.id, id))).at(0);

  /** A web message with files, and its turn. */
  async function sayWithFiles(user: TestUser, text: string, attachmentIds: string[]) {
    const sent = await expectContract<ApiMessage>(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: user.token,
        body: { text, clientMessageId: randomUUID(), attachmentIds },
      }),
      202,
    );
    await turnEnded(sent.id);
    return sent;
  }

  it('removes the conversation, its messages and their files; the activity log has no text', async () => {
    const user = await chatUser();
    const other = await chatUser();
    const kept = await say(user, 'keep this one');
    await startConversation(user);
    const secret = await upload(user, 'passport.txt');
    const shared = await upload(user, 'shared.txt');
    const doomed = await sayWithFiles(user, 'my secret plan is Lisbon', [secret, shared]);
    await expectContract(
      'updateConversation',
      await patchConversation(user, doomed.conversationId, { title: 'Lisbon move' }),
      200,
    );
    // The same file is also shown in a message of another conversation: it must stay.
    await expectContract(
      'updateConversation',
      await patchConversation(user, kept.sent.conversationId, { active: true }),
      200,
    );
    await sayWithFiles(user, 'see this file', [shared]);
    const secretPath = (await fileOf(secret))!.path;
    const sharedPath = (await fileOf(shared))!.path;
    expect(existsSync(secretPath)).toBe(true);
    const theirs = await say(other, 'their chat');

    await expectContract(
      'deleteConversation',
      await removeConversation(other, doomed.conversationId),
      404,
    );
    await expectContract(
      'deleteConversation',
      await call(`/v1/conversations/${doomed.conversationId}`, { method: 'DELETE' }),
      401,
    );
    const live = await listen(user.id);
    try {
      await expectContract(
        'deleteConversation',
        await removeConversation(user, doomed.conversationId),
        204,
      );
      await waitFor(async () => live.of('conversation.deleted').length >= 1);
      expect(live.of('conversation.deleted')).toEqual([{ id: doomed.conversationId }]);
    } finally {
      live.stop();
    }

    expect((await conversationList(user)).map((c) => c.id)).toEqual([kept.sent.conversationId]);
    expect(await messagesIn(user.id, doomed.conversationId)).toEqual([]);
    expect(await messageTexts(user, '')).toEqual([
      're: see this file',
      'see this file',
      're: keep this one',
      'keep this one',
    ]);
    expect(await fileOf(secret)).toBeUndefined();
    expect(existsSync(secretPath)).toBe(false);
    expect(await fileOf(shared)).toBeDefined();
    expect(existsSync(sharedPath)).toBe(true);
    // Which engine ran in it is forgotten; the other conversation's record stays.
    const ran = await db().select().from(chatEngines).where(eq(chatEngines.userId, user.id));
    expect(ran.map((r) => r.epoch)).toEqual([0]);

    const entries = await activity(user.id, 'conversation_deleted');
    expect(entries.map((e) => [e.actor, e.summary])).toEqual([
      ['user', 'Deleted a conversation in web chat'],
    ]);
    expect(entries[0]!.details).toEqual({
      channel: 'web',
      epoch: 1,
      conversationId: doomed.conversationId,
    });
    expect(JSON.stringify(entries)).not.toContain('Lisbon');

    // Gone for good, and nobody else's data was touched.
    await expectContract(
      'deleteConversation',
      await removeConversation(user, doomed.conversationId),
      404,
    );
    await expectContract(
      'listMessages',
      await call(`/v1/messages?conversationId=${doomed.conversationId}`, { token: user.token }),
      404,
    );
    expect(await textsIn(other.id, theirs.sent.conversationId)).toEqual([
      'their chat',
      're: their chat',
    ]);
  });

  it('deleting the active web conversation makes the newest remaining one active', async () => {
    const user = await chatUser();
    const one = await say(user, 'one');
    const two = await startConversation(user);
    await say(user, 'two');
    const three = await startConversation(user);
    await say(user, 'three');
    // Deleting one that is not active changes nothing else.
    await expectContract(
      'deleteConversation',
      await removeConversation(user, one.sent.conversationId),
      204,
    );
    expect((await conversationList(user)).map((c) => [c.id, c.active])).toEqual([
      [three.id, true],
      [two.id, false],
    ]);

    const live = await listen(user.id);
    try {
      await expectContract('deleteConversation', await removeConversation(user, three.id), 204);
      await waitFor(async () => live.of('conversation.updated').length >= 1);
      expect(live.of('conversation.updated')).toMatchObject([{ id: two.id, active: true }]);
    } finally {
      live.stop();
    }
    expect((await conversationList(user)).map((c) => [c.id, c.active])).toEqual([[two.id, true]]);
    // Web chat goes on in that one, with its own number.
    const next = await say(user, 'two again');
    expect(next.sent.conversationId).toBe(two.id);
    expect(metadataOf(next.delivery)).toMatchObject({ chat_epoch: 1 });
  });

  it('deleting the last web conversation starts an empty one; a number is never used again', async () => {
    const user = await chatUser();
    const only = await say(user, 'the only one');
    expect(metadataOf(only.delivery)).toMatchObject({ chat_epoch: 0 });
    await expectContract(
      'deleteConversation',
      await removeConversation(user, only.sent.conversationId),
      204,
    );
    const [fresh, ...more] = await conversationList(user);
    expect(more).toEqual([]);
    expect(fresh).toMatchObject({ epoch: 1, active: true, title: 'New chat' });
    expect(fresh!.id).not.toBe(only.sent.conversationId);
    // The engine still holds number 0's context in the container: the new conversation must not
    // be delivered under that number.
    const next = await say(user, 'a fresh start');
    expect(next.sent.conversationId).toBe(fresh!.id);
    expect(metadataOf(next.delivery)).toMatchObject({ chat_epoch: 1 });
    expect(next.delivery.text).toBe('a fresh start');

    // Again, down to none and back: the number keeps rising.
    await expectContract('deleteConversation', await removeConversation(user, fresh!.id), 204);
    expect(await conversationList(user)).toMatchObject([{ epoch: 2, active: true }]);
    // That one was not started by the user, so the activity log has no "new chat" for it.
    expect(await activity(user.id, 'chat_started')).toEqual([]);
    expect(await activity(user.id, 'conversation_deleted')).toHaveLength(2);
  });

  it('Telegram: after its current conversation is deleted, the next message starts a new one', async () => {
    const user = await chatUser();
    await ensureSandbox(user.id);
    const chatId = await linkedTelegram(user.id);
    await fromTelegram(chatId, 'first Telegram chat');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: first Telegram chat'));
    await fromTelegram(chatId, '/new');
    await fromTelegram(chatId, 'second Telegram chat');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: second Telegram chat'));
    const [current, earlier] = await conversationList(user, '?channel=telegram');
    expect([current!.epoch, earlier!.epoch]).toEqual([1, 0]);

    await expectContract('deleteConversation', await removeConversation(user, current!.id), 204);
    expect((await activity(user.id, 'conversation_deleted')).map((e) => e.summary)).toEqual([
      'Deleted a conversation on Telegram',
    ]);
    // The earlier one is not made the current one: its context is not picked up again.
    expect(await conversationList(user, '?channel=telegram')).toMatchObject([
      { id: earlier!.id, active: false },
    ]);
    await fromTelegram(chatId, 'third Telegram chat');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: third Telegram chat'));
    const [latest] = await conversationList(user, '?channel=telegram');
    expect(latest).toMatchObject({ epoch: 2, active: true, title: 'third Telegram chat' });
    expect(metadataOf(deliveryOf('third Telegram chat'))).toMatchObject({ chat_epoch: 2 });
  });
});
