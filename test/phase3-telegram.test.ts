import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Job, Worker } from 'bullmq';
import { channelLinks, linkCodes } from '../src/modules/auth/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { events } from '../src/modules/events/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { handleProcessMessage } from '../src/modules/orchestrator/process-message.ts';
import { sha256Hex } from '../src/shared/crypto.ts';
import { db } from '../src/shared/db/client.ts';
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
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[];
let vmFake: ReturnType<typeof installFakeVm>;
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
  vmFake = installFakeVm();
  tg = installFakeTelegram();
});

async function sendTelegram(update: unknown, secret = 'tg-secret') {
  return call('/webhooks/telegram', {
    method: 'POST',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': secret },
  });
}

async function linkTelegram(token: string, chatId: number) {
  const lc = await expectContract<{ code: string; deepLink: string }>(
    'createLinkCode',
    await call('/v1/channels/link-codes', { method: 'POST', token, body: { channel: 'telegram' } }),
    201,
  );
  await expectContract('webhookTelegram', await sendTelegram(telegramUpdate(chatId, lc.code)), 200);
  await waitFor(async () =>
    tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('✅ Linked')),
  );
  return lc;
}

const chat = () => Math.floor(Math.random() * 1e9);

async function newCode(token: string) {
  return expectContract<{ code: string }>(
    'createLinkCode',
    await call('/v1/channels/link-codes', { method: 'POST', token, body: { channel: 'telegram' } }),
    201,
  );
}

/** What the bot sent to this chat after the "Linked" message. */
const repliesTo = (chatId: number) =>
  tg.sent.filter((m) => m.chatId === String(chatId) && !m.text.startsWith('✅ Linked'));

async function codeUnused(code: string): Promise<boolean> {
  const [row] = await db()
    .select()
    .from(linkCodes)
    .where(eq(linkCodes.codeHash, sha256Hex(code)));
  return Boolean(row && row.usedAt === null);
}

describe('Phase 3: Telegram end to end', () => {
  it('rejects a webhook with the wrong secret', async () => {
    await expectContract(
      'webhookTelegram',
      await sendTelegram(telegramUpdate(1, 'hi'), 'wrong'),
      401,
    );
  });

  it('an unlinked user only gets the link message; nothing reaches an agent', async () => {
    const chatId = chat();
    await sendTelegram(telegramUpdate(chatId, 'hello there'));
    const reply = await waitFor(async () => tg.sent.find((m) => m.chatId === String(chatId)));
    expect(reply.text).toContain("isn't linked");
    // It sends the user to the web app's Integrations page for a code.
    expect(reply.text).toContain('Open Integrations at http://web.test/integrations ');
    expect(reply.text).not.toContain('Settings');
    expect(vmFake.deliveries).toHaveLength(0);
    expect(await db().select().from(messages).where(eq(messages.text, 'hello there'))).toHaveLength(
      0,
    );
  });

  it('a wrong code is refused', async () => {
    const chatId = chat();
    await sendTelegram(telegramUpdate(chatId, 'LINK-AAAA-BBBB'));
    const reply = await waitFor(async () => tg.sent.find((m) => m.chatId === String(chatId)));
    expect(reply.text).toContain('invalid or expired');
  });

  it('links with a code, then the user chats with their own agent', async () => {
    const user = await chatUser();
    const chatId = chat();
    const lc = await linkTelegram(user.token, chatId);
    expect(lc.deepLink).toContain('t.me/agent_bot');

    const channels = await expectContract<{ items: Array<{ channel: string; displayId: string }> }>(
      'listChannels',
      await call('/v1/channels', { token: user.token }),
      200,
    );
    expect(channels.items).toHaveLength(1);
    expect(channels.items[0]!.channel).toBe('telegram');

    // The code is single use.
    const other = chat();
    await sendTelegram(telegramUpdate(other, lc.code));
    expect(
      (await waitFor(async () => tg.sent.find((m) => m.chatId === String(other)))).text,
    ).toContain('invalid or expired');

    await sendTelegram(telegramUpdate(chatId, 'what is on my calendar?'));
    const reply = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('echo:')),
    );
    expect(reply.text).toBe('echo: what is on my calendar?');
    expect(vmFake.deliveries).toHaveLength(1);
    expect(vmFake.deliveries[0]).toMatchObject({
      userId: user.id,
      sessionKey: `telegram:${chatId}`,
    });
    expect(vmFake.created).toContain(user.id);

    const history = await expectContract<{
      items: Array<{ direction: string; text: string; status: string }>;
    }>('listMessages', await call('/v1/messages', { token: user.token }), 200);
    const texts = history.items.map((m) => `${m.direction}:${m.text}`);
    expect(texts).toContain('in:what is on my calendar?');
    expect(texts).toContain('out:echo: what is on my calendar?');
    await waitFor(async () => {
      const rows = await db().select().from(messages).where(eq(messages.userId, user.id));
      return (
        rows.find((r) => r.direction === 'in' && r.text === 'what is on my calendar?')?.status ===
        'delivered'
      );
    });

    const activity = await expectContract<{ items: Array<{ action: string }> }>(
      'listActivity',
      await call('/v1/activity', { token: user.token }),
      200,
    );
    expect(activity.items.map((a) => a.action)).toEqual(
      expect.arrayContaining(['send_message', 'channel_linked']),
    );
  });

  it('a duplicate Telegram update is processed once', async () => {
    const user = await chatUser();
    const chatId = chat();
    await linkTelegram(user.token, chatId);
    const update = telegramUpdate(chatId, 'only once');
    await sendTelegram(update);
    await sendTelegram(update);
    await waitFor(async () => tg.sent.find((m) => m.text === 'echo: only once'));
    await new Promise((r) => setTimeout(r, 300));
    expect(tg.sent.filter((m) => m.text === 'echo: only once')).toHaveLength(1);
    expect(
      await db()
        .select()
        .from(events)
        .where(eq(events.externalId, String(update.update_id))),
    ).toHaveLength(1);
  });

  it("two users' agents never see each other's data", async () => {
    const alice = await chatUser({ name: 'Alice' } as never);
    const bob = await chatUser();
    const aliceChat = chat();
    const bobChat = chat();
    await linkTelegram(alice.token, aliceChat);
    await linkTelegram(bob.token, bobChat);
    await sendTelegram(telegramUpdate(aliceChat, 'hi from alice'));
    await waitFor(async () => tg.sent.find((m) => m.text === 'echo: hi from alice'));

    const aliceToken = vmFake.tokens.get(alice.id)!;
    const profile = await mcpCall(aliceToken, 'get_profile', {});
    expect(JSON.parse(profile.text)).toMatchObject({ plan: 'free' });

    // Alice's container can't message Bob's chat, even by naming it…
    const cross = await mcpCall(aliceToken, 'send_message', {
      text: 'hijack',
      session_key: `telegram:${bobChat}`,
    });
    expect(cross.isError).toBe(true);
    // …nor by sending a user id (ignored: the id comes from the token).
    const spoof = await mcpCall(aliceToken, 'send_message', {
      text: 'spoof',
      user_id: bob.id,
      userId: bob.id,
    });
    expect(spoof.isError).toBeFalsy();
    await waitFor(async () => tg.sent.find((m) => m.text === 'spoof'));
    expect(tg.sent.find((m) => m.text === 'spoof')!.chatId).toBe(String(aliceChat));
    expect(tg.sent.find((m) => m.text === 'hijack')).toBeUndefined();
    const bobRows = await db().select().from(messages).where(eq(messages.userId, bob.id));
    expect(bobRows.find((r) => r.text === 'spoof' || r.text === 'hijack')).toBeUndefined();

    // Deliveries only ever carry the sender's own user id.
    for (const d of vmFake.deliveries) {
      if (d.sessionKey === `telegram:${aliceChat}`) expect(d.userId).toBe(alice.id);
      if (d.sessionKey === `telegram:${bobChat}`) expect(d.userId).toBe(bob.id);
    }
  });

  it('/mcp rejects a missing or unknown token', async () => {
    expect((await mcpCall('nope', 'get_profile', {})).isError).toBe(true);
    const res = await call('/mcp', { method: 'POST', body: {} });
    expect(res.status).toBe(401);
  });

  it('unlink removes the link, records it in the activity log; the chat then gets the link message again', async () => {
    const user = await chatUser();
    const chatId = chat();
    await linkTelegram(user.token, chatId);
    const [link] = await db().select().from(channelLinks).where(eq(channelLinks.userId, user.id));
    await expectContract(
      'unlinkChannel',
      await call(`/v1/channels/${link!.id}`, { method: 'DELETE', token: user.token }),
      204,
    );
    await expectContract(
      'unlinkChannel',
      await call(`/v1/channels/${link!.id}`, { method: 'DELETE', token: user.token }),
      404,
    );
    // The activity log records it like the link: the same name, never the chat id.
    const activity = await expectContract<{
      items: Array<{ actor: string; action: string; summary: string }>;
    }>('listActivity', await call('/v1/activity', { token: user.token }), 200);
    const linked = activity.items.filter((a) => a.action === 'channel_linked');
    const unlinked = activity.items.filter((a) => a.action === 'channel_unlinked');
    expect(linked).toHaveLength(1);
    expect(unlinked).toEqual([
      expect.objectContaining({ actor: 'user', summary: 'Unlinked telegram @someone' }),
    ]);
    expect(linked[0]!.summary).toBe('Linked telegram @someone');
    expect(JSON.stringify(unlinked)).not.toContain(String(chatId));
    await sendTelegram(telegramUpdate(chatId, 'still there?'));
    await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.text.includes("isn't linked")),
    );
  });

  it('a code of the same account from a linked chat: one true reply, the code is kept, the event is done', async () => {
    const user = await chatUser();
    const chatId = chat();
    await linkTelegram(user.token, chatId);
    const lc = await newCode(user.token);
    const update = telegramUpdate(chatId, lc.code);
    await sendTelegram(update);
    const reply = await waitFor(async () => repliesTo(chatId)[0]);
    expect(reply.text).toBe('This chat is already linked to your account.');
    const event = await waitFor(async () => {
      const [row] = await db()
        .select()
        .from(events)
        .where(eq(events.externalId, String(update.update_id)));
      return row?.status === 'done' ? row : undefined;
    });
    expect(await codeUnused(lc.code)).toBe(true);

    // The job run again (a worker restart in the middle of it): no second reply.
    await handleProcessMessage({ data: { eventId: event.id } } as Job);
    await new Promise((r) => setTimeout(r, 300));
    expect(repliesTo(chatId)).toHaveLength(1);

    // The bot's deep link sends `/start <code>`: the same reply, and the agent never sees it.
    await sendTelegram(telegramUpdate(chatId, `/start ${lc.code}`));
    await waitFor(async () => repliesTo(chatId).length === 2);
    expect(repliesTo(chatId)[1]!.text).toBe('This chat is already linked to your account.');
    expect(vmFake.deliveries).toHaveLength(0);
  });

  it('a code of another account from a linked chat: says so, tells nothing of that account, and keeps the code', async () => {
    const owner = await chatUser();
    const other = await chatUser();
    const chatId = chat();
    await linkTelegram(owner.token, chatId);
    const lc = await newCode(other.token);
    await sendTelegram(telegramUpdate(chatId, lc.code));
    const reply = await waitFor(async () => repliesTo(chatId)[0]);
    expect(reply.text).toContain('This chat is linked to another Textcrew account');
    expect(reply.text).toContain('sign in to that account at http://web.test/integrations ');
    expect(reply.text).toContain('unlink the chat in Integrations');
    expect(reply.text).not.toContain('Settings');
    expect(reply.text).not.toContain('your account');
    for (const secret of [owner.id, owner.email, other.id, other.email])
      expect(reply.text).not.toContain(secret);
    expect(vmFake.deliveries).toHaveLength(0);

    // The chat stays with its account, and the code is not used up…
    const [link] = await db()
      .select()
      .from(channelLinks)
      .where(eq(channelLinks.externalId, String(chatId)));
    expect(link!.userId).toBe(owner.id);
    expect(await codeUnused(lc.code)).toBe(true);
    // …so once the chat is unlinked there, the same code links it to the other account.
    await call(`/v1/channels/${link!.id}`, { method: 'DELETE', token: owner.token });
    await sendTelegram(telegramUpdate(chatId, lc.code));
    await waitFor(
      async () =>
        tg.sent.filter((m) => m.chatId === String(chatId) && m.text.startsWith('✅ Linked'))
          .length === 2,
    );
    const [moved] = await db()
      .select()
      .from(channelLinks)
      .where(eq(channelLinks.externalId, String(chatId)));
    expect(moved!.userId).toBe(other.id);
  });

  it('codes sent from a linked chat count against the 10 tries an hour', async () => {
    const owner = await chatUser();
    const other = await chatUser();
    const chatId = chat();
    await linkTelegram(owner.token, chatId); // the first of the 10 tries
    for (let i = 1; i <= 9; i++) {
      await sendTelegram(telegramUpdate(chatId, 'LINK-AAAA-BBBB'));
      await waitFor(async () => repliesTo(chatId).length === i);
    }
    // The 11th is refused before the code is looked at, even a valid one.
    await sendTelegram(telegramUpdate(chatId, (await newCode(other.token)).code));
    await waitFor(async () => repliesTo(chatId).length === 10);
    expect(repliesTo(chatId)[9]!.text).toContain('Too many attempts');
    expect(repliesTo(chatId).some((m) => m.text.includes('another Textcrew account'))).toBe(false);
  });

  it('a user blocking the bot marks the link blocked', async () => {
    const user = await chatUser();
    const chatId = chat();
    await linkTelegram(user.token, chatId);
    const { setTelegramApi } = await import('../src/modules/channels/adapters/telegram.ts');
    const { RecipientBlockedError } = await import('../src/modules/channels/types.ts');
    setTelegramApi(async () => {
      throw new RecipientBlockedError('Forbidden: bot was blocked by the user');
    });
    await sendTelegram(telegramUpdate(chatId, 'are you there'));
    await waitFor(
      async () =>
        (await db().select().from(channelLinks).where(eq(channelLinks.userId, user.id)))[0]
          ?.blocked,
    );
  });
});
