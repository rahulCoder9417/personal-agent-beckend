// An automation's runs reply in the conversation it was made in, else in a conversation of its
// own (web chat), never in whatever conversation the user has open.
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliverKind } from '../proto-gen/vm/v1/vm_pb.ts';
import { channelLinks } from '../src/modules/auth/schema.ts';
import {
  createAutomation,
  runConversation,
  setMinIntervalMs,
  type Automation,
} from '../src/modules/automations/automations.ts';
import { automations } from '../src/modules/automations/schema.ts';
import { activeConversation } from '../src/modules/channels/conversations.ts';
import { conversations, messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { startNewChat, startNewWebChat } from '../src/modules/orchestrator/chats.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakeTelegram, installFakeVm, type Delivery } from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[] = [];
let vm: ReturnType<typeof installFakeVm>;

const start = () => {
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50], busyDelayMs: 25 });
};
const stop = async () => {
  await Promise.all(workers.map((w) => w.close()));
  workers = [];
};

beforeAll(() => {
  wireModules();
  setMinIntervalMs(1000);
  start();
});
afterAll(async () => {
  await stop();
  await closeQueues();
});

/** The last line of a turn's text: what the user wrote (the platform's blocks come before it). */
const lastLine = (text: string) => text.split('\n').at(-1)!;

beforeEach(() => {
  installFakeTelegram();
  // The agent: "every morning …" makes a daily automation in the chat it came from; any other
  // message is answered "re: <it>"; an automation run answers "ran: <its title>".
  vm = installFakeVm(async (d, mcp) => {
    if (d.kind === DeliverKind.AUTOMATION || d.kind === DeliverKind.APP_EVENT) {
      const title = /\[Automation "([^"]+)"\]/.exec(d.text)?.[1];
      await mcp('send_message', { text: `ran: ${title}`, session_key: d.sessionKey });
      return;
    }
    const said = lastLine(d.text);
    if (said.startsWith('every morning')) {
      const r = await mcp('create_automation', {
        title: 'Morning PRs',
        instruction: 'Summarise my open pull requests and issues',
        cron: '0 9 * * *',
        timezone: 'Asia/Kolkata',
        session_key: d.sessionKey,
      });
      expect(r.isError, r.text).toBe(false);
    }
    await mcp('send_message', { text: `re: ${said}`, session_key: d.sessionKey });
  });
});

type TestUser = { id: string; token: string };

/** The user writes in web chat; returns once the agent's answer is saved. */
async function say(user: TestUser, text: string): Promise<{ conversationId: string }> {
  const sent = await expectContract<{ id: string; conversationId: string }>(
    'sendMessage',
    await call('/v1/messages', {
      method: 'POST',
      token: user.token,
      body: { text, clientMessageId: randomUUID() },
    }),
    202,
  );
  await waitFor(async () => {
    const [row] = await db().select().from(messages).where(eq(messages.id, sent.id));
    return row?.status === 'delivered';
  });
  return { conversationId: sent.conversationId };
}

const automationsOf = (userId: string) =>
  db().select().from(automations).where(eq(automations.userId, userId));

const conversationsOf = (userId: string) =>
  db()
    .select()
    .from(conversations)
    .where(eq(conversations.userId, userId))
    .orderBy(conversations.sessionKey, conversations.epoch);

const textsIn = async (userId: string, conversationId: string) =>
  (
    await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId)))
      .orderBy(messages.id)
  ).map((m) => m.text);

/** The saved answers of an automation's runs ("ran: <title>"). */
const runReplies = (userId: string, title: string) =>
  db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.text, `ran: ${title}`)))
    .orderBy(messages.id);

/** The timer fires now (a job like the scheduler's own). Waits until the run has answered. */
async function fire(a: Pick<Automation, 'id' | 'userId' | 'title'>, runsBefore = 0) {
  await queue('scheduled').add(
    'run-automation',
    { automationId: a.id, userId: a.userId },
    { jobId: `fire-${randomUUID()}` },
  );
  return waitFor(async () => {
    const rows = await runReplies(a.userId, a.title);
    return rows.length > runsBefore ? rows.at(-1) : undefined;
  });
}

const automationTurns = () => vm.deliveries.filter((d) => d.kind === DeliverKind.AUTOMATION);
const epochOf = (d: Delivery | undefined) =>
  (JSON.parse((d as unknown as { metadataJson: string }).metadataJson) as { chat_epoch: number })
    .chat_epoch;

describe('where an automation replies', () => {
  it('in the conversation the agent made it in, also after the user opened another', async () => {
    const user = await chatUser({ plan: 'pro' });
    const { conversationId: made } = await say(user, 'every morning at 9, summarise my PRs');
    const [a] = await automationsOf(user.id);
    expect(a!.conversationId).toBe(made);

    // The user starts a new chat and says hello there: that one is now the active one.
    const fresh = await startNewWebChat(user.id);
    await say(user, 'hlo');

    const reply = await fire(a!);
    expect(reply.conversationId).toBe(made);
    expect(await textsIn(user.id, fresh.id)).toEqual(['hlo', 're: hlo']);
    expect(await textsIn(user.id, made)).toEqual([
      'every morning at 9, summarise my PRs',
      're: every morning at 9, summarise my PRs',
      'ran: Morning PRs',
    ]);
    // The agent continued that conversation's own context, not the open one's.
    const [first] = await conversationsOf(user.id);
    expect(epochOf(automationTurns().find((d) => d.userId === user.id))).toBe(first!.epoch);
    expect((await activeConversation(user.id, 'web')).id).toBe(fresh.id);
  });

  it('its conversation deleted: a conversation of its own, titled after it, reused by later runs', async () => {
    const user = await chatUser({ plan: 'pro' });
    const { conversationId: made } = await say(user, 'every morning at 9, summarise my PRs');
    const [a] = await automationsOf(user.id);
    await expectContract(
      'deleteConversation',
      await call(`/v1/conversations/${made}`, { method: 'DELETE', token: user.token }),
      204,
    );
    const { conversationId: open } = await say(user, 'hlo');

    const one = await fire(a!);
    const two = await fire(a!, 1);
    expect(one.conversationId).not.toBe(open);
    expect(two.conversationId).toBe(one.conversationId);
    const own = (await conversationsOf(user.id)).find((c) => c.id === one.conversationId)!;
    expect(own).toMatchObject({ title: 'Morning PRs', active: false, sessionKey: 'web' });
    expect((await automationsOf(user.id))[0]!.conversationId).toBe(own.id);
    expect(await textsIn(user.id, own.id)).toEqual(['ran: Morning PRs', 'ran: Morning PRs']);
    expect(await textsIn(user.id, open)).toEqual(['hlo', 're: hlo']);
    // The open conversation stayed the active one, and both runs had the own one's context.
    expect((await activeConversation(user.id, 'web')).id).toBe(open);
    const turns = automationTurns().filter((d) => d.userId === user.id);
    expect(turns.map(epochOf)).toEqual([own.epoch, own.epoch]);
    expect(own.epoch).toBeGreaterThan((await activeConversation(user.id, 'web')).epoch);

    // That one deleted too: the next run starts another, with a number never used before.
    await call(`/v1/conversations/${own.id}`, { method: 'DELETE', token: user.token });
    const three = await fire(a!);
    expect(three.conversationId).not.toBe(own.id);
    const again = (await conversationsOf(user.id)).find((c) => c.id === three.conversationId)!;
    expect(again).toMatchObject({ title: 'Morning PRs', active: false });
    expect(again.epoch).toBeGreaterThan(own.epoch);
  });

  it('made without a conversation (from the web app, or before automations kept one): its own', async () => {
    const user = await chatUser({ plan: 'pro' });
    const { conversationId: open } = await say(user, 'hlo');
    const a = await createAutomation({
      userId: user.id,
      title: 'Every morning at 9, summarise my open pull requests and issues on GitHub please',
      instruction: 'Summarise',
      sessionKey: 'web',
      cron: '0 9 * * *',
    });
    expect(a.conversationId).toBeNull();
    const reply = await fire(a);
    expect(reply.conversationId).not.toBe(open);
    const own = (await conversationsOf(user.id)).find((c) => c.id === reply.conversationId)!;
    // A long title is cut at a word, like a title made from a message.
    expect(own).toMatchObject({
      title: 'Every morning at 9, summarise my open pull requests and',
      active: false,
    });
    expect(await textsIn(user.id, open)).toEqual(['hlo', 're: hlo']);
  });

  it('two runs at once start one conversation between them', async () => {
    const user = await chatUser({ plan: 'pro' });
    const a = await createAutomation({
      userId: user.id,
      title: 'Twice',
      instruction: 'x',
      sessionKey: 'web',
      cron: '0 9 * * *',
    });
    const ids = await Promise.all([runConversation(a), runConversation(a), runConversation(a)]);
    expect(new Set(ids).size).toBe(1);
    expect(await conversationsOf(user.id)).toHaveLength(1);
    expect((await automationsOf(user.id))[0]!.conversationId).toBe(ids[0]);
    // A run that comes again later finds it.
    expect(await runConversation(a)).toBe(ids[0]);
  });

  it('Telegram: in the chat’s current conversation, where the user can answer it', async () => {
    const user = await chatUser({ plan: 'pro' });
    const chatId = String(Math.floor(Math.random() * 1e9));
    await db()
      .insert(channelLinks)
      .values({ id: newId('chl'), userId: user.id, channel: 'telegram', externalId: chatId });
    const sessionKey = `telegram:${chatId}`;
    const made = await activeConversation(user.id, sessionKey);
    const a = await createAutomation({
      userId: user.id,
      title: 'TG digest',
      instruction: 'x',
      sessionKey,
      cron: '0 9 * * *',
      conversationId: made.id,
    });
    const { conversation: current } = await startNewChat(user.id, sessionKey, {
      channel: 'telegram',
    });
    const reply = await fire(a);
    expect(reply.conversationId).toBe(current.id);
    expect(await conversationsOf(user.id)).toHaveLength(2);
  });
});
