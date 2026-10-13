// Every run of every automation answers in the user's Automations chat: one conversation of its
// own, never the one the user has open and never made the active one. One made in a Telegram chat
// also sends a copy of the answer there, once, outside the Telegram conversation's context. And a
// timer run that starts more than 10 minutes after it was due says so.
import { randomUUID } from 'node:crypto';
import type { Job, Worker } from 'bullmq';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliverKind } from '../proto-gen/vm/v1/vm_pb.ts';
import { channelLinks } from '../src/modules/auth/schema.ts';
import {
  createAutomation,
  reregisterAll,
  setMinIntervalMs,
  type Automation,
} from '../src/modules/automations/automations.ts';
import {
  describeDueTime,
  dueTimeOf,
  handleAutomationTurn,
  handleRunAutomation,
  LATE_AFTER_MS,
  lateNote,
  setLateAfterMs,
} from '../src/modules/automations/jobs.ts';
import { automations } from '../src/modules/automations/schema.ts';
import {
  activeConversation,
  automationsChat,
  findAutomationsChat,
} from '../src/modules/channels/conversations.ts';
import { recentConversationMessages, saveInbound } from '../src/modules/channels/messages.ts';
import { conversations, messages } from '../src/modules/channels/schema.ts';
import { requeuePendingEvents } from '../src/modules/events/intake.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { startNewWebChat } from '../src/modules/orchestrator/chats.ts';
import { chatRecap } from '../src/modules/orchestrator/turn-context.ts';
import { config } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { redis } from '../src/shared/redis.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakeTelegram, installFakeVm, type Delivery, type SentTelegram } from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[] = [];
let vm: ReturnType<typeof installFakeVm>;
let tg: { sent: SentTelegram[] };

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
  tg = installFakeTelegram();
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

/** The copies of runs' answers sent to a chat app. */
const copiesOf = (userId: string) =>
  db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), isNotNull(messages.copyOf)));

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
const channelOf = (d: Delivery) => (d as unknown as { channel: string }).channel;
const epochOf = (d: Delivery | undefined) =>
  (JSON.parse((d as unknown as { metadataJson: string }).metadataJson) as { chat_epoch: number })
    .chat_epoch;

describe('the Automations chat: where every run answers', () => {
  it('made in web chat: every run answers there, never in the chat that is open, never active', async () => {
    const user = await chatUser({ plan: 'pro' });
    const { conversationId: made } = await say(user, 'every morning at 9, summarise my PRs');
    const [a] = await automationsOf(user.id);
    // Making it started the Automations chat, beside the others.
    const chat = (await findAutomationsChat(user.id))!;
    expect(chat).toMatchObject({
      kind: 'automations',
      title: 'Automations',
      active: false,
      sessionKey: 'web',
      channel: 'web',
    });

    // The user starts a new chat and says hello there: that one is now the active one.
    const fresh = await startNewWebChat(user.id);
    await say(user, 'hlo');

    const one = await fire(a!);
    const two = await fire(a!, 1);
    expect(one.conversationId).toBe(chat.id);
    expect(two.conversationId).toBe(chat.id);
    expect(await textsIn(user.id, chat.id)).toEqual(['ran: Morning PRs', 'ran: Morning PRs']);
    expect(await textsIn(user.id, made)).toEqual([
      'every morning at 9, summarise my PRs',
      're: every morning at 9, summarise my PRs',
    ]);
    expect(await textsIn(user.id, fresh.id)).toEqual(['hlo', 're: hlo']);

    // Each run continued the Automations chat's own context, in web chat.
    const turns = automationTurns().filter((d) => d.userId === user.id);
    expect(turns.map((d) => [d.sessionKey, channelOf(d), epochOf(d)])).toEqual([
      ['web', 'web', chat.epoch],
      ['web', 'web', chat.epoch],
    ]);
    // A run never makes it the active one: the user's next message goes where it went before.
    expect((await activeConversation(user.id, 'web')).id).toBe(fresh.id);
    expect((await say(user, 'and now?')).conversationId).toBe(fresh.id);
    expect((await findAutomationsChat(user.id))!.active).toBe(false);
    // Made in web chat: no copy is sent anywhere.
    expect(await copiesOf(user.id)).toHaveLength(0);
  });

  it('made from the web app or with no turn (REST): the Automations chat all the same', async () => {
    const user = await chatUser({ plan: 'pro' });
    const { conversationId: open } = await say(user, 'hlo');
    const a = await createAutomation({
      userId: user.id,
      title: 'Every morning at 9, summarise my open pull requests',
      instruction: 'Summarise',
      sessionKey: 'web',
      cron: '0 9 * * *',
    });
    const reply = await fire(a);
    const chat = (await findAutomationsChat(user.id))!;
    expect(reply.conversationId).toBe(chat.id);
    expect(chat.title).toBe('Automations');
    expect(await textsIn(user.id, open)).toEqual(['hlo', 're: hlo']);
    // One Automations chat for every automation of the user.
    const b = await createAutomation({
      userId: user.id,
      title: 'Second',
      instruction: 'x',
      sessionKey: 'web',
      cron: '0 10 * * *',
    });
    expect((await fire(b)).conversationId).toBe(chat.id);
    expect((await conversationsOf(user.id)).filter((c) => c.kind === 'automations')).toHaveLength(
      1,
    );
  });

  it('deleted by the user: the next run starts a new one, with a number never used before', async () => {
    const user = await chatUser({ plan: 'pro' });
    const a = await createAutomation({
      userId: user.id,
      title: 'Gone',
      instruction: 'x',
      sessionKey: 'web',
      cron: '0 9 * * *',
    });
    await fire(a);
    const first = (await findAutomationsChat(user.id))!;
    await expectContract(
      'deleteConversation',
      await call(`/v1/conversations/${first.id}`, { method: 'DELETE', token: user.token }),
      204,
    );
    expect(await findAutomationsChat(user.id)).toBeUndefined();
    // Its messages went with it, so the next reply is the first one found again.
    const reply = await fire(a);
    const again = (await findAutomationsChat(user.id))!;
    expect(again.id).not.toBe(first.id);
    expect(again).toMatchObject({ kind: 'automations', title: 'Automations', active: false });
    expect(again.epoch).toBeGreaterThan(first.epoch);
    expect(reply.conversationId).toBe(again.id);
    const turns = automationTurns().filter((d) => d.userId === user.id);
    expect(turns.map(epochOf)).toEqual([first.epoch, again.epoch]);
  });

  it('two runs at once start one Automations chat between them', async () => {
    const user = await chatUser({ plan: 'pro' });
    const chats = await Promise.all([1, 2, 3, 4].map(() => automationsChat(user.id)));
    expect(new Set(chats.map((c) => c.id)).size).toBe(1);
    expect(await conversationsOf(user.id)).toHaveLength(1);
    expect(await automationsChat(user.id)).toMatchObject({ id: chats[0]!.id });
  });

  it('the user writes in it: the agent continues the runs’ context, and it stays not active', async () => {
    const user = await chatUser({ plan: 'pro' });
    const { conversationId: open } = await say(user, 'hlo');
    const a = await createAutomation({
      userId: user.id,
      title: 'Morning PRs',
      instruction: 'x',
      sessionKey: 'web',
      cron: '0 9 * * *',
    });
    await fire(a);
    const chat = (await findAutomationsChat(user.id))!;

    const sent = await expectContract<{ id: string; conversationId: string }>(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: user.token,
        body: { text: 'which one first?', clientMessageId: randomUUID(), conversationId: chat.id },
      }),
      202,
    );
    expect(sent.conversationId).toBe(chat.id);
    await waitFor(async () => {
      const [row] = await db().select().from(messages).where(eq(messages.id, sent.id));
      return row?.status === 'delivered';
    });
    expect(await textsIn(user.id, chat.id)).toEqual([
      'ran: Morning PRs',
      'which one first?',
      're: which one first?',
    ]);
    const turn = vm.deliveries.find(
      (d) => d.userId === user.id && lastLine(d.text) === 'which one first?',
    )!;
    expect([turn.sessionKey, epochOf(turn)]).toEqual(['web', chat.epoch]);
    // Writing in it did not make it the active one.
    expect((await findAutomationsChat(user.id))!.active).toBe(false);
    expect((await activeConversation(user.id, 'web')).id).toBe(open);
    expect((await say(user, 'back here')).conversationId).toBe(open);
  });

  it('keeps its name and is never made active (409); the list can pin it apart', async () => {
    const user = await chatUser({ plan: 'pro' });
    await say(user, 'hlo');
    const chat = await automationsChat(user.id);
    const patch = (body: unknown) =>
      call(`/v1/conversations/${chat.id}`, { method: 'PATCH', token: user.token, body });
    await expectContract('updateConversation', await patch({ title: 'Mine' }), 409);
    await expectContract('updateConversation', await patch({ active: true }), 409);
    expect((await findAutomationsChat(user.id))!).toMatchObject({
      title: 'Automations',
      active: false,
    });

    type List = { items: Array<{ id: string; kind: string; title: string; active: boolean }> };
    const list = (query: string) =>
      call(`/v1/conversations${query}`, { token: user.token }).then((r) =>
        expectContract<List>('listConversations', r, 200),
      );
    const all = await list('');
    expect(all.items.map((c) => c.kind).sort()).toEqual(['automations', 'chat']);
    expect((await list('?kind=automations')).items).toEqual([
      expect.objectContaining({ id: chat.id, kind: 'automations', title: 'Automations' }),
    ]);
    expect((await list('?kind=chat')).items.map((c) => c.kind)).toEqual(['chat']);
  });

  describe('made in a Telegram chat', () => {
    async function telegramUser() {
      const user = await chatUser({ plan: 'pro' });
      const chatId = Math.floor(Math.random() * 1e9);
      await db()
        .insert(channelLinks)
        .values({
          id: newId('chl'),
          userId: user.id,
          channel: 'telegram',
          externalId: String(chatId),
        });
      return { ...user, chatId, sessionKey: `telegram:${chatId}` };
    }
    const sentTo = (chatId: number) => tg.sent.filter((m) => m.chatId === String(chatId));

    it('runs in the Automations chat; a copy of the answer goes to Telegram, once', async () => {
      const user = await telegramUser();
      // The user had said something on Telegram before.
      await saveInbound({
        userId: user.id,
        channel: 'telegram',
        text: 'hi there',
        eventId: `evt_${randomUUID()}`,
        sessionKey: user.sessionKey,
      });
      const telegramChat = await activeConversation(user.id, user.sessionKey);
      const a = await createAutomation({
        userId: user.id,
        title: 'Daily open PRs and issues',
        instruction: 'x',
        sessionKey: user.sessionKey,
        cron: '0 9 * * *',
      });
      const reply = await fire(a);
      const chat = (await findAutomationsChat(user.id))!;
      expect(reply.conversationId).toBe(chat.id);
      const turn = automationTurns().find((d) => d.userId === user.id)!;
      expect([turn.sessionKey, channelOf(turn), epochOf(turn)]).toEqual(['web', 'web', chat.epoch]);

      const [copy] = await waitFor(async () => {
        const sent = sentTo(user.chatId);
        return sent.length ? sent : undefined;
      });
      expect(copy!.text).toBe(
        '⏰ Daily open PRs and issues\n\nran: Daily open PRs and issues\n\n' +
          'To follow up, open the Automations chat in the Textcrew web app: ' +
          `${config().WEB_APP_URL}/?chat=automations`,
      );
      // Kept, for display, in the Telegram chat's current conversation, marked as a copy.
      const copies = await copiesOf(user.id);
      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatchObject({
        copyOf: reply.id,
        conversationId: telegramChat.id,
        sessionKey: user.sessionKey,
        direction: 'out',
      });
      await waitFor(async () => (await copiesOf(user.id))[0]?.status === 'sent');

      // It is not part of the Telegram conversation's context: not for the router, not in the
      // recap a new engine gets.
      const context = await recentConversationMessages(user.id, telegramChat.id, 20);
      expect(context.map((m) => m.text)).toEqual(['hi there']);
      const recap = await chatRecap({
        userId: user.id,
        conversation: telegramChat,
        engine: 'hermes',
      });
      expect(recap).toContain('User: hi there');
      expect(recap).not.toContain('ran:');
      // The Telegram chat's current conversation is still the one it was.
      expect((await activeConversation(user.id, user.sessionKey)).id).toBe(telegramChat.id);
      expect(await textsIn(user.id, chat.id)).toEqual(['ran: Daily open PRs and issues']);
    });

    it('a job that runs again sends no second copy', async () => {
      const user = await telegramUser();
      // Like the Bridge: a delivery it has answered ends at once when it comes again.
      const answered = new Set<string>();
      vm.state.agent = async (d, mcp) => {
        if (answered.has(d.deliveryId)) return;
        answered.add(d.deliveryId);
        const title = /\[Automation "([^"]+)"\]/.exec(d.text)?.[1];
        await mcp('send_message', { text: `ran: ${title}`, session_key: d.sessionKey });
      };
      const a = await createAutomation({
        userId: user.id,
        title: 'Once only',
        instruction: 'x',
        sessionKey: user.sessionKey,
        cron: '0 9 * * *',
      });
      const reply = await fire(a);
      await waitFor(async () => (await copiesOf(user.id))[0]?.status === 'sent');
      // The worker died after the copy: the same job runs again.
      await handleAutomationTurn({
        id: `again-${randomUUID()}`,
        data: { eventId: reply.eventId, automationId: a.id, userId: user.id },
        opts: { attempts: 5 },
        attemptsMade: 1,
        timestamp: Date.now(),
      } as unknown as Job);
      await new Promise((r) => setTimeout(r, 300));
      expect(await copiesOf(user.id)).toHaveLength(1);
      expect(sentTo(user.chatId)).toHaveLength(1);
      expect(automationTurns().filter((d) => d.userId === user.id)).toHaveLength(2);
    });

    it('no copy to a chat that is no longer linked to the user', async () => {
      const user = await telegramUser();
      const a = await createAutomation({
        userId: user.id,
        title: 'Unlinked',
        instruction: 'x',
        sessionKey: user.sessionKey,
        cron: '0 9 * * *',
      });
      await db().delete(channelLinks).where(eq(channelLinks.userId, user.id));
      const reply = await fire(a);
      expect(reply.conversationId).toBe((await findAutomationsChat(user.id))!.id);
      await new Promise((r) => setTimeout(r, 300));
      expect(await copiesOf(user.id)).toHaveLength(0);
      expect(sentTo(user.chatId)).toHaveLength(0);
    });
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

  it('setting the timers again when the worker starts keeps a run that came due meanwhile', async () => {
    const user = await chatUser({ plan: 'pro' });
    setLateAfterMs(1500);
    try {
      await stop();
      const a = await createAutomation({
        userId: user.id,
        title: 'Restart',
        instruction: 'tick',
        sessionKey: 'web',
        cron: '*/2 * * * * *',
      });
      await new Promise((r) => setTimeout(r, 4000));
      // What the worker does at start, here before any job is picked up.
      await reregisterAll();
      start();
      await waitFor(async () => (await runReplies(user.id, 'Restart')).length >= 1, 15_000);
      const [first] = automationTurns().filter((d) => d.userId === user.id);
      expect(automationText(first!.text)).toMatch(/^\[Automation "Restart"\] \[This run is late\./);
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
