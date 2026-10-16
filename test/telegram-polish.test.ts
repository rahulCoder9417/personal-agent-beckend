// Telegram polish: the bot's "/" menu (setMyCommands, set at api start only when it differs),
// `/help` answered by us (no turn, no credits), the "Linked!" reply that names `/new` and the
// Help page, and app actions that failed or were refused, in the activity log without inputs.
import { randomUUID } from 'node:crypto';
import type { Job, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { channelLinks } from '../src/modules/auth/schema.ts';
import { creditLedger } from '../src/modules/billing/schema.ts';
import { setTelegramApi } from '../src/modules/channels/adapters/telegram.ts';
import { messages } from '../src/modules/channels/schema.ts';
import {
  BOT_COMMANDS,
  syncTelegramCommands,
  syncTelegramCommandsAtStart,
} from '../src/modules/channels/telegram-commands.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { events } from '../src/modules/events/schema.ts';
import type { ComposioTool } from '../src/modules/integrations/composio.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { NEW_CHAT_TEXT } from '../src/modules/orchestrator/chats.ts';
import {
  helpPageUrl,
  helpText,
  isHelpCommand,
  linkedText,
} from '../src/modules/orchestrator/help-command.ts';
import { handleProcessMessage } from '../src/modules/orchestrator/process-message.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
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
import { call, chatUser, createUser, expectContract, waitFor } from './helpers.ts';

let workers: Worker[];
let vm: ReturnType<typeof installFakeVm>;
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
  vm = installFakeVm(async (d, mcp) => {
    await mcp('send_message', {
      text: `re: ${d.text.split('\n').at(-1)}`,
      session_key: d.sessionKey,
    });
  });
  tg = installFakeTelegram();
});

const chat = () => Math.floor(Math.random() * 1e9);

async function sendTelegram(chatId: number, text: string) {
  const update = telegramUpdate(chatId, text);
  await expectContract(
    'webhookTelegram',
    await call('/webhooks/telegram', {
      method: 'POST',
      body: update,
      headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
    }),
    200,
  );
  return update;
}

async function linkedTelegram(userId: string): Promise<number> {
  const chatId = chat();
  await db()
    .insert(channelLinks)
    .values({
      id: newId('chl'),
      userId,
      channel: 'telegram',
      externalId: String(chatId),
      displayId: '@u',
    });
  return chatId;
}

const eventDone = (updateId: number) =>
  waitFor(async () => {
    const [row] = await db()
      .select()
      .from(events)
      .where(eq(events.externalId, String(updateId)));
    return row && ['done', 'ignored', 'failed'].includes(row.status) ? row : undefined;
  });

describe('the bot\'s "/" menu (setMyCommands)', () => {
  /** A Telegram that keeps the menu it is given, and every call made to it. */
  function fakeMenu(initial: unknown = []) {
    const state = { commands: initial, calls: [] as string[] };
    setTelegramApi(async (method, body) => {
      state.calls.push(method);
      if (method === 'getMyCommands') return state.commands as Record<string, unknown>;
      if (method === 'setMyCommands') {
        state.commands = body.commands;
        return true as unknown as Record<string, unknown>;
      }
      throw new Error(`unexpected ${method}`);
    });
    return state;
  }
  const withEnv = (env: Record<string, string>) => {
    Object.assign(process.env, env);
    resetConfig();
  };
  beforeEach(() =>
    withEnv({ TELEGRAM_BOT_TOKEN: '123:menu-test', ENABLED_CHANNELS: 'telegram,web' }),
  );
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.ENABLED_CHANNELS;
    resetConfig();
  });

  it('lists /new and /help only; /clear and /reset still work but are left out', () => {
    expect(BOT_COMMANDS).toEqual([
      { command: 'new', description: 'Start a new conversation' },
      { command: 'help', description: 'How Textcrew works' },
    ]);
  });

  it('sets the menu once, and leaves it alone when Telegram already has it', async () => {
    const tgMenu = fakeMenu([{ command: 'start', description: 'old' }]);
    expect(await syncTelegramCommands()).toBe('set');
    expect(tgMenu.commands).toEqual(BOT_COMMANDS);
    expect(await syncTelegramCommands()).toBe('unchanged');
    expect(await syncTelegramCommands()).toBe('unchanged');
    expect(tgMenu.calls).toEqual([
      'getMyCommands',
      'setMyCommands',
      'getMyCommands',
      'getMyCommands',
    ]);
  });

  it('sets it again when a description changed', async () => {
    const tgMenu = fakeMenu([
      { command: 'new', description: 'Start a new conversation' },
      { command: 'help', description: 'Help' },
    ]);
    expect(await syncTelegramCommands()).toBe('set');
    expect(tgMenu.commands).toEqual(BOT_COMMANDS);
  });

  it('does nothing when Telegram is off or has no bot token', async () => {
    const tgMenu = fakeMenu();
    withEnv({ ENABLED_CHANNELS: 'web' });
    expect(await syncTelegramCommands()).toBe('skipped');
    withEnv({ ENABLED_CHANNELS: 'telegram,web' });
    delete process.env.TELEGRAM_BOT_TOKEN;
    resetConfig();
    expect(await syncTelegramCommands()).toBe('skipped');
    expect(tgMenu.calls).toEqual([]);
  });

  it('at api start, a Telegram that fails does not stop the api', async () => {
    setTelegramApi(async () => {
      throw new Error('telegram getMyCommands failed: 502');
    });
    await expect(syncTelegramCommandsAtStart()).resolves.toBeUndefined();
  });
});

describe('/help in Telegram', () => {
  it('accepts /help and /help@<bot>, alone; nothing else', () => {
    for (const t of ['/help', ' /HELP ', '/help@textcrew_bot'])
      expect(isHelpCommand(t), t).toBe(true);
    for (const t of ['help', '/help me', '/helper', 'please /help', '/help@', '/new'])
      expect(isHelpCommand(t), t).toBe(false);
  });

  it('says what Tex can do, the commands, and links the Help page', () => {
    const text = helpText();
    expect(helpPageUrl()).toBe('http://web.test/help');
    for (const part of ['/new', '/help', 'Both are free', 'More help: http://web.test/help'])
      expect(text).toContain(part);
    // Telegram shows it as it is: plain text.
    expect(text).not.toMatch(/[*_`#[]/);
  });

  it('answers with no turn, nothing saved and no credits, even at zero credits', async () => {
    const user = await createUser(); // no credits
    await ensureSandbox(user.id);
    const chatId = await linkedTelegram(user.id);
    const ledgerBefore = await db()
      .select()
      .from(creditLedger)
      .where(eq(creditLedger.userId, user.id));
    const update = await sendTelegram(chatId, '/help');
    await eventDone(update.update_id);
    const reply = await waitFor(async () => tg.sent.find((m) => m.chatId === String(chatId)));
    expect(reply.text).toBe(helpText());
    await sendTelegram(chatId, '/help@agent_bot');
    await waitFor(async () => tg.sent.filter((m) => m.chatId === String(chatId)).length === 2);

    expect(vm.deliveries.filter((d) => d.userId === user.id)).toHaveLength(0);
    expect(await db().select().from(messages).where(eq(messages.userId, user.id))).toHaveLength(0);
    expect(await db().select().from(creditLedger).where(eq(creditLedger.userId, user.id))).toEqual(
      ledgerBefore,
    );
  });

  it('the same event run again answers once', async () => {
    const user = await chatUser();
    const chatId = await linkedTelegram(user.id);
    const update = await sendTelegram(chatId, '/help');
    const event = await eventDone(update.update_id);
    await waitFor(async () => tg.sent.find((m) => m.chatId === String(chatId)));
    await handleProcessMessage({ data: { eventId: event.id } } as Job);
    await new Promise((r) => setTimeout(r, 300));
    expect(tg.sent.filter((m) => m.chatId === String(chatId))).toHaveLength(1);
  });

  it('from a chat that is not linked, it only gets the link instructions', async () => {
    const chatId = chat();
    await sendTelegram(chatId, '/help');
    const reply = await waitFor(async () => tg.sent.find((m) => m.chatId === String(chatId)));
    expect(reply.text).toContain("isn't linked");
    expect(tg.sent.some((m) => m.text === helpText())).toBe(false);
  });
});

describe('the "Linked!" reply', () => {
  it('names /new and the Help page on Telegram; only the Help page where /new does not work', () => {
    expect(linkedText('telegram')).toBe(
      '✅ Linked! You can chat with your agent right here. What can I do for you?\n\n' +
        'Send /new any time to start a fresh conversation. How Textcrew works: http://web.test/help',
    );
    expect(linkedText('whatsapp')).toBe(
      '✅ Linked! You can chat with your agent right here. What can I do for you?\n\n' +
        'How Textcrew works: http://web.test/help',
    );
  });

  it('is what a newly linked Telegram chat gets', async () => {
    const u = await chatUser();
    const chatId = chat();
    const lc = (await (
      await call('/v1/channels/link-codes', {
        method: 'POST',
        token: u.token,
        body: { channel: 'telegram' },
      })
    ).json()) as { code: string };
    await sendTelegram(chatId, lc.code);
    const reply = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('✅')),
    );
    expect(reply.text).toBe(linkedText('telegram'));
    // And /new still answers as before.
    await sendTelegram(chatId, '/new');
    await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.text === NEW_CHAT_TEXT),
    );
  });
});

describe('app actions that failed or were refused are in the activity log', () => {
  const SEND = 'GMAIL_SEND_EMAIL';
  const SECRET_INPUT = 'private-recipient-7c1f@example.com';
  const GMAIL_TOOLS: ComposioTool[] = [
    {
      slug: SEND,
      toolkit: 'gmail',
      name: 'Send Email',
      description: 'Sends an email',
      tags: [],
      inputParameters: {
        type: 'object',
        properties: {
          recipient_email: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
      },
    },
    {
      slug: 'GMAIL_LIST_EMAILS',
      toolkit: 'gmail',
      name: 'List',
      description: 'List emails',
      tags: ['readOnlyHint'],
      inputParameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  ];
  let composio: Awaited<ReturnType<typeof installFakeComposio>>;
  beforeEach(async () => {
    composio = await installFakeComposio();
    composio.state.tools.set('gmail', GMAIL_TOOLS);
  });

  async function agentOf(opts: { gmail: boolean }) {
    const user = await chatUser();
    if (opts.gmail)
      await db()
        .insert(connections)
        .values({
          id: newId('con'),
          userId: user.id,
          app: 'gmail',
          composioAccountId: `ca_${randomUUID()}`,
          status: 'active',
        });
    await ensureSandbox(user.id);
    const token = vm.tokens.get(user.id)!;
    return {
      user,
      mcp: (tool: string, args: Record<string, unknown>) => mcpCall(token, tool, args),
    };
  }

  const entries = (userId: string, action: string) =>
    db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, action)));

  /** Every entry of the user, as text: none of them may hold an input. */
  const allText = async (userId: string) =>
    JSON.stringify(await db().select().from(auditLog).where(eq(auditLog.userId, userId)));

  it('an app that is not connected: the action, the app and why, never the inputs', async () => {
    const { user, mcp } = await agentOf({ gmail: false });
    const r = await mcp('run_app_action', {
      action: 'GMAIL_LIST_EMAILS',
      arguments: { query: SECRET_INPUT },
    });
    expect(r.isError).toBe(true);
    const [entry] = await waitFor(async () => {
      const rows = await entries(user.id, 'app_action_failed');
      return rows.length ? rows : undefined;
    });
    expect(entry).toMatchObject({
      actor: 'agent',
      summary: "Couldn't run GMAIL_LIST_EMAILS in Gmail: the app isn't connected",
      details: { action: 'GMAIL_LIST_EMAILS', app: 'gmail', reason: "the app isn't connected" },
      creditsCharged: 0,
    });
    expect(await allText(user.id)).not.toContain(SECRET_INPUT);
  });

  it('refused for want of an approval, and an app that returned an error', async () => {
    const { user, mcp } = await agentOf({ gmail: true });
    const args = { recipient_email: SECRET_INPUT, subject: 'Hi', body: 'Hello' };
    expect((await mcp('run_app_action', { action: SEND, arguments: args })).isError).toBe(true);

    composio.state.executeFailure = `Invalid recipient ${SECRET_INPUT}`;
    const failed = await mcp('run_app_action', {
      action: 'GMAIL_LIST_EMAILS',
      arguments: { query: SECRET_INPUT },
    });
    expect(failed.isError).toBe(true);
    // The agent still gets the app's own error; the log only that it refused.
    expect(failed.text).toContain('Invalid recipient');

    const rows = await waitFor(async () => {
      const r = await entries(user.id, 'app_action_failed');
      return r.length === 2 ? r : undefined;
    });
    expect(rows.map((e) => e.summary).sort()).toEqual([
      "Couldn't run GMAIL_LIST_EMAILS in Gmail: the app returned an error",
      "Couldn't run GMAIL_SEND_EMAIL in Gmail: it needs your approval, and none was given",
    ]);
    expect(await allText(user.id)).not.toContain(SECRET_INPUT);
    // A successful action is still logged as before.
    expect((await mcp('run_app_action', { action: 'GMAIL_LIST_EMAILS' })).isError).toBe(false);
    await waitFor(async () => (await entries(user.id, 'run_app_action')).length === 1);
  });

  it('a request for approval whose details do not fit the action', async () => {
    const { user, mcp } = await agentOf({ gmail: true });
    const r = await mcp('request_approval', {
      summary: 'Email a friend',
      session_key: 'web',
      action: SEND,
      arguments: { to: SECRET_INPUT, subject: 'Hi' },
    });
    expect(r.isError).toBe(true);
    const [entry] = await waitFor(async () => {
      const rows = await entries(user.id, 'approval_request_refused');
      return rows.length ? rows : undefined;
    });
    expect(entry).toMatchObject({
      actor: 'agent',
      summary:
        "Couldn't ask for approval to run GMAIL_SEND_EMAIL in Gmail: its details didn't fit the action, so you weren't asked",
      details: {
        action: SEND,
        app: 'gmail',
        reason: "its details didn't fit the action, so you weren't asked",
      },
    });
    expect(await allText(user.id)).not.toContain(SECRET_INPUT);
    expect(await allText(user.id)).not.toContain('Email a friend');
  });

  it('the activity endpoint lists them', async () => {
    const { user, mcp } = await agentOf({ gmail: false });
    await mcp('run_app_action', { action: 'GMAIL_LIST_EMAILS' });
    await waitFor(async () => (await entries(user.id, 'app_action_failed')).length === 1);
    const page = await expectContract<{ items: Array<{ action: string; summary: string }> }>(
      'listActivity',
      await call('/v1/activity', { token: user.token }),
      200,
    );
    expect(page.items.map((e) => e.action)).toContain('app_action_failed');
  });
});
