import { and, eq } from 'drizzle-orm';
import type { Worker } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { SendblueApiError } from '../src/modules/channels/adapters/sendblue.ts';
import { queueOutbound } from '../src/modules/channels/outbound.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { buttonsAsText, textAsButtonReply } from '../src/modules/channels/text-buttons.ts';
import { events } from '../src/modules/events/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { setInboundHooks } from '../src/modules/orchestrator/process-message.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  imessageNumber,
  installFakeSendblue,
  linkImessage,
  postSendblue,
  sbInbound,
  useChannelEnv,
} from './fakes-channels.ts';
import { installFakeVm } from './fakes.ts';
import { call, createUser, expectContract, waitFor } from './helpers.ts';

useChannelEnv();

let workers: Worker[];
let vmFake: ReturnType<typeof installFakeVm>;
let sb: ReturnType<typeof installFakeSendblue>;

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
  sb = installFakeSendblue();
});

async function linkedUser() {
  const user = await createUser();
  const number = imessageNumber();
  await linkImessage(user.token, number, sb);
  return { user, number, sessionKey: `imessage:${number}` };
}

describe('Phase 6: yes/no text answers', () => {
  it('recognises yes / no / ✅ / ❌ and nothing else', () => {
    for (const t of ['yes', 'YES', 'Yes!', ' y ', 'ok', 'approve', '✅', '👍'])
      expect(textAsButtonReply(t), t).toBe('yes');
    for (const t of ['no', 'No.', 'NOPE', 'reject', '❌', '👎'])
      expect(textAsButtonReply(t), t).toBe('no');
    for (const t of ['', 'yes please send it to bob', 'maybe', 'stop', 'LINK-ABCD-EFGH'])
      expect(textAsButtonReply(t), t).toBeNull();
  });

  it('renders approval buttons as a yes/no line and other buttons as a list', () => {
    expect(
      buttonsAsText([
        { id: 'apr:1:yes', title: '✅ Approve' },
        { id: 'apr:1:no', title: '❌ Reject' },
      ]),
    ).toBe('Reply YES to approve or NO to reject.');
    expect(
      buttonsAsText([
        { id: 'a', title: 'Morning' },
        { id: 'b', title: 'Evening' },
      ]),
    ).toBe('Reply with one of: Morning, Evening');
    expect(buttonsAsText(undefined)).toBe('');
  });
});

describe('Phase 6: iMessage via Sendblue', () => {
  it('rejects a wrong or missing signing secret', async () => {
    const number = imessageNumber();
    await expectContract(
      'webhookSendblue',
      await postSendblue(sbInbound(number, 'hi'), 'nope'),
      401,
    );
    await expectContract(
      'webhookSendblue',
      await call('/webhooks/sendblue', { method: 'POST', body: sbInbound(number, 'hi') }),
      401,
    );
  });

  it('an unlinked number only gets the link message', async () => {
    const number = imessageNumber();
    await expectContract('webhookSendblue', await postSendblue(sbInbound(number, 'hey')), 200);
    const reply = await waitFor(async () => sb.sent.find((m) => m.number === number));
    expect(reply.content).toContain("isn't linked");
    expect(vmFake.deliveries).toHaveLength(0);
  });

  it('links with a code, then the user chats with their own agent', async () => {
    const user = await createUser();
    const number = imessageNumber();
    const lc = await linkImessage(user.token, number, sb);
    expect(lc.deepLink).toContain('sms:+15550002222');
    await postSendblue(sbInbound(number, 'book a table for two'));
    const reply = await waitFor(async () =>
      sb.sent.find((m) => m.number === number && m.content === 'echo: book a table for two'),
    );
    expect(reply.fromNumber).toBe('+15550002222');
    expect(vmFake.deliveries).toHaveLength(1);
    expect(vmFake.deliveries[0]).toMatchObject({
      userId: user.id,
      sessionKey: `imessage:${number}`,
    });
  });

  it('a duplicate webhook is processed once; group chats are ignored', async () => {
    const { number } = await linkedUser();
    const msg = sbInbound(number, 'just once');
    await postSendblue(msg);
    await postSendblue(msg);
    await waitFor(async () => sb.sent.find((m) => m.content === 'echo: just once'));
    await new Promise((r) => setTimeout(r, 300));
    expect(sb.sent.filter((m) => m.content === 'echo: just once')).toHaveLength(1);
    expect(
      await db().select().from(events).where(eq(events.externalId, msg.message_handle)),
    ).toHaveLength(1);

    const group = sbInbound(number, 'group hello', { group_id: 'grp-1' });
    await expectContract('webhookSendblue', await postSendblue(group), 200);
    expect(
      await db().select().from(events).where(eq(events.externalId, group.message_handle)),
    ).toHaveLength(0);
  });

  it('buttons become a "Reply YES/NO" line and a plain "yes" reaches the approval hook', async () => {
    const answers: Array<'yes' | 'no'> = [];
    setInboundHooks({
      handleButton: async (_userId, m) => {
        const a = m.buttonReply ? null : textAsButtonReply(m.text);
        if (!a) return false;
        answers.push(a);
        return true;
      },
    });
    try {
      const { user, number, sessionKey } = await linkedUser();
      await queueOutbound({
        userId: user.id,
        sessionKey,
        text: 'Send the email to Bob?',
        buttons: [
          { id: 'apr:7:yes', title: '✅ Approve' },
          { id: 'apr:7:no', title: '❌ Reject' },
        ],
      });
      const asked = await waitFor(async () =>
        sb.sent.find((m) => m.number === number && m.content.startsWith('Send the email')),
      );
      expect(asked.content).toBe('Send the email to Bob?\n\nReply YES to approve or NO to reject.');

      await postSendblue(sbInbound(number, 'Yes'));
      await waitFor(async () => answers.length === 1);
      expect(answers).toEqual(['yes']);
      expect(vmFake.deliveries).toHaveLength(0);
    } finally {
      setInboundHooks({ handleButton: async () => false });
    }
  });

  it('outbound status events update the message status', async () => {
    const { user, number, sessionKey } = await linkedUser();
    const msg = await queueOutbound({ userId: user.id, sessionKey, text: 'status check' });
    const out = await waitFor(async () =>
      sb.sent.find((m) => m.number === number && m.content === 'status check'),
    );
    await waitFor(async () => {
      const [r] = await db().select().from(messages).where(eq(messages.id, msg.id));
      return r?.externalId === out.handle;
    });
    await expectContract(
      'webhookSendblue',
      await postSendblue({
        ...sbInbound(number, 'status check'),
        is_outbound: true,
        status: 'DELIVERED',
        message_handle: out.handle,
      }),
      200,
    );
    await waitFor(async () => {
      const [r] = await db()
        .select()
        .from(messages)
        .where(and(eq(messages.id, msg.id), eq(messages.userId, user.id)));
      return r?.status === 'delivered';
    });
    expect(vmFake.deliveries).toHaveLength(0);
  });

  it('an opted-out number marks the chat blocked', async () => {
    const { user, number, sessionKey } = await linkedUser();
    sb.state.onSend = (body) => {
      if (body.number === number) throw new SendblueApiError('opted out', 400, true);
    };
    await queueOutbound({ userId: user.id, sessionKey, text: 'hello?' });
    await waitFor(
      async () =>
        (await db().select().from(channelLinks).where(eq(channelLinks.userId, user.id)))[0]
          ?.blocked,
    );
  });
});
