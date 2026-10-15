// "typing…" in a Telegram chat while the agent works on a message from it: shown at once, kept up
// while the agent works, never shown again under the answer, nothing for web chat, and a failing
// call never fails the turn.
import type { Worker } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setTelegramApi, telegramApi } from '../src/modules/channels/adapters/telegram.ts';
import { setTypingTiming } from '../src/modules/channels/typing.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { decideApproval, requestApproval } from '../src/modules/orchestrator/approvals.ts';
import { resetConfig } from '../src/shared/config.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  installFakeTelegram,
  installFakeVm,
  telegramUpdate,
  type AgentBehaviour,
  type TelegramCall,
} from './fakes.ts';
import { call, chatUser, waitFor } from './helpers.ts';

/** Shorter than the real 4 s and 6 s. The quiet time is kept well above the time a turn takes to
 * end after its answer (on the server about 1 to 2 s against 6 s). */
const REFRESH = 100;
const QUIET = 600;

let workers: Worker[];
let tg: ReturnType<typeof installFakeTelegram>;
let vm: ReturnType<typeof installFakeVm>;

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  setTypingTiming();
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  setTypingTiming({ refreshMs: REFRESH, quietMs: QUIET });
  tg = installFakeTelegram();
  vm = installFakeVm();
});
afterEach(() => {
  delete process.env.TELEGRAM_TYPING;
  resetConfig();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sendTelegram(update: unknown) {
  return call('/webhooks/telegram', {
    method: 'POST',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
  });
}

async function linkedChat() {
  const user = await chatUser({ credits: 5000 });
  const chatId = 900_000_000 + Math.floor(Math.random() * 1e8);
  const { code } = (await (
    await call('/v1/channels/link-codes', {
      method: 'POST',
      token: user.token,
      body: { channel: 'telegram' },
    })
  ).json()) as { code: string };
  await sendTelegram(telegramUpdate(chatId, code));
  await waitFor(async () =>
    tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('✅ Linked')),
  );
  return { user, chatId };
}

const typingIn = (chatId: number, after = 0): TelegramCall[] =>
  tg.calls.filter(
    (c) =>
      c.method === 'sendChatAction' &&
      c.chatId === String(chatId) &&
      c.action === 'typing' &&
      c.at > after,
  );
/** When the bot's message with this text reached the Bot API (waits until it has). */
async function sentAt(chatId: number, text: string): Promise<number> {
  await waitFor(async () => tg.sent.find((m) => m.chatId === String(chatId) && m.text === text));
  const i = tg.sent.findIndex((m) => m.chatId === String(chatId) && m.text === text);
  const calls = tg.calls.filter((c) => c.method === 'sendMessage');
  // `sent` and the sendMessage calls are in the same order.
  return calls[tg.sent.slice(0, i + 1).length - 1]!.at;
}

/** Waits until the inbound job of the next message ends (the turn is over). */
function nextInboundDone(name = 'process-message'): Promise<void> {
  const inbound = workers.find((w) => w.name === 'inbound')!;
  return new Promise((resolve) => {
    const onDone = (job: { name: string }) => {
      if (job.name !== name) return;
      inbound.off('completed', onDone);
      resolve();
    };
    inbound.on('completed', onDone);
  });
}

describe('"typing…" on Telegram', () => {
  it('shows at once, again while the agent works, and never under the answer', async () => {
    const { chatId } = await linkedChat();
    let deliveredAt = 0;
    vm.state.agent = (async (d, mcp) => {
      deliveredAt = performance.now();
      await sleep(5 * REFRESH);
      await mcp('send_message', { text: 'Your day is free', session_key: d.sessionKey });
      // The turn goes on a little after the answer (the Bridge and the vm-manager end it).
      await sleep(2 * REFRESH);
    }) satisfies AgentBehaviour;

    const start = performance.now();
    const done = nextInboundDone();
    await sendTelegram(telegramUpdate(chatId, 'am I free today?'));
    await done;
    const answerAt = await sentAt(chatId, 'Your day is free');
    await sleep(3 * REFRESH);

    const typing = typingIn(chatId, start);
    // The first one before the agent even had the message.
    expect(typing[0]!.at).toBeLessThan(deliveredAt);
    // Kept up while the agent worked (5 refreshes' time).
    expect(typing.filter((c) => c.at < answerAt).length).toBeGreaterThanOrEqual(4);
    // None after the answer: not while the turn ended, not after it.
    expect(typingIn(chatId, answerAt)).toHaveLength(0);
  });

  it('pauses after a message in the middle of a turn, and comes back while the work goes on', async () => {
    const { chatId } = await linkedChat();
    vm.state.agent = (async (d, mcp) => {
      await mcp('send_message', { text: 'On it, checking 3 calendars', session_key: d.sessionKey });
      await sleep(QUIET + 4 * REFRESH);
      await mcp('send_message', { text: 'All three are free', session_key: d.sessionKey });
    }) satisfies AgentBehaviour;

    const done = nextInboundDone();
    await sendTelegram(telegramUpdate(chatId, 'check all my calendars'));
    await done;
    const updateAt = await sentAt(chatId, 'On it, checking 3 calendars');
    const answerAt = await sentAt(chatId, 'All three are free');

    const between = typingIn(chatId, updateAt).filter((c) => c.at < answerAt);
    // Not right after the update…
    expect(between.filter((c) => c.at < updateAt + QUIET - 50)).toHaveLength(0);
    // …but again once the quiet time was over, while the agent still worked.
    expect(between.length).toBeGreaterThanOrEqual(1);
    expect(typingIn(chatId, answerAt)).toHaveLength(0);
  });

  it("the agent's answer to an approval in a Telegram chat shows it too", async () => {
    const { user, chatId } = await linkedChat();
    vm.state.agent = (async (d, mcp) => {
      await sleep(3 * REFRESH);
      await mcp('send_message', { text: 'Sent it', session_key: d.sessionKey });
    }) satisfies AgentBehaviour;
    const approval = await requestApproval({
      userId: user.id,
      sessionKey: `telegram:${chatId}`,
      summary: 'Email Priya the notes',
    });

    const start = performance.now();
    const done = nextInboundDone('process-approval');
    await decideApproval(user.id, approval.id, true, 'web');
    await done;
    const answerAt = await sentAt(chatId, 'Sent it');
    const log = tg.calls
      .filter((c) => c.chatId === String(chatId) && c.at > start)
      .map((c) => `${Math.round(c.at - start)} ${c.method}`)
      .join('\n');
    expect(
      typingIn(chatId, start).filter((c) => c.at < answerAt).length,
      log,
    ).toBeGreaterThanOrEqual(2);
    expect(typingIn(chatId, answerAt), log).toHaveLength(0);
  });

  it('a failing "typing…" never holds up or fails the turn', async () => {
    const { chatId } = await linkedChat();
    const real = telegramApi();
    setTelegramApi(async (method, body) => {
      if (method === 'sendChatAction') throw new Error('telegram sendChatAction failed: 429');
      return real(method, body);
    });
    await sendTelegram(telegramUpdate(chatId, 'still there?'));
    await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.text === 'echo: still there?'),
    );
  });

  it('TELEGRAM_TYPING=false: no "typing…"', async () => {
    process.env.TELEGRAM_TYPING = 'false';
    resetConfig();
    const { chatId } = await linkedChat();
    const start = performance.now();
    const done = nextInboundDone();
    await sendTelegram(telegramUpdate(chatId, 'hello'));
    await done;
    await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.text === 'echo: hello'),
    );
    expect(typingIn(chatId, start)).toHaveLength(0);
  });

  it('nothing for web chat, nor for a chat that is not linked', async () => {
    const user = await chatUser({ credits: 5000 });
    const res = await call('/v1/messages', {
      method: 'POST',
      token: user.token,
      body: { text: 'hi from the web', clientMessageId: randomUUID() },
    });
    expect(res.status).toBe(202);
    await waitFor(async () => vm.deliveries.some((d) => d.text.includes('hi from the web')));

    const stranger = 950_000_000 + Math.floor(Math.random() * 1e7);
    await sendTelegram(telegramUpdate(stranger, 'who are you'));
    await waitFor(async () => tg.sent.find((m) => m.chatId === String(stranger)));
    await sleep(2 * REFRESH);
    expect(typingIn(stranger)).toHaveLength(0);
    // And no chat at all got one for the web message.
    expect(tg.calls.filter((c) => c.method === 'sendChatAction' && !c.chatId)).toHaveLength(0);
  });
});
