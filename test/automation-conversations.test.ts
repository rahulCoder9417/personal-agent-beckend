// An automation's runs reply in the conversation it was made in, else in a conversation of its
// own (web chat), never in whatever conversation the user has open. And a timer run that starts
// more than 10 minutes after it was due says so.
import { randomUUID } from 'node:crypto';
import type { Job, Worker } from 'bullmq';
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
import {
  describeDueTime,
  dueTimeOf,
  handleRunAutomation,
  LATE_AFTER_MS,
  lateNote,
  setLateAfterMs,
} from '../src/modules/automations/jobs.ts';
import { automations } from '../src/modules/automations/schema.ts';
import { activeConversation } from '../src/modules/channels/conversations.ts';
import { conversations, messages } from '../src/modules/channels/schema.ts';
import { requeuePendingEvents } from '../src/modules/events/intake.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { startNewChat, startNewWebChat } from '../src/modules/orchestrator/chats.ts';
import { config } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { redis } from '../src/shared/redis.ts';
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
/** An automation turn's own text: from its `[Automation "…"]` line on. */
const automationText = (text: string) => text.slice(text.indexOf('[Automation "'));

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

describe('a timer run that starts late', () => {
  const AT = new Date('2026-10-13T03:30:00Z'); // 9:00 AM in India

  it('says when it was due, in the automation’s time zone, and how late it is', () => {
    expect(describeDueTime(AT, 'Asia/Kolkata')).toBe(
      '9:00 AM on Tuesday 13 October (Asia/Kolkata)',
    );
    expect(describeDueTime(AT, 'Nowhere/Land')).toBe('3:30 AM on Tuesday 13 October (UTC)');
    const later = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);
    expect(lateNote(AT, later(31), 'Asia/Kolkata', LATE_AFTER_MS)).toBe(
      '[This run is late. It was due at 9:00 AM on Tuesday 13 October (Asia/Kolkata) and starts ' +
        '31 minutes late. Start your reply by saying that it is late and when it was due.]',
    );
    expect(lateNote(AT, later(185), 'UTC', LATE_AFTER_MS)).toContain('starts about 3 hours late');
    expect(lateNote(AT, later(3 * 24 * 60), 'UTC', LATE_AFTER_MS)).toContain(
      'starts about 3 days late',
    );
  });

  it('on time (at most 10 minutes after it was due) says nothing', () => {
    expect(lateNote(AT, AT, 'UTC', LATE_AFTER_MS)).toBeNull();
    expect(lateNote(AT, new Date(AT.getTime() + LATE_AFTER_MS), 'UTC', LATE_AFTER_MS)).toBeNull();
    expect(
      lateNote(AT, new Date(AT.getTime() + LATE_AFTER_MS + 1000), 'UTC', LATE_AFTER_MS),
    ).not.toBeNull();
    // Early (a clock a little behind) is not late.
    expect(lateNote(AT, new Date(AT.getTime() - 5000), 'UTC', LATE_AFTER_MS)).toBeNull();
  });

  it('the due time: a one-time automation’s moment; the scheduler’s slot; else added + delay', () => {
    const once = { kind: 'once', runAt: AT } as Automation;
    const repeat = { kind: 'repeat', runAt: null } as Automation;
    const job = (opts: Job['opts'], timestamp = 0) => ({ opts, timestamp });
    expect(dueTimeOf(once, job({ delay: 0 }, Date.now()))).toEqual(AT);
    expect(dueTimeOf(repeat, job({ prevMillis: AT.getTime(), delay: 0 }, Date.now()))).toEqual(AT);
    expect(dueTimeOf(repeat, job({ delay: 60_000 }, AT.getTime() - 60_000))).toEqual(AT);
  });

  it('a run due while the worker was stopped still runs, says it is late; the next one does not', async () => {
    const user = await chatUser({ plan: 'pro' });
    setLateAfterMs(1500);
    try {
      await stop();
      const a = await createAutomation({
        userId: user.id,
        title: 'Ticker',
        instruction: 'tick',
        sessionKey: 'web',
        cron: '*/2 * * * * *',
        timezone: 'Asia/Kolkata',
      });
      // Its first slot passes while nothing runs jobs.
      await new Promise((r) => setTimeout(r, 4000));
      start();
      await waitFor(async () => (await runReplies(user.id, 'Ticker')).length >= 2, 15_000);
      const turns = automationTurns().filter((d) => d.userId === user.id);
      const [late, onTime] = turns.map((d) => automationText(d.text));
      expect(late).toMatch(
        /^\[Automation "Ticker"\] \[This run is late\. It was due at \d{1,2}:\d{2} [AP]M on \w+ \d{1,2} \w+ \(Asia\/Kolkata\) and starts \d+ minutes? late\./,
      );
      expect(late!.split('\n').at(-1)).toBe('tick');
      expect(onTime).toBe('[Automation "Ticker"] tick');
      await call(`/v1/automations/${a.id}`, { method: 'DELETE', token: user.token });
    } finally {
      setLateAfterMs(LATE_AFTER_MS);
      if (!workers.length) start();
    }
  });

  it('a run re-added from its saved event after Redis lost its jobs still knows when it was due', async () => {
    const user = await chatUser({ plan: 'pro' });
    const a = await createAutomation({
      userId: user.id,
      title: 'Bank',
      instruction: 'Remind me to call the bank',
      sessionKey: 'web',
      runAt: new Date(Date.now() + 3600_000),
      timezone: 'Asia/Kolkata',
    });
    // It was due 20 minutes ago (the server was off): the timer fires now, with no worker to
    // run the turn, and then Redis loses every job.
    const dueAt = new Date(Date.now() - 20 * 60_000);
    const [due] = await db()
      .update(automations)
      .set({ runAt: dueAt })
      .where(eq(automations.id, a.id))
      .returning();
    await stop();
    try {
      await handleRunAutomation({
        id: `fire-${randomUUID()}`,
        data: { automationId: due!.id, userId: user.id },
        opts: {},
        timestamp: Date.now(),
      } as unknown as Job);
      const keys = await redis().keys(`${config().QUEUE_PREFIX}:*`);
      if (keys.length) await redis().del(...keys);
      expect(await requeuePendingEvents()).toBeGreaterThanOrEqual(1);
    } finally {
      start();
    }
    await waitFor(async () => (await runReplies(user.id, 'Bank')).length >= 1);
    const turn = automationTurns().find((d) => d.userId === user.id)!;
    expect(automationText(turn.text)).toBe(
      `[Automation "Bank"] [This run is late. It was due at ${describeDueTime(dueAt, 'Asia/Kolkata')} ` +
        'and starts 20 minutes late. Start your reply by saying that it is late and when it was due.]\n' +
        'Remind me to call the bank',
    );
  });
});
