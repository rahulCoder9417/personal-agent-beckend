// A Telegram message waits for fewer rounds of database queries before the agent gets it and
// before its reply reaches Telegram (the database is on Neon in Ohio, about 260 ms a round from
// the Mumbai server), and nothing about what is saved or sent changes.
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { turnsBilled } from './billing-helpers.ts';
import { failNextQuery, installDbMeter, meter, roundsOf, setDbDelays } from './db-meter.ts';
import { installFakeTelegram, installFakeVm, telegramUpdate, type McpResult } from './fakes.ts';
import { call, chatUser, waitFor } from './helpers.ts';

let workers: Worker[];
let tg: ReturnType<typeof installFakeTelegram>;

beforeAll(() => {
  installDbMeter();
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  setDbDelays({});
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  tg = installFakeTelegram();
});

function sendTelegram(update: unknown) {
  return call('/webhooks/telegram', {
    method: 'POST',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
  });
}

/** A user with credits and a Telegram chat linked to them. */
async function linkedChat() {
  const user = await chatUser({ credits: 5000 });
  const chatId = 800_000_000 + Math.floor(Math.random() * 1e8);
  const { code } = (await (
    await call('/v1/channels/link-codes', {
      method: 'POST',
      token: user.token,
      body: { channel: 'telegram' },
    })
  ).json()) as { code: string };
  await sendTelegram(telegramUpdate(chatId, code));
  await waitFor(async () =>
    tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('✅ Linked')),
  );
  return { user, chatId };
}

/** What the bot sent to this chat, after the "Linked" message and the warm-up's answer. */
const repliesTo = (chatId: number) =>
  tg.sent.filter(
    (m) =>
      m.chatId === String(chatId) && !m.text.startsWith('✅ Linked') && m.text !== WARM_UP_ANSWER,
  );

const WARM_UP_ANSWER = 'echo: warm up';

/**
 * A linked chat that has had a turn already, as a chat on the server has: the user's container
 * exists and the container's token is known. Then `vm.state.agent` is set to `agent`.
 */
async function readyChat(
  vm: ReturnType<typeof installFakeVm>,
  agent: Parameters<typeof installFakeVm>[0],
) {
  const chat = await linkedChat();
  await sendTelegram(telegramUpdate(chat.chatId, 'warm up'));
  await waitFor(async () =>
    tg.sent.find((m) => m.chatId === String(chat.chatId) && m.text === WARM_UP_ANSWER),
  );
  // Its billing runs after it: done before anything is measured.
  await turnsBilled(chat.user.id);
  if (agent) vm.state.agent = agent;
  return chat;
}

const linkOf = async (userId: string) =>
  (await db().select().from(channelLinks).where(eq(channelLinks.userId, userId)))[0]!;

describe('before the turn', () => {
  it('a chat marked blocked that writes again: the mark is cleared before the agent answers', async () => {
    let blockedAtTurn: boolean | undefined;
    installFakeVm(async (d, mcp) => {
      blockedAtTurn = (await linkOf(d.userId)).blocked;
      await mcp('send_message', { text: 'back again', session_key: d.sessionKey });
    });
    const { user, chatId } = await linkedChat();
    await db().update(channelLinks).set({ blocked: true }).where(eq(channelLinks.userId, user.id));

    await sendTelegram(telegramUpdate(chatId, 'are you there'));
    await waitFor(async () => repliesTo(chatId).length === 1);
    expect(blockedAtTurn).toBe(false);
    expect(repliesTo(chatId)[0]!.text).toBe('back again');
    const link = await linkOf(user.id);
    expect(link.blocked).toBe(false);
    expect(link.lastInboundAt).not.toBeNull();
  });

  it("a failed write of the chat's last message time fails the job; the next try answers once", async () => {
    const vm = installFakeVm();
    const { chatId } = await linkedChat();
    failNextQuery(/^update "channel_links" set "last_inbound_at"/);

    await sendTelegram(telegramUpdate(chatId, 'hello again'));
    await waitFor(async () => repliesTo(chatId).length === 1);
    // The retry had nothing left to do: one turn, one reply.
    await new Promise((r) => setTimeout(r, 300));
    expect(repliesTo(chatId).map((m) => m.text)).toEqual(['echo: hello again']);
    expect(vm.deliveries.filter((d) => d.sessionKey === `telegram:${chatId}`)).toHaveLength(1);
  });
});

describe('the rounds of queries a Telegram turn waits for', () => {
  /** Each query waits this long, like a database far away. */
  const RTT = 80;
  /** Queries sent within this of each other went at the same time. */
  const GAP = 30;

  it('before the agent gets the message, and from its answer to Telegram', async () => {
    let deliveredAt = 0;
    const { chatId } = await readyChat(installFakeVm(), async (d, mcp) => {
      deliveredAt = performance.now();
      await mcp('send_message', { text: `echo: ${d.text}`, session_key: d.sessionKey });
    });
    const inbound = workers.find((w) => w.name === 'inbound')!;
    await inbound.pause();
    await sendTelegram(telegramUpdate(chatId, 'what is on my calendar'));

    let t0 = 0;
    const m = await meter(async () => {
      setDbDelays({ rttMs: RTT });
      try {
        t0 = performance.now();
        inbound.resume();
        await waitFor(async () => repliesTo(chatId).length === 1);
      } finally {
        setDbDelays({});
      }
    });
    const replyAt = tg.calls.find(
      (c) => c.method === 'sendMessage' && c.chatId === String(chatId) && c.at > t0,
    )!.at;
    const before = roundsOf(m.sql, GAP, 0, deliveredAt - t0);
    // Up to the Bot API call (the queries sent in the same moment come after it).
    const toTelegram = roundsOf(m.sql, GAP, deliveredAt - t0, replyAt - t0 - 5);
    const timeline = m.sql.join('\n');
    // Before 15 October, evening: 11 rounds before the agent (the event, the link, the chat's
    // last message time, whether the message was saved, the conversation, the message, the
    // conversation's time, the turn's reads, the container record, memory and the recap, the
    // message's state) and 5 from the answer to Telegram (the chat, the conversation, the
    // message, the conversation's time, the outbound job's read).
    expect(before, timeline).toBeLessThanOrEqual(9);
    expect(toTelegram, timeline).toBeLessThanOrEqual(3);
  });
});

describe("the agent's send_message", () => {
  it("reads the chat and the turn's conversation at once, and that conversation only once", async () => {
    let sendSql: string[] = [];
    let result: McpResult | undefined;
    const { chatId } = await readyChat(installFakeVm(), async (d, mcp) => {
      const m = await meter(async () => {
        setDbDelays({ rttMs: 60 });
        try {
          result = await mcp('send_message', { text: 'on it', session_key: d.sessionKey });
        } finally {
          setDbDelays({});
        }
      });
      sendSql = m.sql;
    });
    await sendTelegram(telegramUpdate(chatId, 'plan my day'));
    await waitFor(async () => repliesTo(chatId).length === 1);
    await waitFor(async () => result);

    expect(result?.isError).toBe(false);
    const timeline = sendSql.join('\n');
    expect(
      // A conversation's read (the logged SQL is cut short, so it is told by its columns).
      sendSql.filter((q) => q.includes('select "id", "user_id", "session_key", "channel", "kind"')),
      timeline,
    ).toHaveLength(1);
    const at = (sqlStart: string) =>
      Number(/^(\d+)ms /.exec(sendSql.find((q) => q.includes(sqlStart))!)![1]);
    const chatCheck = at('select "id", "user_id", "channel", "external_id", "display_id"');
    const conversationRead = at('select "id", "user_id", "session_key", "channel", "kind"');
    const insert = at('insert into "messages"');
    // The chat's check and the conversation's read went together (sent in the same moment, each
    // waits 60 ms), both before the message is saved.
    expect(Math.abs(chatCheck - conversationRead), timeline).toBeLessThan(25);
    expect(insert, timeline).toBeGreaterThan(Math.max(chatCheck, conversationRead) + 50);
  });

  it("a reply goes out once even when the conversation's last message time can't be saved", async () => {
    let result: McpResult | undefined;
    installFakeVm(async (d, mcp) => {
      failNextQuery(/^update "conversations" set "last_message_at"/);
      result = await mcp('send_message', { text: 'done', session_key: d.sessionKey });
    });
    const { user, chatId } = await linkedChat();
    await sendTelegram(telegramUpdate(chatId, 'book it'));
    await waitFor(async () => repliesTo(chatId).length === 1);
    await new Promise((r) => setTimeout(r, 300));

    // The tool said yes, so the agent did not send it again.
    expect(result?.isError).toBe(false);
    expect(repliesTo(chatId).map((m) => m.text)).toEqual(['done']);
    const out = await db()
      .select()
      .from(messages)
      .where(
        and(eq(messages.userId, user.id), eq(messages.direction, 'out'), eq(messages.text, 'done')),
      );
    expect(out).toHaveLength(1);
    await waitFor(async () => {
      const [row] = await db().select().from(messages).where(eq(messages.id, out[0]!.id));
      return row?.status === 'sent';
    });
  });
});
