// "New chat": the user starts a fresh conversation (web chat's button, or `/new` in Telegram).
// The new conversation gets the chat's next number (its epoch), every delivery carries the number
// of its conversation in metadata_json, the recap holds only that conversation, and saved memories
// stay. No turn runs and nothing is charged for it. (What a user can do with their conversations
// besides starting one is in conversations.test.ts.)
import { randomUUID } from 'node:crypto';
import type { Job, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { chatCounter } from '../src/modules/channels/conversations.ts';
import { saveWebMessage } from '../src/modules/channels/messages.ts';
import { chatEpochs, conversations, messages } from '../src/modules/channels/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { events } from '../src/modules/events/schema.ts';
import { markClaudeConnected } from '../src/modules/orchestrator/agent-settings.ts';
import {
  isNewChatCommand,
  NEW_CHAT_TEXT,
  NEW_CHATS_PER_HOUR,
} from '../src/modules/orchestrator/chats.ts';
import { handleDeleteUser } from '../src/modules/orchestrator/lifecycle.ts';
import { handleProcessMessage } from '../src/modules/orchestrator/process-message.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { RECAP_END } from '../src/modules/orchestrator/turn-context.ts';
import { runTurn } from '../src/modules/orchestrator/turn.ts';
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
  type SentTelegram,
} from './fakes.ts';
import { call, chatUser, createUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[];
let vm: ReturnType<typeof installFakeVm>;
let tg: { sent: SentTelegram[] };

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
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

type MessagePage = { items: Array<{ text: string }>; chatStartedAt: string | null };

const newChat = (token?: string) =>
  call('/v1/chats/new', { method: 'POST', ...(token ? { token } : {}) });

async function startWebChat(token: string): Promise<string> {
  const res = await expectContract<{ chatStartedAt: string }>(
    'startNewChat',
    await newChat(token),
    200,
  );
  return res.chatStartedAt;
}

const listMessages = async (token: string) =>
  expectContract<MessagePage>('listMessages', await call('/v1/messages', { token }), 200);

/** The `metadata_json` of a delivery, read back. */
const metadataOf = (d: unknown) =>
  JSON.parse((d as { metadataJson: string }).metadataJson) as Record<string, unknown>;

/** The highest conversation number given out in a chat so far (undefined: it never had one). */
const epochOf = async (userId: string, sessionKey: string) =>
  (await chatCounter(userId, sessionKey))?.epoch;

/** The user says something in web chat; it is stored, then delivered as a turn. */
async function say(userId: string, text: string) {
  const { message } = await saveWebMessage({ userId, text, clientMessageId: randomUUID() });
  const outcome = await runTurn({
    userId,
    deliveryId: `evt_${randomUUID()}`,
    kind: 'message',
    sessionKey: 'web',
    channel: 'web',
    text,
    inboundMessageId: message.id,
    conversationId: message.conversationId,
  });
  const delivery = vm.deliveries.at(-1)!;
  return { outcome, got: delivery.text, metadata: metadataOf(delivery) };
}

function recapLines(text: string): string[] {
  const all = text.split('\n');
  const from = all.findIndex((l) => l.startsWith('[Earlier in this chat.'));
  expect(from, `no recap in:\n${text}`).toBeGreaterThanOrEqual(0);
  return all.slice(from + 1, all.indexOf(RECAP_END));
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

async function sendTelegram(chatId: number, text: string) {
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
  return update;
}

/** The event of a Telegram update, once its job has ended. */
const eventDone = (updateId: number) =>
  waitFor(async () => {
    const [row] = await db()
      .select()
      .from(events)
      .where(eq(events.externalId, String(updateId)));
    return row && ['done', 'ignored', 'failed'].includes(row.status) ? row : undefined;
  });

const startedEntries = (userId: string) =>
  db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.action, 'chat_started')));

describe('new web chat: POST /v1/chats/new', () => {
  it('starts one, GET /v1/messages tells when, and the old messages are still listed', async () => {
    const user = await chatUser();
    await ensureSandbox(user.id);
    await expectContract('startNewChat', await newChat(), 401);
    await say(user.id, 'plan a trip to Goa');
    expect((await listMessages(user.token)).chatStartedAt).toBeNull();

    const before = Date.now();
    const startedAt = await startWebChat(user.token);
    expect(Date.parse(startedAt)).toBeGreaterThanOrEqual(before - 1000);
    const page = await listMessages(user.token);
    expect(page.chatStartedAt).toBe(startedAt);
    expect(page.items.map((m) => m.text)).toEqual(['re: plan a trip to Goa', 'plan a trip to Goa']);
    expect(await chatCounter(user.id, 'web')).toMatchObject({
      epoch: 1,
      startedAt: new Date(startedAt),
    });

    // Again: a later time, the next epoch.
    const again = await startWebChat(user.token);
    expect(Date.parse(again)).toBeGreaterThan(Date.parse(startedAt));
    expect((await listMessages(user.token)).chatStartedAt).toBe(again);
    expect(await epochOf(user.id, 'web')).toBe(2);
  });

  it('is in the activity log as chat_started by the user, with the channel and no message text', async () => {
    const user = await chatUser();
    await ensureSandbox(user.id);
    await say(user.id, 'my secret plan is to move to Lisbon');
    await startWebChat(user.token);
    const entries = await startedEntries(user.id);
    expect(entries.map((e) => [e.actor, e.summary])).toEqual([
      ['user', 'Started a new chat in web chat'],
    ]);
    expect(JSON.stringify(entries)).not.toContain('Lisbon');
  });

  it('runs no turn and charges nothing; works at zero credits', async () => {
    const user = await createUser(); // no credits
    await startWebChat(user.token);
    expect(vm.deliveries).toHaveLength(0);
    expect(vm.wakes).toHaveLength(0);
    expect(await db().select().from(messages).where(eq(messages.userId, user.id))).toEqual([]);
  });

  it(`is limited to ${NEW_CHATS_PER_HOUR} an hour per user`, async () => {
    const user = await createUser();
    const other = await createUser();
    for (let i = 0; i < NEW_CHATS_PER_HOUR; i++) await startWebChat(user.token);
    await expectContract('startNewChat', await newChat(user.token), 429);
    expect(await epochOf(user.id, 'web')).toBe(NEW_CHATS_PER_HOUR);
    // Per user.
    await startWebChat(other.token);
  });
});

describe('every delivery carries the chat epoch', () => {
  it('0 until a new chat, then the new number; each chat has its own', async () => {
    const user = await chatUser();
    await ensureSandbox(user.id);
    expect((await say(user.id, 'one')).metadata).toMatchObject({ chat_epoch: 0 });
    await startWebChat(user.token);
    expect((await say(user.id, 'two')).metadata).toMatchObject({ chat_epoch: 1 });
    await startWebChat(user.token);
    expect((await say(user.id, 'three')).metadata).toMatchObject({ chat_epoch: 2 });

    // The Telegram chat was never restarted: still 0.
    const chatId = await linkedTelegram(user.id);
    await sendTelegram(chatId, 'hello from Telegram');
    const delivery = await waitFor(async () =>
      vm.deliveries.find((d) => d.sessionKey === `telegram:${chatId}`),
    );
    expect(metadataOf(delivery)).toMatchObject({ chat_epoch: 0 });
  });

  it('kept with the rest of the metadata: apps, the Claude choice, an automation’s own fields', async () => {
    const user = await chatUser();
    await ensureSandbox(user.id);
    await startWebChat(user.token);
    vm.claudeConnected.add(user.id);
    await markClaudeConnected(user.id);
    await runTurn({
      userId: user.id,
      deliveryId: `evt_${randomUUID()}`,
      kind: 'automation',
      sessionKey: 'web',
      channel: 'web',
      text: '[Automation "Brief"] Summarise my inbox',
      // An automation can't set the platform's own fields.
      metadata: { automationId: 'aut_1', chat_epoch: 99 },
    });
    expect(metadataOf(vm.deliveries.at(-1))).toEqual({
      automationId: 'aut_1',
      chat_epoch: 1,
      claude: {},
    });
  });
});

describe('the recap after a new chat', () => {
  it('leaves out everything said before the new chat: it holds the new conversation only', async () => {
    const user = await chatUser();
    await ensureSandbox(user.id);
    await say(user.id, 'plan a trip to Goa');
    await startWebChat(user.token);
    // The same engine: no recap (the Bridge starts its fresh conversation from the epoch).
    expect((await say(user.id, 'what is a good laptop?')).got).toBe('what is a good laptop?');

    vm.claudeConnected.add(user.id);
    await markClaudeConnected(user.id);
    const turn = await say(user.id, 'under 1000 dollars');
    expect(recapLines(turn.got)).toEqual([
      'User: what is a good laptop?',
      'You: re: what is a good laptop?',
    ]);
    expect(turn.got).not.toContain('Goa');
  });

  it('nothing at all when the new chat started just before the engine changed', async () => {
    const user = await chatUser();
    await ensureSandbox(user.id);
    await say(user.id, 'plan a trip to Goa');
    await say(user.id, 'for four days');
    await startWebChat(user.token);
    vm.claudeConnected.add(user.id);
    await markClaudeConnected(user.id);
    expect((await say(user.id, 'hello again')).got).toBe('hello again');
  });

  it('saved memories stay: the memory block still comes with the turn', async () => {
    const user = await chatUser();
    await ensureSandbox(user.id);
    const r = await mcpCall(vm.tokens.get(user.id)!, 'remember', { content: 'Is vegetarian' });
    expect(r.isError, r.text).toBe(false);
    await startWebChat(user.token);
    expect((await say(user.id, 'book a table')).got).toContain('- (fact) Is vegetarian');
  });
});

describe('/new in Telegram', () => {
  it('accepts /new, /clear, /reset and /new@<bot>, alone; nothing else', () => {
    for (const t of ['/new', '/clear', '/reset', ' /NEW ', '/new@textcrew_bot', '/reset@Bot'])
      expect(isNewChatCommand(t), t).toBe(true);
    for (const t of ['new', '/new chat', '/newer', '/start', 'please /new', '/new@'])
      expect(isNewChatCommand(t), t).toBe(false);
  });

  it('starts a new chat for that Telegram chat: the fixed answer, no turn, nothing saved or charged', async () => {
    const user = await chatUser();
    await ensureSandbox(user.id);
    const chatId = await linkedTelegram(user.id);
    const sessionKey = `telegram:${chatId}`;
    await sendTelegram(chatId, 'plan a trip to Goa');
    await waitFor(async () => tg.sent.find((m) => m.text === 're: plan a trip to Goa'));
    const deliveries = vm.deliveries.length;
    // Once the turn is over (its last step marks the message delivered) and the answer is sent,
    // the stored messages no longer change.
    const saved = await waitFor(async () => {
      const all = await db().select().from(messages).where(eq(messages.userId, user.id));
      return all.length === 2 && all.every((m) => ['delivered', 'sent'].includes(m.status))
        ? all
        : undefined;
    });

    for (const [i, command] of ['/new', '/clear', '/reset'].entries()) {
      const update = await sendTelegram(chatId, command);
      await eventDone(update.update_id);
      await waitFor(async () => tg.sent.filter((m) => m.text === NEW_CHAT_TEXT).length === i + 1);
      expect(await epochOf(user.id, sessionKey)).toBe(i + 1);
    }
    expect(NEW_CHAT_TEXT).toBe(
      "Started a new chat. I won't use what we talked about before here. Your saved memories stay.",
    );
    expect(
      tg.sent.filter((m) => m.text === NEW_CHAT_TEXT).every((m) => m.chatId === String(chatId)),
    ).toBe(true);
    expect(vm.deliveries).toHaveLength(deliveries);
    expect(await db().select().from(messages).where(eq(messages.userId, user.id))).toEqual(saved);
    // Web chat is a chat of its own: untouched (it has had no conversation yet).
    expect(await chatCounter(user.id, 'web')).toBeUndefined();
    expect((await startedEntries(user.id)).map((e) => e.summary)).toEqual([
      'Started a new chat on Telegram',
      'Started a new chat on Telegram',
      'Started a new chat on Telegram',
    ]);

    // The next message goes to the agent with the new epoch.
    await sendTelegram(chatId, 'what is a good laptop?');
    const next = await waitFor(async () => vm.deliveries.at(deliveries));
    expect(next.text).toBe('what is a good laptop?');
    expect(metadataOf(next)).toMatchObject({ chat_epoch: 3 });
  });

  it('the same event run again starts one chat and answers once', async () => {
    const user = await chatUser();
    const chatId = await linkedTelegram(user.id);
    const update = await sendTelegram(chatId, '/new');
    const event = await eventDone(update.update_id);
    await waitFor(async () => tg.sent.find((m) => m.text === NEW_CHAT_TEXT));

    await handleProcessMessage({ data: { eventId: event.id } } as Job);
    await new Promise((r) => setTimeout(r, 300));
    expect(await epochOf(user.id, `telegram:${chatId}`)).toBe(1);
    expect(
      await db().select().from(conversations).where(eq(conversations.userId, user.id)),
    ).toHaveLength(1);
    expect(tg.sent.filter((m) => m.text === NEW_CHAT_TEXT)).toHaveLength(1);
    expect(await startedEntries(user.id)).toHaveLength(1);
  });

  it('from a chat that is not linked, it only gets the link instructions', async () => {
    const chatId = Math.floor(Math.random() * 1e9);
    await sendTelegram(chatId, '/new');
    const reply = await waitFor(async () => tg.sent.find((m) => m.chatId === String(chatId)));
    expect(reply.text).toContain("isn't linked");
    expect(tg.sent.some((m) => m.text === NEW_CHAT_TEXT)).toBe(false);
  });
});

it('deleting the account removes the conversations and the chat counters', async () => {
  const user = await chatUser();
  const other = await createUser();
  await ensureSandbox(user.id);
  // Two conversations, the first with messages in it.
  await say(user.id, 'plan a trip to Goa');
  await startWebChat(user.token);
  await startWebChat(other.token);
  await handleDeleteUser({ data: { userId: user.id } } as Job);
  expect(await db().select().from(messages).where(eq(messages.userId, user.id))).toEqual([]);
  expect(await db().select().from(chatEpochs).where(eq(chatEpochs.userId, user.id))).toEqual([]);
  expect(await db().select().from(conversations).where(eq(conversations.userId, user.id))).toEqual(
    [],
  );
  expect(await epochOf(other.id, 'web')).toBe(1);
  expect(
    await db().select().from(conversations).where(eq(conversations.userId, other.id)),
  ).toHaveLength(1);
});
