// Notices and approvals on Telegram (docs/backend-report.md, "Notices on Telegram"): the user's
// three switches and quiet hours, a short notice when a crew job asked in the web app ends, the copy
// of a pull-request review's verdict and of a web-made automation's answer, an automation's
// approval asked on Telegram too (its own switch) with the first answer winning and the other
// copies losing their buttons, an approval asked in the web app staying there, and silent messages
// during quiet hours. Nothing goes to Telegram when it isn't linked.
import { randomUUID } from 'node:crypto';
import type { Job, Worker } from 'bullmq';
import { and, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliverKind } from '../proto-gen/vm/v1/vm_pb.ts';
import { channelLinks, users } from '../src/modules/auth/schema.ts';
import { createAutomation } from '../src/modules/automations/automations.ts';
import {
  crewNoticeText,
  noticeCrewJob,
  reportSummary,
} from '../src/modules/automations/crew-notice.ts';
import { handleCrewJob, offerCrewRerun } from '../src/modules/automations/crew-jobs.ts';
import { automations, crewJobs } from '../src/modules/automations/schema.ts';
import { setTelegramApi } from '../src/modules/channels/adapters/telegram.ts';
import { findAutomationsChat, startConversation } from '../src/modules/channels/conversations.ts';
import { saveInbound } from '../src/modules/channels/messages.ts';
import { isQuietTime } from '../src/modules/channels/notify.ts';
import { queueOutbound } from '../src/modules/channels/outbound.ts';
import { conversations, messages } from '../src/modules/channels/schema.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { approvalEndNote } from '../src/modules/orchestrator/approval-text.ts';
import { requestApproval } from '../src/modules/orchestrator/approvals.ts';
import { approvals } from '../src/modules/orchestrator/schema.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  installFakeComposio,
  installFakeVm,
  telegramButton,
  telegramUpdate,
  type Delivery,
} from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

/** Every call to the Telegram Bot API, with its whole body. */
type TgCall = { method: string; body: Record<string, unknown> };
let tg: TgCall[] = [];
let nextMessageId = 5000;
function installTelegram() {
  tg = [];
  setTelegramApi(async (method, body) => {
    tg.push({ method, body });
    return method === 'sendMessage' ? { message_id: nextMessageId++ } : {};
  });
}
const sentTo = (chatId: string) =>
  tg.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === chatId);
const editsIn = (chatId: string) =>
  tg.filter((c) => c.method === 'editMessageText' && String(c.body.chat_id) === chatId);
const buttonsOf = (c: TgCall) =>
  (c.body.reply_markup as { inline_keyboard?: Array<Array<{ callback_data: string }>> } | undefined)
    ?.inline_keyboard?.[0];

let workers: Worker[] = [];
let vm: ReturnType<typeof installFakeVm>;

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50], busyDelayMs: 25 });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(async () => {
  installTelegram();
  await installFakeComposio();
  vm = installFakeVm(async (d, mcp) => {
    await mcp('send_message', {
      text: `re: ${d.text.split('\n').at(-1)}`,
      session_key: d.sessionKey,
    });
  });
});

type TestUser = Awaited<ReturnType<typeof chatUser>> & { chatId: string };

/** A user with credits; `telegram` links a Telegram chat. Quiet hours off unless asked. */
async function person(opts: { telegram?: boolean; github?: boolean } = {}): Promise<TestUser> {
  const user = await chatUser({ plan: 'pro', quietHoursOn: false });
  const chatId = String(Math.floor(Math.random() * 1e9));
  if (opts.telegram !== false)
    await db()
      .insert(channelLinks)
      .values({ id: newId('chl'), userId: user.id, channel: 'telegram', externalId: chatId });
  if (opts.github)
    await db()
      .insert(connections)
      .values({
        id: newId('con'),
        userId: user.id,
        app: 'github',
        composioAccountId: `ca_${randomUUID()}`,
        status: 'active',
      });
  return { ...user, chatId };
}

type Me = {
  timezone: string;
  notifications: {
    crewJobs: boolean;
    prReviews: boolean;
    automationRuns: boolean;
    automationApprovals: boolean;
    quietHours: { enabled: boolean; start: string; end: string };
  };
};

const patchMe = (token: string, body: unknown) => call('/v1/me', { method: 'PATCH', token, body });

async function setNotifications(u: TestUser, notifications: Record<string, unknown>) {
  await expectContract('updateMe', await patchMe(u.token, { notifications }), 200);
}

const settle = () => new Promise((r) => setTimeout(r, 600));

/** The conversations of the user's Telegram chat (none: a copy started none there). */
const telegramConversations = (u: TestUser) =>
  db()
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.userId, u.id), eq(conversations.sessionKey, `telegram:${u.chatId}`)),
    )
    .orderBy(conversations.epoch);

type ListedConversation = { id: string; channel: string; kind: string; title: string };
/** The web app's chat list. */
const listed = async (u: TestUser) =>
  (
    await expectContract<{ items: ListedConversation[] }>(
      'listConversations',
      await call('/v1/conversations', { token: u.token }),
      200,
    )
  ).items;

type ListedMessage = { id: string; channel: string; text: string; approvalId: string | null };
/** What the web app shows of one conversation, newest first. */
const shownIn = async (u: TestUser, conversationId: string) =>
  (
    await expectContract<{ items: ListedMessage[] }>(
      'listMessages',
      await call(`/v1/messages?conversationId=${conversationId}`, { token: u.token }),
      200,
    )
  ).items;

// --- the setting -----------------------------------------------------------------------------

describe('"Tell me on Telegram when…": the setting', () => {
  it('starts with crew jobs, reviews and automation approvals on, web automations off, quiet hours 22:00 to 08:00', async () => {
    const user = await chatUser();
    const me = await expectContract<Me>('getMe', await call('/v1/me', { token: user.token }), 200);
    expect(me.notifications).toEqual({
      crewJobs: true,
      prReviews: true,
      automationRuns: false,
      automationApprovals: true,
      quietHours: { enabled: true, start: '22:00', end: '08:00' },
    });
  });

  it('changes only the fields it names; refuses quiet hours that start when they end', async () => {
    const user = await chatUser();
    const me = await expectContract<Me>(
      'updateMe',
      await patchMe(user.token, {
        notifications: { automationRuns: true, quietHours: { start: '23:30' } },
      }),
      200,
    );
    expect(me.notifications).toEqual({
      crewJobs: true,
      prReviews: true,
      automationRuns: true,
      automationApprovals: true,
      quietHours: { enabled: true, start: '23:30', end: '08:00' },
    });
    const off = await expectContract<Me>(
      'updateMe',
      await patchMe(user.token, {
        notifications: {
          crewJobs: false,
          automationApprovals: false,
          quietHours: { enabled: false },
        },
      }),
      200,
    );
    expect(off.notifications).toMatchObject({
      crewJobs: false,
      automationRuns: true,
      automationApprovals: false,
      quietHours: { enabled: false, start: '23:30', end: '08:00' },
    });
    // The end given, the start kept: the same time is refused.
    await expectContract(
      'updateMe',
      await patchMe(user.token, { notifications: { quietHours: { end: '23:30' } } }),
      400,
    );
    // Not a time of day.
    await expectContract(
      'updateMe',
      await patchMe(user.token, { notifications: { quietHours: { start: '7pm' } } }),
      400,
    );
    const now = await expectContract<Me>('getMe', await call('/v1/me', { token: user.token }), 200);
    expect(now.notifications.quietHours).toEqual({ enabled: false, start: '23:30', end: '08:00' });
  });
});

// --- quiet hours ------------------------------------------------------------------------------

describe('quiet hours', () => {
  const night = { enabled: true, start: '22:00', end: '08:00' };
  // 17:00 UTC is 22:30 in India.
  const at = (iso: string) => new Date(iso);

  it('run over midnight in the user’s time zone, and never when switched off', () => {
    expect(isQuietTime(night, 'Asia/Kolkata', at('2026-10-16T17:00:00Z'))).toBe(true);
    expect(isQuietTime(night, 'UTC', at('2026-10-16T17:00:00Z'))).toBe(false);
    expect(isQuietTime(night, 'Asia/Kolkata', at('2026-10-17T02:29:00Z'))).toBe(true); // 07:59
    expect(isQuietTime(night, 'Asia/Kolkata', at('2026-10-17T02:30:00Z'))).toBe(false); // 08:00
    expect(isQuietTime(night, 'Asia/Kolkata', at('2026-10-16T16:29:00Z'))).toBe(false); // 21:59
    expect(
      isQuietTime(
        { enabled: true, start: '13:00', end: '14:00' },
        'UTC',
        at('2026-10-16T13:30:00Z'),
      ),
    ).toBe(true);
    expect(
      isQuietTime(
        { enabled: true, start: '13:00', end: '14:00' },
        'UTC',
        at('2026-10-16T14:00:00Z'),
      ),
    ).toBe(false);
    expect(
      isQuietTime({ ...night, enabled: false }, 'Asia/Kolkata', at('2026-10-16T17:00:00Z')),
    ).toBe(false);
    expect(
      isQuietTime(
        { enabled: true, start: '09:00', end: '09:00' },
        'UTC',
        at('2026-10-16T09:00:00Z'),
      ),
    ).toBe(false);
    // An unknown time zone counts as UTC.
    expect(isQuietTime(night, 'Mars/Olympus', at('2026-10-16T23:00:00Z'))).toBe(true);
  });

  it('send Telegram messages silently, and only then', async () => {
    const u = await person();
    const hh = (d: Date) => `${String(d.getUTCHours()).padStart(2, '0')}:00`;
    const now = new Date();
    // Quiet from an hour ago to an hour from now, in UTC: now is inside.
    await db()
      .update(users)
      .set({
        timezone: 'UTC',
        quietHoursOn: true,
        quietHoursStart: hh(new Date(now.getTime() - 3600_000)),
        quietHoursEnd: hh(new Date(now.getTime() + 3600_000)),
      })
      .where(eq(users.id, u.id));
    await queueOutbound({ userId: u.id, sessionKey: `telegram:${u.chatId}`, text: 'at night' });
    const [quiet] = await waitFor(async () => (sentTo(u.chatId).length ? sentTo(u.chatId) : null));
    expect(quiet!.body).toMatchObject({ text: 'at night', disable_notification: true });

    // Switched off: sent as usual, with a sound.
    await setNotifications(u, { quietHours: { enabled: false } });
    await queueOutbound({ userId: u.id, sessionKey: `telegram:${u.chatId}`, text: 'by day' });
    const loud = await waitFor(async () => sentTo(u.chatId).find((c) => c.body.text === 'by day'));
    expect(loud.body).not.toHaveProperty('disable_notification');
  });
});

// --- crew jobs --------------------------------------------------------------------------------

const BYTE_REPORT = [
  '**Verdict:** done',
  '**Branch:** `crew/abc12345` (pushed) · **Pull request:** https://github.com/acme/web/pull/43',
  '**Changes**',
  '1. `src/login.ts:40`: the redirect checks the session first.',
  '**Acceptance checks**',
  '- signing in after a timeout lands on the dashboard: passed',
  '**Tests run**',
  '- `pnpm test`: passed (42 passed, 0 failed)',
  '**Not checked**',
  '- Safari',
].join('\n');

const byteBrief = () => ({
  member: 'byte',
  owner: 'acme',
  repo: 'web',
  branch: 'main',
  instructions: 'Fix login',
  clientRequestId: randomUUID(),
});

type ApiJob = { id: string; status: string; conversationId: string | null };

async function runJob(u: TestUser, brief: Record<string, unknown> = byteBrief()) {
  vm.state.agent = async (d: Delivery, mcp) => {
    await mcp('send_message', { text: BYTE_REPORT, session_key: d.sessionKey });
  };
  const job = await expectContract<ApiJob>(
    'createCrewJob',
    await call('/v1/crew-jobs', { method: 'POST', token: u.token, body: brief }),
    201,
  );
  return waitFor(async () => {
    const now = await expectContract<ApiJob>(
      'getCrewJob',
      await call(`/v1/crew-jobs/${job.id}`, { token: u.token }),
      200,
    );
    return now.status === 'done' || now.status === 'failed' ? now : null;
  });
}

describe('crew jobs: a notice on Telegram when one asked in the web app ends', () => {
  it('the report stays in web chat; Telegram gets one short line with the link', async () => {
    const u = await person({ github: true });
    const job = await runJob(u);
    expect(job.status).toBe('done');
    const [notice] = await waitFor(async () => (sentTo(u.chatId).length ? sentTo(u.chatId) : null));
    expect(notice!.body.text).toBe(
      '✅ Byte finished: Fix login in acme/web. Done. PR #43 opened. Tests passed.\n' +
        `Report: http://web.test/?conversation=${job.conversationId}`,
    );
    // Saved once per job, marked as a copy.
    const copies = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, u.id), isNotNull(messages.copyOf)));
    expect(copies.map((m) => m.copyOf)).toEqual([`notice:crew_job:${job.id}`]);
    const row = (await db().select().from(messages).where(eq(messages.id, copies[0]!.id)))[0]!;
    await noticeCrewJob(
      { id: job.id, userId: u.id, member: 'byte', sessionKey: 'web', report: BYTE_REPORT },
      'Fix login in acme/web',
      null,
      job.conversationId,
    );
    await settle();
    expect(sentTo(u.chatId)).toHaveLength(1);
    expect(row.sessionKey).toBe(`telegram:${u.chatId}`);
    // Kept beside the report, in the web conversation it links to: no Telegram conversation, and
    // the web app shows the report only.
    expect(row.conversationId).toBe(job.conversationId);
    expect(await telegramConversations(u)).toEqual([]);
    expect((await shownIn(u, job.conversationId!)).some((m) => m.id === row.id)).toBe(false);
  });

  it('nothing on Telegram when the switch is off, or Telegram is not linked', async () => {
    const off = await person({ github: true });
    await setNotifications(off, { crewJobs: false });
    expect((await runJob(off)).status).toBe('done');
    const unlinked = await person({ github: true, telegram: false });
    expect((await runJob(unlinked)).status).toBe('done');
    await settle();
    expect(sentTo(off.chatId)).toEqual([]);
    // Not linked: nothing was even saved for a chat app.
    const own = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, unlinked.id), eq(messages.channel, 'telegram')));
    expect(own).toEqual([]);
  });

  it('a job asked on Telegram reports there, with no extra notice', async () => {
    const u = await person({ github: true });
    await runJob(u, { ...byteBrief(), reportTo: { channel: 'telegram' } });
    await settle();
    const sent = sentTo(u.chatId);
    expect(sent.map((c) => String(c.body.text).split('\n')[0])).toEqual(['Verdict: done']);
  });

  it('a job that could not start says why', async () => {
    // GitHub was connected when the job was given, and is not any more when it runs.
    const u = await person({ github: false });
    const [job] = await db()
      .insert(crewJobs)
      .values({
        id: newId('crj'),
        userId: u.id,
        member: 'byte',
        source: 'app',
        owner: 'acme',
        repo: 'web',
        branch: 'main',
        instructions: 'Fix login',
        sessionKey: 'web',
      })
      .returning();
    await handleCrewJob({
      data: { crewJobId: job!.id, userId: u.id, eventId: `evt_${randomUUID()}` },
      attemptsMade: 0,
      opts: { attempts: 5 },
    } as unknown as Job);
    const [notice] = await waitFor(async () => (sentTo(u.chatId).length ? sentTo(u.chatId) : null));
    expect(String(notice!.body.text)).toMatch(
      /^❌ Byte couldn't finish: Fix login in acme\/web\. GitHub is not connected\.\nDetails: http:\/\/web\.test\//,
    );
  });

  it('the summary reads the report’s verdict, pull request and tests', () => {
    expect(reportSummary('byte', BYTE_REPORT)).toBe('Done. PR #43 opened. Tests passed.');
    expect(
      reportSummary(
        'patch',
        '**Verdict:** fix first\n**Findings**\n1. x\n**Tests run**\n- `pnpm test`: failed (3 failed)\n**Not checked**\n- none',
      ),
    ).toBe('Verdict: fix first. Some tests failed.');
    expect(reportSummary('patch', 'No shape at all')).toBe('');
    expect(reportSummary('byte', null)).toBe('');
    expect(
      crewNoticeText({
        member: 'patch',
        title: 'Review acme/web#42',
        failure: "The agent couldn't finish the job. The chat says why.",
        report: null,
        conversationId: 'cnv_1',
      }),
    ).toBe(
      "❌ Patch couldn't finish: Review acme/web#42. The agent couldn't finish the job. The chat says why.\n" +
        'Details: http://web.test/?conversation=cnv_1',
    );
  });
});

// --- automations and pull-request reviews -----------------------------------------------------

async function fire(a: { id: string; userId: string }) {
  await queue('scheduled').add(
    'run-automation',
    { automationId: a.id, userId: a.userId },
    { jobId: `fire-${randomUUID()}` },
  );
  return waitFor(async () => {
    const [row] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, a.userId), eq(messages.text, 'ran')));
    return row;
  });
}

describe('automation runs and pull-request reviews', () => {
  beforeEach(() => {
    vm.state.agent = async (d, mcp) => {
      await mcp('send_message', { text: 'ran', session_key: d.sessionKey });
    };
  });

  const webAutomation = (userId: string, title: string) =>
    createAutomation({ userId, title, instruction: 'x', sessionKey: 'web', cron: '0 9 * * *' });

  it('one made in the web app copies its answer only when "automation runs" is on', async () => {
    const off = await person();
    await fire(await webAutomation(off.id, 'Morning brief'));
    await settle();
    expect(sentTo(off.chatId)).toEqual([]);

    const on = await person();
    await setNotifications(on, { automationRuns: true });
    const reply = await fire(await webAutomation(on.id, 'Morning brief'));
    const [copy] = await waitFor(async () => (sentTo(on.chatId).length ? sentTo(on.chatId) : null));
    expect(String(copy!.body.text)).toMatch(/^⏰ Morning brief\n\nran\n\nTo follow up/);
    const [kept] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, on.id), eq(messages.copyOf, reply.id)));
    expect(kept?.sessionKey).toBe(`telegram:${on.chatId}`);
    // Kept beside the answer in the Automations chat, which shows the answer once; the copy starts
    // no Telegram conversation, so the chat list gets no "New chat" for Telegram.
    expect(kept?.conversationId).toBe(reply.conversationId);
    expect(await telegramConversations(on)).toEqual([]);
    expect((await listed(on)).map((c) => c.channel)).not.toContain('telegram');
    expect((await shownIn(on, reply.conversationId)).map((m) => m.text)).toEqual(['ran']);
  });

  it('a pull-request review copies its verdict while "reviews" is on (it is at first)', async () => {
    const review = async (u: TestUser) => {
      const a = await webAutomation(u.id, 'Review pull requests in acme/web');
      await db().update(automations).set({ preset: 'pr_review' }).where(eq(automations.id, a.id));
      await fire(a);
    };
    const on = await person();
    await review(on);
    await waitFor(async () => (sentTo(on.chatId).length ? true : null));

    const off = await person();
    await setNotifications(off, { prReviews: false });
    await review(off);
    await settle();
    expect(sentTo(off.chatId)).toEqual([]);

    // The API says where the copies go now.
    const list = await expectContract<{
      items: Array<{ preset: string | null; copyTo: string | null }>;
    }>('listAutomations', await call('/v1/automations', { token: on.token }), 200);
    expect(list.items.map((a) => a.copyTo)).toEqual(['telegram']);
    const offList = await expectContract<{ items: Array<{ copyTo: string | null }> }>(
      'listAutomations',
      await call('/v1/automations', { token: off.token }),
      200,
    );
    expect(offList.items.map((a) => a.copyTo)).toEqual([null]);
  });
});

// --- approvals --------------------------------------------------------------------------------

const tgPost = (update: unknown) =>
  call('/webhooks/telegram', {
    method: 'POST',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
  });

const decide = (u: TestUser, id: string, decision: 'approve' | 'deny') =>
  call(`/v1/approvals/${id}/decision`, { method: 'POST', token: u.token, body: { decision } });

const answerTurns = (userId: string) =>
  vm.deliveries.filter((d) => d.userId === userId && d.kind === DeliverKind.APPROVAL_ANSWER);

describe('approvals on Telegram: an automation’s, not the web app’s', () => {
  /** In each turn the agent asks for what `summary` gives, or else just answers. */
  const asking = (summary: (d: Delivery) => string | null) => {
    vm.state.agent = async (d, mcp) => {
      const s = summary(d);
      if (s) await mcp('request_approval', { summary: s, session_key: d.sessionKey });
      else await mcp('send_message', { text: 'ok', session_key: d.sessionKey });
    };
  };
  const waitApprovals = (userId: string, n: number) =>
    waitFor(async () => {
      const rows = await db()
        .select()
        .from(approvals)
        .where(eq(approvals.userId, userId))
        .orderBy(approvals.createdAt);
      return rows.length >= n ? rows : null;
    });
  const telegramRows = (userId: string) =>
    db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, userId), eq(messages.channel, 'telegram')));
  const writeOnWeb = async (u: TestUser, text: string) =>
    expectContract(
      'sendMessage',
      await call('/v1/messages', {
        method: 'POST',
        token: u.token,
        body: { text, clientMessageId: randomUUID() },
      }),
      202,
    );
  const inboxSweep = (u: TestUser) =>
    createAutomation({
      userId: u.id,
      title: 'Inbox sweep',
      instruction: 'x',
      sessionKey: 'web',
      cron: '0 9 * * *',
    });
  const fireAutomation = async (u: TestUser) => {
    const a = await inboxSweep(u);
    await queue('scheduled').add(
      'run-automation',
      { automationId: a.id, userId: u.id },
      { jobId: `fire-${randomUUID()}` },
    );
    return a;
  };
  const SUMMARY = 'Send an email to priya@example.com with subject "Notes"';
  const ASK =
    'I\'d like to send an email to priya@example.com with subject "Notes". Approve or Deny below.';
  const BY_AUTOMATION =
    'Asked by one of your automations. Tex carries on in the web app after your answer.';

  it('asked in web chat: it stays in the web app, nothing goes to Telegram', async () => {
    const u = await person();
    asking((d) => (d.kind === DeliverKind.MESSAGE ? SUMMARY : null));
    await writeOnWeb(u, 'email Priya the notes');
    const [a] = await waitApprovals(u.id, 1);
    expect(a!.automationId).toBeNull();
    const [asked] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, u.id), eq(messages.approvalId, a!.id)));
    expect(asked!.channel).toBe('web');

    await expectContract('decideApproval', await decide(u, a!.id, 'approve'), 200);
    const [turn] = await waitFor(async () => (answerTurns(u.id).length ? answerTurns(u.id) : null));
    expect(turn!.sessionKey).toBe('web');
    await settle();
    expect(sentTo(u.chatId)).toEqual([]);
    expect(editsIn(u.chatId)).toEqual([]);
    expect(await telegramRows(u.id)).toEqual([]);
  });

  it('asked by an automation’s run: the same question on Telegram; answered on web, the copy loses its buttons', async () => {
    const u = await person();
    asking((d) => (d.kind === DeliverKind.AUTOMATION ? SUMMARY : null));
    const auto = await fireAutomation(u);
    const [a] = await waitApprovals(u.id, 1);
    expect(a!.automationId).toBe(auto.id);
    const [copy] = await waitFor(async () => (sentTo(u.chatId).length ? sentTo(u.chatId) : null));
    expect(copy!.body.text).toBe(`${ASK}\n\n${BY_AUTOMATION}`);
    expect(buttonsOf(copy!)?.map((b) => b.callback_data)).toEqual([
      `apr:${a!.id}:yes`,
      `apr:${a!.id}:no`,
    ]);

    await expectContract('decideApproval', await decide(u, a!.id, 'approve'), 200);
    const [edit] = await waitFor(async () => (editsIn(u.chatId).length ? editsIn(u.chatId) : null));
    expect(edit!.body).toEqual({
      chat_id: u.chatId,
      message_id: Number(await sentMessageId(u, a!.id)),
      text: `${ASK}\n\n${BY_AUTOMATION}\n\n✅ Approved on web`,
    });
    expect(edit!.body).not.toHaveProperty('reply_markup');

    // The agent goes on in the Automations chat, where the question was asked.
    const [turn] = await waitFor(async () => (answerTurns(u.id).length ? answerTurns(u.id) : null));
    expect(turn!.sessionKey).toBe('web');
    const [asked] = await db()
      .select()
      .from(messages)
      .where(
        and(eq(messages.userId, u.id), eq(messages.approvalId, a!.id), eq(messages.channel, 'web')),
      );
    const [answer] = await waitFor(async () => {
      const rows = await db()
        .select()
        .from(messages)
        .where(and(eq(messages.userId, u.id), eq(messages.eventId, turn!.deliveryId)));
      return rows.length ? rows : null;
    });
    expect(answer!.conversationId).toBe(asked!.conversationId);

    // A late tap on the copy: the first answer won.
    await tgPost(telegramButton(Number(u.chatId), `apr:${a!.id}:no`));
    const late = await waitFor(async () =>
      sentTo(u.chatId).find((c) => String(c.body.text).includes('already answered')),
    );
    expect(late.body.text).toBe('That approval was already answered or has expired.');
    await settle();
    expect(answerTurns(u.id)).toHaveLength(1);
  });

  it('denied on the Telegram copy: the run goes on in the web app, and its next question is copied too', async () => {
    const u = await person();
    // The run asks; in the turn after the answer, the same run's work asks one more thing.
    asking((d) =>
      d.kind === DeliverKind.AUTOMATION
        ? 'Delete the draft'
        : d.kind === DeliverKind.APPROVAL_ANSWER && answerTurns(u.id).length === 1
          ? 'Archive the thread'
          : null,
    );
    const auto = await fireAutomation(u);
    const [a] = await waitApprovals(u.id, 1);
    await waitFor(async () => (sentTo(u.chatId).length ? true : null));
    await tgPost(telegramButton(Number(u.chatId), `apr:${a!.id}:no`));
    const [edit] = await waitFor(async () => (editsIn(u.chatId).length ? editsIn(u.chatId) : null));
    expect(String(edit!.body.text)).toMatch(/\n\n❌ Denied on Telegram$/);
    const [turn] = await waitFor(async () => (answerTurns(u.id).length ? answerTurns(u.id) : null));
    expect(turn!.sessionKey).toBe('web');
    expect(turn!.approved).toBe(false);
    // The web app is answered too: deciding again there is refused.
    await expectContract('decideApproval', await decide(u, a!.id, 'approve'), 409);

    // The turn after the answer is still the automation's work.
    const [, next] = await waitApprovals(u.id, 2);
    expect(next!.automationId).toBe(auto.id);
    const second = await waitFor(async () =>
      sentTo(u.chatId).find((c) =>
        String(c.body.text).startsWith("I'd like to archive the thread"),
      ),
    );
    expect(buttonsOf(second)?.map((b) => b.callback_data)).toEqual([
      `apr:${next!.id}:yes`,
      `apr:${next!.id}:no`,
    ]);
  });

  it('nothing on Telegram for an automation’s approval while "An automation needs my OK" is off', async () => {
    const u = await person();
    await setNotifications(u, { automationApprovals: false });
    asking((d) => (d.kind === DeliverKind.AUTOMATION ? SUMMARY : null));
    const auto = await fireAutomation(u);
    const [a] = await waitApprovals(u.id, 1);
    expect(a!.automationId).toBe(auto.id);
    // Still answered in the web app as usual.
    await expectContract('decideApproval', await decide(u, a!.id, 'approve'), 200);
    await waitFor(async () => (answerTurns(u.id).length ? true : null));
    await settle();
    expect(sentTo(u.chatId)).toEqual([]);
    expect(await telegramRows(u.id)).toEqual([]);
  });

  it('a test run ("Run once now") is the user’s own: its approval stays in the web app', async () => {
    const u = await person();
    asking((d) => (d.kind === DeliverKind.AUTOMATION ? SUMMARY : null));
    const a = await inboxSweep(u);
    await expectContract(
      'runAutomationNow',
      await call(`/v1/automations/${a.id}/run`, {
        method: 'POST',
        token: u.token,
        body: { clientRequestId: randomUUID() },
      }),
      202,
    );
    const [asked] = await waitApprovals(u.id, 1);
    expect(asked!.automationId).toBeNull();
    await settle();
    expect(sentTo(u.chatId)).toEqual([]);
  });

  it('asked on Telegram: no second copy, and its own buttons go after the tap', async () => {
    const u = await person();
    const a = await requestApproval({
      userId: u.id,
      sessionKey: `telegram:${u.chatId}`,
      summary: 'Send an email to priya@example.com',
    });
    await waitFor(async () => (sentTo(u.chatId).length ? true : null));
    await settle();
    expect(sentTo(u.chatId)).toHaveLength(1);
    await tgPost(telegramButton(Number(u.chatId), `apr:${a.id}:yes`));
    const [edit] = await waitFor(async () => (editsIn(u.chatId).length ? editsIn(u.chatId) : null));
    expect(edit!.body.text).toBe(
      "I'd like to send an email to priya@example.com. Approve or Deny below.\n\n✅ Approved on Telegram",
    );
    const [turn] = await waitFor(async () => (answerTurns(u.id).length ? answerTurns(u.id) : null));
    expect(turn!.sessionKey).toBe(`telegram:${u.chatId}`);
  });

  it('asked on Telegram by an automation’s work: asked there once, whatever the switch', async () => {
    const u = await person();
    await setNotifications(u, { automationApprovals: false });
    await requestApproval({
      userId: u.id,
      sessionKey: `telegram:${u.chatId}`,
      summary: 'Send an email to priya@example.com',
      automationId: 'aut_x',
    });
    await waitFor(async () => (sentTo(u.chatId).length ? true : null));
    await settle();
    expect(sentTo(u.chatId)).toHaveLength(1);
  });

  it('a crew job’s "run it again?" follows who started the job', async () => {
    const offer = async (u: TestUser, automationId: string | null) => {
      const [row] = await db()
        .insert(crewJobs)
        .values({
          id: newId('crj'),
          userId: u.id,
          member: 'byte',
          source: automationId ? 'chat' : 'app',
          owner: 'acme',
          repo: 'web',
          branch: 'main',
          instructions: 'Fix login',
          sessionKey: 'web',
          status: 'done',
          automationId,
          blocked: [
            {
              kind: 'command',
              tool: 'Bash',
              target: 'curl -s https://x.test',
              why: 'it reaches the internet',
            },
          ],
        })
        .returning();
      await offerCrewRerun(u.id, row!.id, null);
      const [a] = await waitApprovals(u.id, 1);
      return a!;
    };
    // Given in the web app: the question stays there.
    const web = await person();
    expect((await offer(web, null)).automationId).toBeNull();
    // Started by an automation's run: copied to Telegram while the switch is on.
    const byRun = await person();
    const a = await offer(byRun, 'aut_x');
    expect(a.automationId).toBe('aut_x');
    const [copy] = await waitFor(async () =>
      sentTo(byRun.chatId).length ? sentTo(byRun.chatId) : null,
    );
    expect(String(copy!.body.text)).toMatch(/^I'd like to run Byte's job/);
    expect(String(copy!.body.text).endsWith(`\n\n${BY_AUTOMATION}`)).toBe(true);
    expect(buttonsOf(copy!)?.map((b) => b.callback_data)).toEqual([
      `apr:${a.id}:yes`,
      `apr:${a.id}:no`,
    ]);
    await settle();
    expect(sentTo(web.chatId)).toEqual([]);
  });

  it('nothing goes to Telegram when it is not linked', async () => {
    const u = await person({ telegram: false });
    const a = await requestApproval({
      userId: u.id,
      sessionKey: 'web',
      summary: 'Pay the invoice',
      automationId: 'aut_x',
    });
    await expectContract('decideApproval', await decide(u, a.id, 'approve'), 200);
    await waitFor(async () => (answerTurns(u.id).length ? true : null));
    await settle();
    // (Other tests' late messages may still arrive meanwhile: only this user's would name it.)
    expect(tg.filter((c) => JSON.stringify(c.body).includes('invoice'))).toEqual([]);
    expect(await telegramRows(u.id)).toEqual([]);
  });

  it('an automation’s question on Telegram starts no conversation there, also once answered by a button', async () => {
    const u = await person();
    asking((d) => (d.kind === DeliverKind.AUTOMATION ? SUMMARY : null));
    await fireAutomation(u);
    const [a] = await waitApprovals(u.id, 1);
    await waitFor(async () => (sentTo(u.chatId).length ? true : null));

    // The copy is kept beside the question, in the Automations chat; Telegram has no conversation.
    const chat = (await findAutomationsChat(u.id))!;
    const [copy] = await telegramRows(u.id);
    expect(copy).toMatchObject({ approvalId: a!.id, conversationId: chat.id, direction: 'out' });
    expect(await telegramConversations(u)).toEqual([]);
    // The web app: no Telegram conversation in the list, and the question once in the
    // Automations chat.
    expect((await listed(u)).map((c) => c.channel)).not.toContain('telegram');
    const shown = (await shownIn(u, chat.id)).filter((m) => m.approvalId === a!.id);
    expect(shown.map((m) => m.channel)).toEqual(['web']);

    // Approved with the copy's button: the run goes on in the Automations chat.
    await tgPost(telegramButton(Number(u.chatId), `apr:${a!.id}:yes`));
    await waitFor(async () => (editsIn(u.chatId).length ? true : null));
    const [turn] = await waitFor(async () => (answerTurns(u.id).length ? answerTurns(u.id) : null));
    expect(turn!.sessionKey).toBe('web');
    // A late tap: told so on Telegram, and still no conversation there.
    await tgPost(telegramButton(Number(u.chatId), `apr:${a!.id}:no`));
    await waitFor(async () =>
      sentTo(u.chatId).find((c) => String(c.body.text).includes('already answered')),
    );
    await settle();
    expect(await telegramConversations(u)).toEqual([]);
    expect((await listed(u)).map((c) => c.channel)).not.toContain('telegram');
    expect(await telegramRows(u.id)).toHaveLength(1);

    // A message the user types on Telegram goes to the Telegram chat's conversation, as before.
    await tgPost(telegramUpdate(Number(u.chatId), 'what else is new?'));
    const [own] = await waitFor(async () => {
      const rows = await telegramConversations(u);
      return rows.length ? rows : null;
    });
    expect(own).toMatchObject({ epoch: 0, active: true, kind: 'chat' });
    await waitFor(async () =>
      (await shownIn(u, own!.id)).some((m) => m.text === 'ok') ? true : null,
    );
    expect((await shownIn(u, own!.id)).map((m) => m.text)).toEqual(['ok', 'what else is new?']);
    const telegramListed = (await listed(u)).filter((c) => c.channel === 'telegram');
    expect(telegramListed.map((c) => [c.id, c.title])).toEqual([[own!.id, 'what else is new?']]);
  });

  it('the chat list leaves out a Telegram conversation with nothing said in it, or only old copies', async () => {
    const u = await person();
    const sessionKey = `telegram:${u.chatId}`;
    // "/new" on Telegram: an empty conversation.
    const { conversation: empty } = await startConversation(u.id, sessionKey);
    // Before this fix, a copy was saved in the Telegram chat's conversation.
    await db()
      .insert(messages)
      .values({
        id: newId('msg'),
        userId: u.id,
        conversationId: empty.id,
        channel: 'telegram',
        direction: 'out',
        text: 'an old copy',
        status: 'sent',
        sessionKey,
        copyOf: `msg_${randomUUID().replace(/-/g, '')}`,
      });
    const ids = async () => (await listed(u)).map((c) => c.id);
    expect(await ids()).not.toContain(empty.id);
    // An empty web conversation (the new chat the user is about to write in) is still listed.
    const { conversation: web } = await startConversation(u.id, 'web');
    expect(await ids()).toContain(web.id);
    // The user writes on Telegram: the conversation is listed, without the old copy.
    await saveInbound({
      userId: u.id,
      channel: 'telegram',
      text: 'hello',
      eventId: `evt_${randomUUID()}`,
      sessionKey,
    });
    expect(await ids()).toContain(empty.id);
    expect((await shownIn(u, empty.id)).map((m) => m.text)).toEqual(['hello']);
  });

  it('says how each approval ended', () => {
    expect(approvalEndNote('approved', 'web')).toBe('✅ Approved on web');
    expect(approvalEndNote('rejected', 'telegram:button')).toBe('❌ Denied on Telegram');
    expect(approvalEndNote('replaced')).toBe('Replaced by a newer request.');
    expect(approvalEndNote('expired')).toBe('Expired: no answer came in time.');
    expect(approvalEndNote('expired', 'admin')).toBe('Cancelled by Textcrew support.');
  });
});

/** The Telegram message id of the approval's message on Telegram. */
async function sentMessageId(u: TestUser, approvalId: string): Promise<string | null> {
  const [row] = await db()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.userId, u.id),
        eq(messages.approvalId, approvalId),
        eq(messages.channel, 'telegram'),
      ),
    );
  return row?.externalId ?? null;
}
