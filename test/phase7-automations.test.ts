import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DeliverEventType, DeliverKind } from '../proto-gen/vm/v1/vm_pb.ts';
import { automations } from '../src/modules/automations/schema.ts';
import { findAutomationsChat } from '../src/modules/channels/conversations.ts';
import { messages } from '../src/modules/channels/schema.ts';
import {
  createAutomation,
  reregisterAll,
  setMinIntervalMs,
} from '../src/modules/automations/automations.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { setTurnHooks } from '../src/modules/orchestrator/turn.ts';
import { setVmClient, type VmClient } from '../src/modules/orchestrator/vm.ts';
import { config } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { redis } from '../src/shared/redis.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  installFakeComposio,
  installFakeTelegram,
  installFakeVm,
  mcpCall,
  telegramUpdate,
  type SentTelegram,
} from './fakes.ts';
import { call, chatUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[] = [];
let tg: { sent: SentTelegram[] };
let vmFake: ReturnType<typeof installFakeVm>;

const start = () => {
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
};
const stop = async () => {
  await Promise.all(workers.map((w) => w.close()));
  workers = [];
};
/** "Redis wipe": delete every BullMQ key of this test file's prefix. */
async function wipeQueues() {
  const keys = await redis().keys(`${config().QUEUE_PREFIX}:*`);
  if (keys.length) await redis().del(...keys);
}

beforeAll(() => {
  wireModules();
  setMinIntervalMs(1000);
  start();
});
afterAll(async () => {
  await stop();
  await closeQueues();
});
beforeEach(async () => {
  tg = installFakeTelegram();
  await installFakeComposio();
  setTurnHooks({ hasCredits: async () => true });
  // The fake agent announces what it was asked to do.
  vmFake = installFakeVm(async (d, mcp) => {
    const tag =
      d.kind === DeliverKind.AUTOMATION
        ? 'AUTO'
        : d.kind === DeliverKind.APP_EVENT
          ? 'EVENT'
          : 'MSG';
    await mcp('send_message', { text: `${tag}: ${d.text}`, session_key: d.sessionKey });
  });
});

const chat = () => Math.floor(Math.random() * 1e9);
const tgPost = (update: unknown) =>
  call('/webhooks/telegram', {
    method: 'POST',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
  });

async function linkedUser(plan: 'free' | 'pro' | 'max' = 'pro') {
  const user = await chatUser({ plan } as never);
  const chatId = chat();
  const lc = (await (
    await call('/v1/channels/link-codes', {
      method: 'POST',
      token: user.token,
      body: { channel: 'telegram' },
    })
  ).json()) as { code: string };
  await tgPost(telegramUpdate(chatId, lc.code));
  await waitFor(async () =>
    tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('✅')),
  );
  return { ...user, chatId, sessionKey: `telegram:${chatId}` };
}

/**
 * The copies of a run's answer sent to Telegram. A run answers in the Automations chat; made in a
 * Telegram chat, a copy goes there, its first line naming the automation.
 */
const fired = (title: string) =>
  tg.sent.filter((m) => m.text.includes('\n\nAUTO: ') && m.text.includes(title));

/** What the user's Automations chat holds. */
async function automationsChatTexts(userId: string): Promise<string[]> {
  const chat = await findAutomationsChat(userId);
  if (!chat) return [];
  const rows = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.conversationId, chat.id)))
    .orderBy(messages.id);
  return rows.map((m) => m.text);
}

describe('Phase 7: automations and reminders', () => {
  it('the agent schedules a reminder with a tool and it fires once, to the right chat', async () => {
    const u = await linkedUser();
    vmFake.state.agent = async (d, mcp) => {
      if (d.kind === DeliverKind.MESSAGE) {
        const r = await mcp('schedule_reminder', {
          text: 'call mom',
          run_at: new Date(Date.now() + 1500).toISOString(),
          session_key: d.sessionKey,
        });
        expect(r.isError).toBeFalsy();
        await mcp('send_message', { text: 'OK, I will remind you.', session_key: d.sessionKey });
      } else {
        await mcp('send_message', { text: `AUTO: ${d.text}`, session_key: d.sessionKey });
      }
    };
    await tgPost(telegramUpdate(u.chatId, 'remind me to call mom in a moment'));
    await waitFor(async () => tg.sent.find((m) => m.text === 'OK, I will remind you.'));
    const reminder = await waitFor(async () => fired('call mom')[0], 15_000);
    expect(reminder.chatId).toBe(String(u.chatId));
    expect(reminder.text.split('\n')[0]).toBe('⏰ Reminder: call mom');
    expect(reminder.text).toMatch(
      /To follow up, open the Automations chat in the Textcrew web app/,
    );
    await new Promise((r) => setTimeout(r, 1000));
    expect(fired('call mom')).toHaveLength(1);
    // The run itself answered in the Automations chat.
    const [answer] = await automationsChatTexts(u.id);
    expect(answer).toMatch(/^AUTO: .*\[Automation "Reminder: call mom"\]/s);
    const [row] = await db().select().from(automations).where(eq(automations.userId, u.id));
    expect(row!.completedAt).not.toBeNull();
  });

  it('a once automation fires across a worker restart and a Redis wipe', async () => {
    const u = await linkedUser();
    await createAutomation({
      userId: u.id,
      title: 'restart-once',
      instruction: 'say hi',
      sessionKey: u.sessionKey,
      runAt: new Date(Date.now() + 2500),
    });
    await stop();
    await wipeQueues();
    start();
    await reregisterAll();
    await waitFor(async () => fired('restart-once')[0], 15_000);
    await new Promise((r) => setTimeout(r, 800));
    expect(fired('restart-once')).toHaveLength(1);
  });

  it('a repeating automation keeps firing across a Redis wipe, and stops when deleted', async () => {
    const u = await linkedUser();
    const a = await createAutomation({
      userId: u.id,
      title: 'every-2s',
      instruction: 'tick',
      sessionKey: u.sessionKey,
      cron: '*/2 * * * * *',
      timezone: 'Asia/Kolkata',
    });
    await waitFor(async () => fired('every-2s').length >= 2, 15_000);
    await stop();
    await wipeQueues();
    const before = fired('every-2s').length;
    start();
    await reregisterAll();
    await waitFor(async () => fired('every-2s').length >= before + 2, 15_000);
    await expectContract(
      'deleteAutomation',
      await call(`/v1/automations/${a.id}`, { method: 'DELETE', token: u.token }),
      204,
    );
    await new Promise((r) => setTimeout(r, 2500));
    const after = fired('every-2s').length;
    await new Promise((r) => setTimeout(r, 3000));
    expect(fired('every-2s').length).toBe(after);
  });

  it('an app-event automation fires from a Composio trigger, only for its owner', async () => {
    const u = await linkedUser();
    await db()
      .insert(connections)
      .values({
        id: newId('con'),
        userId: u.id,
        app: 'gmail',
        composioAccountId: `ca_${randomUUID()}`,
        status: 'active',
      });
    let draftId = '';
    vmFake.state.agent = async (d, mcp) => {
      if (d.kind === DeliverKind.MESSAGE) {
        const r = await mcp('propose_automation', {
          title: 'boss mail',
          instruction: 'Summarise the email from my boss',
          trigger: { app: 'gmail', event: 'GMAIL_NEW_GMAIL_MESSAGE' },
          apps: ['gmail'],
          session_key: d.sessionKey,
        });
        expect(r.isError).toBeFalsy();
        draftId = (JSON.parse(r.text) as { draft_id: string }).draft_id;
      } else if (d.kind === DeliverKind.APP_EVENT) {
        await mcp('send_message', { text: `EVENT: ${d.text}`, session_key: d.sessionKey });
      }
    };
    await tgPost(telegramUpdate(u.chatId, 'when my boss emails me, summarise it'));
    // Tex proposed it; nothing watches the app until the user saves it (here, in the web app).
    await waitFor(async () => draftId);
    expect(await db().select().from(automations).where(eq(automations.userId, u.id))).toEqual([]);
    const saved = await call(`/v1/automation-drafts/${draftId}/save`, {
      method: 'POST',
      token: u.token,
      body: {},
    });
    expect(saved.status).toBe(200);
    const [a] = await waitFor(async () => {
      const rows = await db().select().from(automations).where(eq(automations.userId, u.id));
      return rows.length ? rows : undefined;
    });
    expect(a!.kind).toBe('event');
    const webhook = (userId: string) => ({
      kind: 'trigger',
      event: {
        triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
        toolkit: 'gmail',
        userId,
        connectedAccountId: null,
        triggerId: a!.triggerRef,
        payload: { from: 'boss@acme.com', subject: 'Q3' },
      },
    });
    // A trigger payload claiming another user is ignored.
    await call('/webhooks/composio', {
      method: 'POST',
      body: webhook('usr_someone_else'),
      headers: {
        'webhook-signature': 'valid',
        'webhook-id': `w-${randomUUID()}`,
        'webhook-timestamp': '1',
      },
    });
    await call('/webhooks/composio', {
      method: 'POST',
      body: webhook(u.id),
      headers: {
        'webhook-signature': 'valid',
        'webhook-id': `w-${randomUUID()}`,
        'webhook-timestamp': '1',
      },
    });
    const ev = await waitFor(async () => tg.sent.find((m) => m.text.includes('\n\nEVENT: ')));
    expect(ev.text).toContain('boss@acme.com');
    expect(ev.text.split('\n')[0]).toBe('⚡ boss mail');
    await new Promise((r) => setTimeout(r, 500));
    expect(tg.sent.filter((m) => m.text.includes('EVENT:'))).toHaveLength(1);
    expect(await automationsChatTexts(u.id)).toEqual([
      expect.stringMatching(/^EVENT: .*boss@acme\.com/s),
    ]);
  });

  it('pauses at 0 credits', async () => {
    const u = await linkedUser();
    await createAutomation({
      userId: u.id,
      title: 'broke',
      instruction: 'x',
      sessionKey: u.sessionKey,
      runAt: new Date(Date.now() + 500),
    });
    setTurnHooks({ hasCredits: async () => false });
    const row = await waitFor(async () => {
      const [r] = await db().select().from(automations).where(eq(automations.userId, u.id));
      return r?.pausedReason === 'out_of_credits' ? r : undefined;
    });
    expect(row.enabled).toBe(false);
    expect(fired('broke')).toHaveLength(0);
    // The notice is in the Automations chat, and a copy goes to Telegram (with no purchase link).
    const copy = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(u.chatId) && m.text.includes('out of credits')),
    );
    expect(copy.text.split('\n')[0]).toBe('⏰ broke');
    expect(copy.text).not.toContain('/billing');
    expect(await automationsChatTexts(u.id)).toEqual([
      expect.stringContaining("You're out of credits"),
    ]);
  });

  it('pauses after 3 failures in a row', async () => {
    const u = await linkedUser();
    setVmClient(makeFailingVm());
    const a = await createAutomation({
      userId: u.id,
      title: 'flaky',
      instruction: 'x',
      sessionKey: u.sessionKey,
      cron: '*/2 * * * * *',
    });
    const row = await waitFor(async () => {
      const [r] = await db().select().from(automations).where(eq(automations.id, a.id));
      return r?.pausedReason === 'failures' ? r : undefined;
    }, 20_000);
    expect(row.failCount).toBeGreaterThanOrEqual(3);
    const copy = await waitFor(async () =>
      tg.sent.find((m) => m.text.includes('paused the automation "flaky"')),
    );
    expect(copy.text.split('\n')[0]).toBe('⏰ flaky');
    // The notice itself is in the Automations chat.
    expect(await automationsChatTexts(u.id)).toContain(
      'I paused the automation "flaky" because it failed 3 times in a row. You can resume it in the web app.',
    );
  });

  it('enforces plan limits, the 15-minute minimum and valid timezones', async () => {
    const u = await linkedUser('free');
    // Free allows 1 automation (Pro 5, Max 50).
    for (let i = 0; i < 1; i++) {
      await createAutomation({
        userId: u.id,
        title: `r${i}`,
        instruction: 'x',
        sessionKey: u.sessionKey,
        runAt: new Date(Date.now() + 3600_000),
      });
    }
    await expect(
      createAutomation({
        userId: u.id,
        title: 'r4',
        instruction: 'x',
        sessionKey: u.sessionKey,
        runAt: new Date(Date.now() + 3600_000),
      }),
    ).rejects.toThrow(/allows 1/);
    setMinIntervalMs(15 * 60 * 1000);
    try {
      const p = await linkedUser('pro');
      await expect(
        createAutomation({
          userId: p.id,
          title: 'fast',
          instruction: 'x',
          sessionKey: p.sessionKey,
          cron: '*/5 * * * *',
        }),
      ).rejects.toThrow(/15 minutes/);
      await expect(
        createAutomation({
          userId: p.id,
          title: 'tz',
          instruction: 'x',
          sessionKey: p.sessionKey,
          cron: '0 9 * * 1',
          timezone: 'Mars/Base',
        }),
      ).rejects.toThrow(/timezone/);
      const ok = await createAutomation({
        userId: p.id,
        title: 'monday',
        instruction: 'plan my week',
        sessionKey: p.sessionKey,
        cron: '0 9 * * 1',
        timezone: 'Asia/Kolkata',
      });
      expect(ok.nextRunAt!.getUTCHours()).toBe(3);
      expect(ok.nextRunAt!.getUTCMinutes()).toBe(30);

      const list = await expectContract<{ items: Array<{ id: string; enabled: boolean }> }>(
        'listAutomations',
        await call('/v1/automations', { token: p.token }),
        200,
      );
      expect(list.items.map((i) => i.id)).toContain(ok.id);
      const paused = await expectContract<{ enabled: boolean; pausedReason: string }>(
        'updateAutomation',
        await call(`/v1/automations/${ok.id}`, {
          method: 'PATCH',
          token: p.token,
          body: { enabled: false },
        }),
        200,
      );
      expect(paused).toMatchObject({ enabled: false, pausedReason: 'user' });
      await expectContract(
        'updateAutomation',
        await call(`/v1/automations/${ok.id}`, {
          method: 'PATCH',
          token: u.token,
          body: { enabled: true },
        }),
        404,
      );
      await expectContract(
        'updateAutomation',
        await call(`/v1/automations/${ok.id}`, { method: 'PATCH', token: p.token, body: {} }),
        400,
      );
      // Tools see only the caller's automations.
      const token =
        vmFake.tokens.get(p.id) ??
        (await (async () => {
          await tgPost(telegramUpdate(p.chatId, 'hi'));
          return waitFor(async () => vmFake.tokens.get(p.id));
        })());
      const mine = JSON.parse((await mcpCall(token, 'list_automations', {})).text) as Array<{
        id: string;
      }>;
      expect(mine.map((m) => m.id)).toContain(ok.id);
      const theirs = await mcpCall(token, 'cancel_automation', {
        automation_id: (
          await db().select().from(automations).where(eq(automations.userId, u.id))
        )[0]!.id,
      });
      expect(theirs.isError).toBe(true);
    } finally {
      setMinIntervalMs(1000);
    }
  });
});

function makeFailingVm(): VmClient {
  return {
    async createSandbox() {
      return { sandbox: {}, mcpTokenHash: `h-${randomUUID()}` };
    },
    async wakeSandbox() {
      return { sandbox: {}, wasStopped: false };
    },
    async *deliver() {
      yield { type: DeliverEventType.ACCEPTED, message: '', platformFault: false };
      yield { type: DeliverEventType.ERROR, message: 'tool broke', platformFault: false };
    },
    async touch() {
      return {};
    },
  } as unknown as VmClient;
}
