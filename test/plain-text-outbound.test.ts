// A reply that goes out to a chat app is a plain message; the saved message and the web app keep
// the agent's Markdown (spec round 3, part 2). Only what is sent changes.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sendToChat } from '../src/modules/channels/adapters/index.ts';
import { setTelegramApi } from '../src/modules/channels/adapters/telegram.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { subscribe, type StreamEvent } from '../src/modules/channels/stream.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { NEW_CHAT_TEXT } from '../src/modules/orchestrator/chats.ts';
import { linkInstructionsText } from '../src/modules/orchestrator/process-message.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { outOfCreditsText } from '../src/modules/orchestrator/turn.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  imessageNumber,
  installFakeSendblue,
  installFakeWhatsapp,
  linkImessage,
  linkWhatsapp,
  phone,
  useChannelEnv,
} from './fakes-channels.ts';
import {
  installFakeTelegram,
  installFakeVm,
  mcpCall,
  telegramUpdate,
  type SentTelegram,
} from './fakes.ts';
import { call, chatUser, createUser, expectContract, waitFor } from './helpers.ts';

useChannelEnv();

let workers: Worker[];
let tg: { sent: SentTelegram[] };
let wa: ReturnType<typeof installFakeWhatsapp>;
let sb: ReturnType<typeof installFakeSendblue>;
let vm: ReturnType<typeof installFakeVm>;

/** What the agent writes: a heading, emphasis, code, a list with a link, a table. */
const MARKDOWN = [
  '## Your week',
  '',
  'Here is the **plan** for `acme/repo`:',
  '',
  '* review [PR #7](https://github.com/acme/repo/pull/7)',
  '* fix `parse_user_name`',
  '',
  '| Day | Task |',
  '|-----|------|',
  '| Mon | Review |',
].join('\n');
/** What a chat app gets. */
const PLAIN = [
  'Your week',
  '',
  'Here is the plan for acme/repo:',
  '',
  '- review PR #7 (https://github.com/acme/repo/pull/7)',
  '- fix parse_user_name',
  '',
  'Day: Task',
  'Mon: Review',
].join('\n');

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  tg = installFakeTelegram();
  wa = installFakeWhatsapp();
  sb = installFakeSendblue();
  // The agent answers every message with the same Markdown, in the chat it came from.
  vm = installFakeVm(
    async (d, mcp) =>
      void (await mcp('send_message', { text: MARKDOWN, session_key: d.sessionKey })),
  );
});

const chat = () => Math.floor(Math.random() * 1e9);
const tgPost = (update: unknown) =>
  call('/webhooks/telegram', {
    method: 'POST',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
  });
const sentTo = (chatId: number) => tg.sent.filter((m) => m.chatId === String(chatId));

async function linkTelegram(token: string): Promise<number> {
  const chatId = chat();
  const lc = (await (
    await call('/v1/channels/link-codes', { method: 'POST', token, body: { channel: 'telegram' } })
  ).json()) as { code: string };
  await tgPost(telegramUpdate(chatId, lc.code));
  await waitFor(async () => sentTo(chatId).find((m) => m.text.startsWith('✅')));
  return chatId;
}

/** The user's outgoing messages in one chat, oldest first. */
async function savedOut(userId: string, sessionKey: string) {
  const rows = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.sessionKey, sessionKey)));
  return rows
    .filter((m) => m.direction === 'out')
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

async function listen(userId: string) {
  const seen: StreamEvent[] = [];
  const stop = await subscribe(userId, (e) => void seen.push(e));
  const created = () =>
    seen
      .filter((e) => e.type === 'message.created')
      .map((e) => e.data as { direction: string; channel: string; text: string });
  return { created, stop };
}

type Listed = { items: Array<{ direction: string; text: string }> };

describe('a reply to Telegram', () => {
  it('arrives as plain text; the saved message, the stream and the API keep the Markdown', async () => {
    const u = await chatUser();
    const chatId = await linkTelegram(u.token);
    const live = await listen(u.id);
    try {
      await tgPost(telegramUpdate(chatId, 'plan my week'));
      const sent = await waitFor(async () => sentTo(chatId).find((m) => m.text.includes('week')));
      // What Telegram received: no Markdown symbols, and no parse mode asked for.
      expect(sent.text).toBe(PLAIN);

      // The row in `messages` still has the agent's own text, and is marked sent.
      const row = await waitFor(async () => {
        const [linked, reply] = await savedOut(u.id, `telegram:${chatId}`);
        return linked && reply?.status === 'sent' ? reply : undefined;
      });
      expect(row.text).toBe(MARKDOWN);

      // So does what the web app is given for this Telegram conversation: live and on request.
      await waitFor(async () => live.created().find((m) => m.direction === 'out'));
      expect(live.created().find((m) => m.direction === 'out')).toMatchObject({
        channel: 'telegram',
        text: MARKDOWN,
      });
      const listed = await expectContract<Listed>(
        'listMessages',
        await call('/v1/messages?channel=telegram', { token: u.token }),
        200,
      );
      expect(listed.items.find((m) => m.direction === 'out')!.text).toBe(MARKDOWN);
    } finally {
      live.stop();
    }
  });

  it('is made plain first, then checked for purchase links, then split', async () => {
    const u = await chatUser();
    const chatId = await linkTelegram(u.token);
    await ensureSandbox(u.id);
    const token = vm.tokens.get(u.id)!;
    const session_key = `telegram:${chatId}`;

    // A Markdown link to the billing page: the link comes out of its brackets first, so the
    // purchase-link check sees an ordinary address and replaces it.
    const upgrade = 'You can **upgrade** [here](http://web.test/billing). See `docs/a_b.md`.';
    await mcpCall(token, 'send_message', { text: upgrade, session_key });
    const one = await waitFor(async () => sentTo(chatId).find((m) => m.text.includes('upgrade')));
    expect(one.text).toBe('You can upgrade here (the Textcrew web app). See docs/a_b.md.');

    // Longer than one Telegram message as Markdown, shorter as plain text: it goes out as one.
    const long = Array.from({ length: 500 }, (_, i) => `**w${i}**`).join(' ');
    expect(long.length).toBeGreaterThan(4096);
    expect((await mcpCall(token, 'send_message', { text: long, session_key })).isError).toBe(false);
    const parts = await waitFor(async () => {
      const found = sentTo(chatId).filter((m) => m.text.includes('w0 '));
      return found.length ? found : undefined;
    });
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toBe(Array.from({ length: 500 }, (_, i) => `w${i}`).join(' '));

    const saved = (await savedOut(u.id, session_key)).map((m) => m.text);
    expect(saved).toEqual([expect.stringContaining('✅'), upgrade, long]);
  });
});

describe('the one way out', () => {
  it('sends Telegram a simple message and asks for no formatting of its own', async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    setTelegramApi(async (method, body) => {
      calls.push({ method, body });
      return { message_id: 7 };
    });
    const result = await sendToChat('telegram', '99', { text: '**Done.** See `the_notes`.' });
    expect(result).toEqual({ externalId: '7' });
    // Only the chat and the text: no parse mode, so Telegram shows the text as it is.
    expect(calls).toEqual([
      { method: 'sendMessage', body: { chat_id: '99', text: 'Done. See the_notes.' } },
    ]);
  });

  it('sends nothing for web chat', async () => {
    expect(await sendToChat('web', '', { text: '**Done.**' })).toEqual({});
    expect(tg.sent).toHaveLength(0);
  });
});

describe('the web chat', () => {
  it('is untouched: the message, the stream event and the API carry the Markdown', async () => {
    const u = await chatUser();
    const live = await listen(u.id);
    try {
      await expectContract(
        'sendMessage',
        await call('/v1/messages', {
          method: 'POST',
          token: u.token,
          body: { text: 'plan my week', clientMessageId: randomUUID() },
        }),
        202,
      );
      const row = await waitFor(async () =>
        (await savedOut(u.id, 'web')).find((m) => m.status === 'sent'),
      );
      expect(row.text).toBe(MARKDOWN);
      await waitFor(async () => live.created().find((m) => m.direction === 'out'));
      expect(live.created().find((m) => m.direction === 'out')).toMatchObject({
        channel: 'web',
        text: MARKDOWN,
      });
      const listed = await expectContract<Listed>(
        'listMessages',
        await call('/v1/messages?channel=web', { token: u.token }),
        200,
      );
      expect(listed.items.find((m) => m.direction === 'out')!.text).toBe(MARKDOWN);
      // Nothing was sent to any chat app for it.
      expect(tg.sent).toHaveLength(0);
      expect(wa.sent).toHaveLength(0);
      expect(sb.sent).toHaveLength(0);
    } finally {
      live.stop();
    }
  });
});

describe('the other chat apps', () => {
  it('WhatsApp and iMessage get plain text too; WhatsApp keeps its purchase link', async () => {
    const u = await chatUser();
    const waNumber = phone();
    const smsNumber = imessageNumber();
    await linkWhatsapp(u.token, waNumber, wa);
    await linkImessage(u.token, smsNumber, sb);
    await ensureSandbox(u.id);
    const token = vm.tokens.get(u.id)!;

    await mcpCall(token, 'send_message', { text: MARKDOWN, session_key: `whatsapp:${waNumber}` });
    const onWhatsapp = await waitFor(async () =>
      wa.sent.find((m) => m.to === waNumber && m.text?.includes('week')),
    );
    expect(onWhatsapp.text).toBe(PLAIN);

    await mcpCall(token, 'send_message', { text: MARKDOWN, session_key: `imessage:${smsNumber}` });
    const onImessage = await waitFor(async () =>
      sb.sent.find((m) => m.number === smsNumber && m.content.includes('week')),
    );
    expect(onImessage.content).toBe(PLAIN);

    await mcpCall(token, 'send_message', {
      text: 'Top up [here](http://web.test/billing).',
      session_key: `whatsapp:${waNumber}`,
    });
    const link = await waitFor(async () => wa.sent.find((m) => m.text?.startsWith('Top up')));
    expect(link.text).toBe('Top up here (http://web.test/billing).');

    expect((await savedOut(u.id, `whatsapp:${waNumber}`)).map((m) => m.text)).toContain(MARKDOWN);
    expect((await savedOut(u.id, `imessage:${smsNumber}`)).map((m) => m.text)).toContain(MARKDOWN);
  });
});

describe('our own messages', () => {
  it('arrive exactly as they are written', async () => {
    // A chat that is not linked: the link instructions (an address and "Settings → Channels").
    const stranger = chat();
    await tgPost(telegramUpdate(stranger, 'hi'));
    const instructions = await waitFor(async () => sentTo(stranger)[0]);
    expect(instructions.text).toBe(linkInstructionsText());

    // Linking, then /new.
    const u = await chatUser();
    const chatId = await linkTelegram(u.token);
    expect(sentTo(chatId)[0]!.text).toBe(
      '✅ Linked! You can chat with your agent right here. What can I do for you?',
    );
    await tgPost(telegramUpdate(chatId, '/new'));
    await waitFor(async () => sentTo(chatId).find((m) => m.text === NEW_CHAT_TEXT));

    // A user with no credits: the out-of-credits reply.
    const broke = await createUser();
    const brokeChat = await linkTelegram(broke.token);
    await tgPost(telegramUpdate(brokeChat, 'do something'));
    await waitFor(async () =>
      sentTo(brokeChat).find((m) => m.text === outOfCreditsText('telegram')),
    );
    expect(vm.deliveries.filter((d) => d.userId === broke.id)).toHaveLength(0);
  });
});
