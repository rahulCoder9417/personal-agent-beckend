// The channels switch (HLD 0.3, launch plan D2 + D3): ENABLED_CHANNELS says which channels are on.
// Default: Telegram and the web app. A channel that is off can't be linked, its webhook does no
// work, the worker neither reads from it nor sends to it, and the api tells clients what is on.
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { handleSendMessage, queueOutbound } from '../src/modules/channels/outbound.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { ingestEvent } from '../src/modules/events/intake.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { events } from '../src/modules/events/schema.ts';
import { handleProcessMessage } from '../src/modules/orchestrator/process-message.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { IGNORED } from '../src/worker/ignored.ts';
import {
  imessageNumber,
  installFakeSendblue,
  installFakeWhatsapp,
  phone,
  sbInbound,
  waText,
  waWebhook,
} from './fakes-channels.ts';
import { installFakeTelegram, installFakeVm, mcpCall, telegramUpdate } from './fakes.ts';
import { call, chatUser, expectContract } from './helpers.ts';

function setChannels(list?: string) {
  if (list === undefined) delete process.env.ENABLED_CHANNELS;
  else process.env.ENABLED_CHANNELS = list;
  resetConfig();
}

beforeAll(() => wireModules());
afterEach(() => setChannels());
afterAll(async () => {
  await closeQueues();
});

const eventsFrom = (source: string) => db().select().from(events).where(eq(events.source, source));

interface ErrorBody {
  error: { code: string; message: string; details?: { channel?: string } };
}

describe('channels switch: what the api tells clients', () => {
  it('GET /v1/channels lists the channels that are on (default: telegram + web)', async () => {
    const u = await chatUser();
    const body = await expectContract<{ items: unknown[]; available: string[] }>(
      'listChannels',
      await call('/v1/channels', { token: u.token }),
      200,
    );
    expect(body.items).toEqual([]);
    expect(body.available).toEqual(['telegram', 'web']);

    setChannels('telegram,web,whatsapp');
    const more = await expectContract<{ available: string[] }>(
      'listChannels',
      await call('/v1/channels', { token: u.token }),
      200,
    );
    expect(more.available).toEqual(['telegram', 'web', 'whatsapp']);
  });
});

describe('channels switch: a channel that is off', () => {
  it("can't be linked: 403 channel_disabled, and the rate limit isn't used up", async () => {
    const u = await chatUser();
    for (const channel of ['whatsapp', 'imessage']) {
      const res = await expectContract<ErrorBody>(
        'createLinkCode',
        await call('/v1/channels/link-codes', {
          method: 'POST',
          token: u.token,
          body: { channel },
        }),
        403,
      );
      expect(res.error.code).toBe('channel_disabled');
      expect(res.error.details?.channel).toBe(channel);
    }
    // 12 refused attempts (the limit is 10 an hour) and Telegram still gets its code.
    for (let i = 0; i < 12; i++)
      await call('/v1/channels/link-codes', {
        method: 'POST',
        token: u.token,
        body: { channel: 'whatsapp' },
      });
    await expectContract(
      'createLinkCode',
      await call('/v1/channels/link-codes', {
        method: 'POST',
        token: u.token,
        body: { channel: 'telegram' },
      }),
      201,
    );
  });

  it('WhatsApp webhook: 200 with nothing saved, even unsigned; the handshake answers 403', async () => {
    const res = await call('/webhooks/whatsapp', {
      method: 'POST',
      body: waWebhook([waText(phone(), 'hello')]),
    });
    await expectContract('webhookWhatsapp', res, 200);
    expect(await eventsFrom('whatsapp')).toHaveLength(0);
    expect(await queue('inbound').getJobCounts()).toMatchObject({ waiting: 0, delayed: 0 });

    const handshake = await call(
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=42',
    );
    expect(handshake.status).toBe(403);
  });

  it('Sendblue (iMessage) webhook: 200 with nothing saved', async () => {
    const res = await call('/webhooks/sendblue', {
      method: 'POST',
      body: sbInbound(imessageNumber(), 'hello'),
    });
    await expectContract('webhookSendblue', res, 200);
    expect(await eventsFrom('sendblue')).toHaveLength(0);
  });

  it('Telegram can be switched off too: webhook does nothing, no link code', async () => {
    setChannels('web');
    const u = await chatUser();
    const res = await call('/webhooks/telegram', {
      method: 'POST',
      body: telegramUpdate(777001, 'hello'),
      headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
    });
    await expectContract('webhookTelegram', res, 200);
    expect(await eventsFrom('telegram')).toHaveLength(0);
    const refused = await expectContract<ErrorBody>(
      'createLinkCode',
      await call('/v1/channels/link-codes', {
        method: 'POST',
        token: u.token,
        body: { channel: 'telegram' },
      }),
      403,
    );
    expect(refused.error.code).toBe('channel_disabled');

    // Back on (the default): the same webhook saves the event again.
    setChannels();
    await call('/webhooks/telegram', {
      method: 'POST',
      body: telegramUpdate(777001, 'hello'),
      headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
    });
    expect(await eventsFrom('telegram')).toHaveLength(1);
  });

  it('web chat off: POST /v1/messages answers 403 channel_disabled', async () => {
    setChannels('telegram');
    const u = await chatUser();
    const res = await expectContract<ErrorBody>(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: u.token,
        body: { text: 'hi', clientMessageId: crypto.randomUUID() },
      }),
      403,
    );
    expect(res.error.code).toBe('channel_disabled');
    expect(res.error.details?.channel).toBe('web');
  });
});

describe('channels switch: the worker', () => {
  it('never sends to a channel that is off: the message is marked failed', async () => {
    const wa = installFakeWhatsapp();
    const u = await chatUser();
    const number = phone();
    const row = await queueOutbound({ userId: u.id, sessionKey: `whatsapp:${number}`, text: 'hi' });
    const job = {
      data: { messageId: row.id, buttons: null, template: null },
      attemptsMade: 0,
      opts: {},
    } as unknown as Job;

    await handleSendMessage(job);
    expect(wa.sent).toHaveLength(0);
    const [after] = await db().select().from(messages).where(eq(messages.id, row.id));
    expect(after!.status).toBe('failed');
  });

  it('sends as before once the channel is on', async () => {
    setChannels('telegram,web,whatsapp');
    const wa = installFakeWhatsapp();
    const u = await chatUser();
    const number = phone();
    const row = await queueOutbound({ userId: u.id, sessionKey: `whatsapp:${number}`, text: 'hi' });
    await handleSendMessage({
      data: { messageId: row.id, buttons: null, template: null },
      attemptsMade: 0,
      opts: {},
    } as unknown as Job);
    expect(wa.sent.map((m) => m.to)).toEqual([number]);
  });

  it('ignores a message queued before its channel was switched off (no reply either)', async () => {
    const sb = installFakeSendblue();
    const { eventId } = await ingestEvent({
      source: 'sendblue',
      externalId: `sb-${crypto.randomUUID()}`,
      type: 'message',
      payload: sbInbound(imessageNumber(), 'hello') as unknown as Record<string, unknown>,
      queue: 'inbound',
      jobName: 'process-message',
    });
    const job = { data: { eventId } } as unknown as Job;

    expect(await handleProcessMessage(job)).toBe(IGNORED);
    expect(await queue('outbound').getJob(`raw-${eventId}`)).toBeUndefined();
    expect(sb.sent).toHaveLength(0);

    // With iMessage on, the same event gets the "please link" reply queued.
    setChannels('telegram,web,imessage');
    await handleProcessMessage(job);
    expect(await queue('outbound').getJob(`raw-${eventId}`)).toBeDefined();
  });

  it("the agent can't message a chat on a channel that is off", async () => {
    const vm = installFakeVm();
    installFakeTelegram();
    const u = await chatUser();
    const { ensureSandbox } = await import('../src/modules/orchestrator/sandbox.ts');
    await ensureSandbox(u.id);
    const res = await mcpCall(vm.tokens.get(u.id)!, 'send_message', {
      text: 'hi',
      session_key: 'whatsapp:15550001234',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('switched off');
  });
});
