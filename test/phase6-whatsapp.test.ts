import { and, eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { responseValidator } from '../src/api/openapi/spec.ts';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { WhatsappApiError } from '../src/modules/channels/adapters/whatsapp.ts';
import { queueOutbound } from '../src/modules/channels/outbound.ts';
import { messages } from '../src/modules/channels/schema.ts';
import type { InboundMessage } from '../src/modules/channels/types.ts';
import { events } from '../src/modules/events/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { setInboundHooks } from '../src/modules/orchestrator/process-message.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  installFakeWhatsapp,
  linkWhatsapp,
  phone,
  postWhatsapp,
  useChannelEnv,
  WA_VERIFY,
  waMessage,
  waStatus,
  waText,
  waWebhook,
} from './fakes-channels.ts';
import { installFakeVm } from './fakes.ts';
import { call, createUser, expectContract, waitFor } from './helpers.ts';

useChannelEnv();

let workers: Worker[];
let vmFake: ReturnType<typeof installFakeVm>;
let wa: ReturnType<typeof installFakeWhatsapp>;

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
  wa = installFakeWhatsapp();
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);

async function setLastInbound(userId: string, at: Date) {
  await db()
    .update(channelLinks)
    .set({ lastInboundAt: at })
    .where(and(eq(channelLinks.userId, userId), eq(channelLinks.channel, 'whatsapp')));
}

async function linkedUser() {
  const user = await createUser();
  const number = phone();
  await linkWhatsapp(user.token, number, wa);
  return { user, number, sessionKey: `whatsapp:${number}` };
}

describe('Phase 6: WhatsApp webhook', () => {
  it('answers the verify handshake with the challenge as text/plain', async () => {
    const res = await call(
      `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${WA_VERIFY}&hub.challenge=1158201444`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toBe('1158201444');
    expect(responseValidator('webhookWhatsappVerify', 200)!(text)).toBe(true);
  });

  it('refuses the handshake with a wrong token or mode', async () => {
    await expectContract(
      'webhookWhatsappVerify',
      await call('/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1'),
      403,
    );
    await expectContract(
      'webhookWhatsappVerify',
      await call(
        `/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=${WA_VERIFY}&hub.challenge=1`,
      ),
      403,
    );
  });

  it('rejects a bad or missing signature before reading the body', async () => {
    const number = phone();
    await expectContract(
      'webhookWhatsapp',
      await postWhatsapp(waWebhook([waText(number, 'hi')]), 'wrong-secret'),
      401,
    );
    await expectContract(
      'webhookWhatsapp',
      await call('/webhooks/whatsapp', { method: 'POST', body: waWebhook([waText(number, 'hi')]) }),
      401,
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(wa.sent.filter((m) => m.to === number)).toHaveLength(0);
  });

  it('an unlinked number only gets the link message; nothing reaches an agent', async () => {
    const number = phone();
    await expectContract(
      'webhookWhatsapp',
      await postWhatsapp(waWebhook([waText(number, 'hello from whatsapp')])),
      200,
    );
    const reply = await waitFor(async () => wa.sent.find((m) => m.to === number));
    expect(reply.type).toBe('text');
    expect(reply.text).toContain("isn't linked");
    expect(vmFake.deliveries).toHaveLength(0);
    expect(
      await db().select().from(messages).where(eq(messages.text, 'hello from whatsapp')),
    ).toHaveLength(0);
  });

  it('links with a code, then the user chats with their own agent', async () => {
    const user = await createUser();
    const number = phone();
    const lc = await linkWhatsapp(user.token, number, wa);
    expect(lc.deepLink).toContain('wa.me/15550001111');

    const channels = await expectContract<{ items: Array<{ channel: string; displayId: string }> }>(
      'listChannels',
      await call('/v1/channels', { token: user.token }),
      200,
    );
    expect(channels.items.map((c) => c.channel)).toEqual(['whatsapp']);
    expect(channels.items[0]!.displayId).not.toContain(number); // masked

    await postWhatsapp(waWebhook([waText(number, 'plan my week')]));
    const reply = await waitFor(async () =>
      wa.sent.find((m) => m.to === number && m.text === 'echo: plan my week'),
    );
    expect(reply.type).toBe('text');
    expect(vmFake.deliveries).toHaveLength(1);
    expect(vmFake.deliveries[0]).toMatchObject({
      userId: user.id,
      sessionKey: `whatsapp:${number}`,
      text: 'plan my week',
    });
    const [link] = await db().select().from(channelLinks).where(eq(channelLinks.userId, user.id));
    expect(Date.now() - link!.lastInboundAt!.getTime()).toBeLessThan(60_000);
  });

  it('one webhook with several messages makes one event and one turn per message', async () => {
    const { number } = await linkedUser();
    const a = waText(number, 'first');
    const b = waText(number, 'second');
    await postWhatsapp(waWebhook([a, b]));
    await waitFor(async () => wa.sent.find((m) => m.text === 'echo: second'));
    await waitFor(async () => wa.sent.find((m) => m.text === 'echo: first'));
    const rows = await db().select().from(events).where(eq(events.source, 'whatsapp'));
    expect(rows.filter((r) => r.externalId === a.id || r.externalId === b.id)).toHaveLength(2);
  });

  it('a duplicate delivery of the same message is processed once', async () => {
    const { number } = await linkedUser();
    const msg = waText(number, 'only once please');
    await postWhatsapp(waWebhook([msg]));
    await postWhatsapp(waWebhook([msg]));
    await waitFor(async () => wa.sent.find((m) => m.text === 'echo: only once please'));
    await new Promise((r) => setTimeout(r, 300));
    expect(wa.sent.filter((m) => m.text === 'echo: only once please')).toHaveLength(1);
    expect(await db().select().from(events).where(eq(events.externalId, msg.id))).toHaveLength(1);
  });

  it('status updates only move the message status forward and never start a turn', async () => {
    const { user, number } = await linkedUser();
    await postWhatsapp(waWebhook([waText(number, 'status please')]));
    const out = await waitFor(async () =>
      wa.sent.find((m) => m.to === number && m.text === 'echo: status please'),
    );
    const row = await waitFor(async () => {
      const [r] = await db()
        .select()
        .from(messages)
        .where(and(eq(messages.userId, user.id), eq(messages.externalId, out.id)));
      return r?.status === 'sent' ? r : undefined;
    });
    const deliveriesBefore = vmFake.deliveries.length;

    await expectContract(
      'webhookWhatsapp',
      await postWhatsapp(waWebhook([], [waStatus(out.id, 'delivered'), waStatus(out.id, 'read')])),
      200,
    );
    const statusOf = async () =>
      (await db().select().from(messages).where(eq(messages.id, row.id)))[0]!.status;
    await waitFor(async () => (await statusOf()) === 'read');
    // A late "sent" receipt doesn't move it back.
    await postWhatsapp(waWebhook([], [waStatus(out.id, 'sent')]));
    await new Promise((r) => setTimeout(r, 300));
    expect(await statusOf()).toBe('read');
    expect(vmFake.deliveries.length).toBe(deliveriesBefore);
  });

  it('a failed receipt for an undeliverable number marks the chat blocked', async () => {
    const { user, number, sessionKey } = await linkedUser();
    const msg = await queueOutbound({ userId: user.id, sessionKey, text: 'ping' });
    const out = await waitFor(async () =>
      wa.sent.find((m) => m.to === number && m.text === 'ping'),
    );
    await waitFor(async () => {
      const [r] = await db().select().from(messages).where(eq(messages.id, msg.id));
      return r?.externalId === out.id;
    });
    await postWhatsapp(waWebhook([], [waStatus(out.id, 'failed', [{ code: 131026 }])]));
    await waitFor(
      async () =>
        (await db().select().from(channelLinks).where(eq(channelLinks.userId, user.id)))[0]
          ?.blocked,
    );
    expect((await db().select().from(messages).where(eq(messages.id, msg.id)))[0]!.status).toBe(
      'failed',
    );
  });

  it('a tapped reply button reaches the button hook (not the agent)', async () => {
    const taps: InboundMessage[] = [];
    setInboundHooks({
      handleButton: async (_userId, m) => {
        if (!m.buttonReply) return false;
        taps.push(m);
        return true;
      },
    });
    try {
      const { number } = await linkedUser();
      await postWhatsapp(
        waWebhook([
          waMessage(number, {
            type: 'interactive',
            interactive: {
              type: 'button_reply',
              button_reply: { id: 'apr:1:yes', title: 'Approve' },
            },
          }),
          waMessage(number, { type: 'button', button: { payload: 'apr:2:no', text: 'Reject' } }),
        ]),
      );
      await waitFor(async () => taps.length === 2);
      expect(taps.map((t) => t.buttonReply!.data).sort()).toEqual(['apr:1:yes', 'apr:2:no']);
      expect(vmFake.deliveries).toHaveLength(0);
    } finally {
      setInboundHooks({ handleButton: async () => false });
    }
  });
});

describe('Phase 6: WhatsApp sending and the 24-hour rule', () => {
  it('a reminder 25 hours after the last message goes out as the approved template', async () => {
    const { user, number, sessionKey } = await linkedUser();
    await setLastInbound(user.id, hoursAgo(25));
    await queueOutbound({
      userId: user.id,
      sessionKey,
      text: 'Reminder: call mom\n\nShe asked about Sunday.',
      template: 'reminder',
    });
    const sent = await waitFor(async () => wa.sent.find((m) => m.to === number && m.template));
    expect(sent.type).toBe('template');
    expect(sent.template).toMatchObject({ name: 'reminder', lang: 'en' });
    expect(sent.template!.params).toEqual(['Reminder: call mom · She asked about Sunday.']);
    expect(wa.sent.find((m) => m.to === number && m.text?.startsWith('Reminder'))).toBeUndefined();
  });

  it('within 24 hours the same reminder is free text', async () => {
    const { user, number, sessionKey } = await linkedUser();
    await setLastInbound(user.id, hoursAgo(23));
    await queueOutbound({
      userId: user.id,
      sessionKey,
      text: 'Reminder: stretch',
      template: 'reminder',
    });
    const sent = await waitFor(async () =>
      wa.sent.find((m) => m.to === number && m.text === 'Reminder: stretch'),
    );
    expect(sent.type).toBe('text');
  });

  it('within 24 hours buttons are reply buttons (max 3); after 24 hours the approval template carries them', async () => {
    const { user, number, sessionKey } = await linkedUser();
    const buttons = [
      { id: 'apr:9:yes', title: '✅ Approve' },
      { id: 'apr:9:no', title: '❌ Reject' },
    ];
    await queueOutbound({ userId: user.id, sessionKey, text: 'Send the email?', buttons });
    const live = await waitFor(async () =>
      wa.sent.find((m) => m.to === number && m.type === 'interactive'),
    );
    expect(live.text).toBe('Send the email?');
    expect(live.buttons).toEqual(buttons);

    await setLastInbound(user.id, hoursAgo(30));
    await queueOutbound({ userId: user.id, sessionKey, text: 'Send the invoice?', buttons });
    const tpl = await waitFor(async () => wa.sent.find((m) => m.to === number && m.template));
    expect(tpl.template).toMatchObject({
      name: 'approval_needed',
      params: ['Send the invoice?'],
      payloads: ['apr:9:yes', 'apr:9:no'],
    });

    // Anything else outside the window uses the "task done" template.
    await queueOutbound({ userId: user.id, sessionKey, text: 'Your report is ready.' });
    await waitFor(async () =>
      wa.sent.find((m) => m.to === number && m.template?.name === 'task_done'),
    );
  });

  it('falls back to a template when WhatsApp says the window is closed (131047)', async () => {
    const { user, number, sessionKey } = await linkedUser();
    wa.state.onSend = (body) => {
      if (body.to === number && body.type === 'text')
        throw new WhatsappApiError('re-engagement', 131047, 400);
    };
    await queueOutbound({ userId: user.id, sessionKey, text: 'late reply' });
    const tpl = await waitFor(async () => wa.sent.find((m) => m.to === number && m.template));
    expect(tpl.template!.params).toEqual(['late reply']);
  });

  it('splits long replies at ~4096 characters', async () => {
    const { user, number, sessionKey } = await linkedUser();
    const long = Array.from({ length: 1100 }, (_, i) => `word${i}`).join(' ');
    expect(long.length).toBeGreaterThan(8192);
    await queueOutbound({ userId: user.id, sessionKey, text: long });
    await waitFor(
      async () => wa.sent.filter((m) => m.to === number && m.type === 'text').length >= 3,
    );
    await new Promise((r) => setTimeout(r, 200));
    const parts = wa.sent.filter(
      (m) => m.to === number && m.type === 'text' && !m.text!.startsWith('✅'),
    );
    expect(parts.length).toBe(3);
    for (const p of parts) expect(p.text!.length).toBeLessThanOrEqual(4096);
    expect(parts.map((p) => p.text).join(' ')).toBe(long);

    // With buttons, the last part fits the 1024-char interactive body.
    const buttons = [{ id: 'x:yes', title: 'Yes' }];
    await queueOutbound({ userId: user.id, sessionKey, text: long.slice(0, 3000), buttons });
    const withButtons = await waitFor(async () =>
      wa.sent.find((m) => m.to === number && m.type === 'interactive'),
    );
    expect(withButtons.text!.length).toBeLessThanOrEqual(1024);
  });

  it('an undeliverable number (131026) marks the chat blocked', async () => {
    const { user, number, sessionKey } = await linkedUser();
    wa.state.onSend = (body) => {
      if (body.to === number) throw new WhatsappApiError('undeliverable', 131026, 400);
    };
    const msg = await queueOutbound({ userId: user.id, sessionKey, text: 'are you there' });
    await waitFor(
      async () =>
        (await db().select().from(channelLinks).where(eq(channelLinks.userId, user.id)))[0]
          ?.blocked,
    );
    expect((await db().select().from(messages).where(eq(messages.id, msg.id)))[0]!.status).toBe(
      'failed',
    );
  });
});
