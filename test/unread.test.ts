// Unread conversations: a message from the agent the user hasn't seen yet puts a mark on its
// conversation in the web app's list. Reading the conversation (POST .../read) clears it, and so
// does the user writing in it, in any channel. (What migration 0025 does with the conversations
// already stored is in unread-backfill.test.ts.)
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { automationsChat, isUnread } from '../src/modules/channels/conversations.ts';
import { queueOutbound } from '../src/modules/channels/outbound.ts';
import { conversations, messages } from '../src/modules/channels/schema.ts';
import { subscribe, type StreamEvent } from '../src/modules/channels/stream.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { events } from '../src/modules/events/schema.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakeTelegram, installFakeVm, telegramUpdate } from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[];
/** Whether the agent answers the next turns ("re: <the turn's text>"), or says nothing. */
let answers = true;

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50], busyDelayMs: 25 });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  answers = true;
  installFakeVm(async (d, mcp) => {
    if (!answers) return;
    await mcp('send_message', {
      text: `re: ${d.text.split('\n').at(-1)}`,
      session_key: d.sessionKey,
    });
  });
  installFakeTelegram();
});

type ApiConversation = { id: string; channel: string; kind: string; unread: boolean };
type ApiMessage = { id: string; conversationId: string };
type TestUser = { id: string; token: string };

async function conversationList(user: TestUser, query = ''): Promise<ApiConversation[]> {
  const page = await expectContract<{ items: ApiConversation[] }>(
    'listConversations',
    await call(`/v1/conversations${query}`, { token: user.token }),
    200,
  );
  return page.items;
}

const unreadOf = async (user: TestUser, id: string) =>
  (await conversationList(user)).find((c) => c.id === id)?.unread;

const markRead = (user: TestUser, id: string) =>
  call(`/v1/conversations/${id}/read`, { method: 'POST', token: user.token });

/** The turn of an incoming message is over (its last step marks the message delivered). */
const turnEnded = (messageId: string) =>
  waitFor(async () => {
    const [row] = await db().select().from(messages).where(eq(messages.id, messageId));
    return row?.status === 'delivered' ? row : undefined;
  });

/** The user writes in web chat and the turn runs; returns their message once the turn is over. */
async function say(user: TestUser, text: string): Promise<ApiMessage> {
  const sent = await expectContract<ApiMessage>(
    'sendMessage',
    await call('/v1/messages', {
      method: 'POST',
      token: user.token,
      body: { text, clientMessageId: randomUUID() },
    }),
    202,
  );
  await turnEnded(sent.id);
  return sent;
}

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

/** A Telegram message arrives (the webhook); returns once its job has ended. */
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
  await waitFor(async () => {
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

describe('whether a conversation is unread', () => {
  it('is whether the agent’s newest message is later than what the user has read', () => {
    const t = (s: number) => new Date(Date.UTC(2026, 9, 16, 12, 0, s));
    expect(isUnread({ lastAgentMessageAt: null, lastReadAt: null })).toBe(false);
    expect(isUnread({ lastAgentMessageAt: null, lastReadAt: t(1) })).toBe(false);
    expect(isUnread({ lastAgentMessageAt: t(1), lastReadAt: null })).toBe(true);
    expect(isUnread({ lastAgentMessageAt: t(2), lastReadAt: t(1) })).toBe(true);
    expect(isUnread({ lastAgentMessageAt: t(1), lastReadAt: t(1) })).toBe(false);
    expect(isUnread({ lastAgentMessageAt: t(1), lastReadAt: t(2) })).toBe(false);
  });
});

describe('web chat', () => {
  it('a reply from the agent makes the conversation unread; the user’s own message never does', async () => {
    const user = await chatUser();
    answers = false;
    const quiet = await say(user, 'hello, anyone there?');
    expect(await unreadOf(user, quiet.conversationId)).toBe(false);

    answers = true;
    const sent = await say(user, 'what is on today?');
    await waitFor(async () => (await unreadOf(user, sent.conversationId)) === true);
  });

  it('reading it clears the mark and tells the stream once; the next reply brings it back', async () => {
    const user = await chatUser();
    const live = await listen(user.id);
    try {
      const { conversationId } = await say(user, 'plan my week');
      // The reply's conversation event says it is unread.
      await waitFor(async () => live.of('conversation.updated').some((c) => c.unread === true));
      expect(live.of('conversation.updated').at(-1)).toMatchObject({
        id: conversationId,
        unread: true,
      });

      live.seen.length = 0;
      const read = await expectContract<ApiConversation>(
        'markConversationRead',
        await markRead(user, conversationId),
        200,
      );
      expect(read).toMatchObject({ id: conversationId, unread: false });
      expect(await unreadOf(user, conversationId)).toBe(false);
      await waitFor(async () => live.of('conversation.updated').length >= 1);
      expect(live.of('conversation.updated')).toMatchObject([
        { id: conversationId, unread: false },
      ]);

      // Read already: the same answer, nothing written and nothing sent.
      live.seen.length = 0;
      const again = await expectContract<ApiConversation>(
        'markConversationRead',
        await markRead(user, conversationId),
        200,
      );
      expect(again).toMatchObject({ id: conversationId, unread: false });
      await new Promise((r) => setTimeout(r, 150));
      expect(live.of('conversation.updated')).toEqual([]);

      // A new reply: unread again.
      await say(user, 'and next week?');
      await waitFor(async () => (await unreadOf(user, conversationId)) === true);
    } finally {
      live.stop();
    }
  });

  it('a conversation the user is not in keeps its mark while they read another', async () => {
    const user = await chatUser();
    const first = await say(user, 'first chat');
    const started = await expectContract<ApiConversation>(
      'createConversation',
      await call('/v1/conversations', { method: 'POST', token: user.token }),
      201,
    );
    expect(started.unread).toBe(false);
    const second = await say(user, 'second chat');
    expect(second.conversationId).toBe(started.id);
    await waitFor(async () => (await unreadOf(user, second.conversationId)) === true);

    await expectContract('markConversationRead', await markRead(user, second.conversationId), 200);
    const list = await conversationList(user);
    expect(list.find((c) => c.id === second.conversationId)?.unread).toBe(false);
    expect(list.find((c) => c.id === first.conversationId)?.unread).toBe(true);
  });
});

describe('Telegram', () => {
  it('counts the same way: a reply there is unread in the web app, and writing there marks it read', async () => {
    const user = await chatUser();
    const chatId = await linkedTelegram(user.id);
    await fromTelegram(chatId, 'remind me about the dentist');
    const telegram = async () => (await conversationList(user, '?channel=telegram'))[0];
    await waitFor(async () => (await telegram())?.unread === true);

    // The user writes in that Telegram chat: what came before counts as seen.
    answers = false;
    await fromTelegram(chatId, 'thanks');
    expect((await telegram())?.unread).toBe(false);

    // Tex answers there again; the web app reads it.
    answers = true;
    await fromTelegram(chatId, 'and on Friday?');
    const conversation = await waitFor(async () => {
      const c = await telegram();
      return c?.unread ? c : undefined;
    });
    const read = await expectContract<ApiConversation>(
      'markConversationRead',
      await markRead(user, conversation.id),
      200,
    );
    expect(read).toMatchObject({ channel: 'telegram', unread: false });
    expect((await telegram())?.unread).toBe(false);
  });
});

describe('the Automations chat', () => {
  it('an automation run’s answer makes it unread, and it can be read like any other', async () => {
    const user = await chatUser();
    const { conversationId: open } = await say(user, 'hi');
    await expectContract('markConversationRead', await markRead(user, open), 200);

    const chat = await automationsChat(user.id);
    expect(await unreadOf(user, chat.id)).toBe(false);
    await queueOutbound({
      userId: user.id,
      sessionKey: 'web',
      text: 'Today: two meetings.',
      conversationId: chat.id,
      inAutomationsChat: true,
    });
    const list = await conversationList(user);
    expect(list.find((c) => c.id === chat.id)).toMatchObject({ kind: 'automations', unread: true });
    // The conversation the user has open is not touched.
    expect(list.find((c) => c.id === open)?.unread).toBe(false);

    const read = await expectContract<ApiConversation>(
      'markConversationRead',
      await markRead(user, chat.id),
      200,
    );
    expect(read).toMatchObject({ kind: 'automations', unread: false });
  });
});

describe('other users', () => {
  it('cannot read or clear another user’s conversation; an unknown one is 404', async () => {
    const owner = await chatUser();
    const other = await chatUser();
    const { conversationId } = await say(owner, 'my own chat');
    await waitFor(async () => (await unreadOf(owner, conversationId)) === true);

    const readUpTo = async () => {
      const [row] = await db()
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, conversationId), eq(conversations.userId, owner.id)));
      return row?.lastReadAt?.toISOString();
    };
    const before = await readUpTo();

    await expectContract('markConversationRead', await markRead(other, conversationId), 404);
    expect(await unreadOf(owner, conversationId)).toBe(true);
    expect(await readUpTo()).toBe(before);
    expect(await conversationList(other)).toEqual([]);

    await expectContract('markConversationRead', await markRead(owner, 'cnv_nope'), 404);
    expect((await markRead({ id: '', token: '' }, conversationId)).status).toBe(401);
  });
});
