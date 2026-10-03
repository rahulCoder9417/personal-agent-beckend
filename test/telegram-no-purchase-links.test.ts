// No purchase links on Telegram (HLD 7.6, launch plan D9). Telegram requires Stars for digital
// goods sold inside the app, so a message to Telegram that would carry a checkout, top-up,
// upgrade or billing link names the web app instead. Other channels keep their links.
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { telegramAdapter } from '../src/modules/channels/adapters/telegram.ts';
import {
  isPurchaseLink,
  purchaseLinksAllowed,
  withoutPurchaseLinks,
} from '../src/modules/channels/purchase-links.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { linkInstructionsText } from '../src/modules/orchestrator/process-message.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { connectAiText, outOfCreditsText, runTurn } from '../src/modules/orchestrator/turn.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import {
  installFakeTelegram,
  installFakeVm,
  mcpCall,
  telegramUpdate,
  type SentTelegram,
} from './fakes.ts';
import { call, chatUser, createUser, waitFor } from './helpers.ts';

let workers: Worker[];
let tg: { sent: SentTelegram[] };
let vm: ReturnType<typeof installFakeVm>;

beforeAll(() => {
  wireModules();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  tg = installFakeTelegram();
  vm = installFakeVm();
});

const ANY_LINK = /https?:\/\//;
const chat = () => Math.floor(Math.random() * 1e9);
const tgPost = (update: unknown) =>
  call('/webhooks/telegram', {
    method: 'POST',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
  });

async function linkTelegram(token: string): Promise<number> {
  const chatId = chat();
  const lc = (await (
    await call('/v1/channels/link-codes', { method: 'POST', token, body: { channel: 'telegram' } })
  ).json()) as { code: string };
  await tgPost(telegramUpdate(chatId, lc.code));
  await waitFor(async () =>
    tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('✅')),
  );
  return chatId;
}

describe('purchase links: what counts and how they are replaced', () => {
  it('Polar URLs and the web app buying pages are purchase links; nothing else is', () => {
    for (const link of [
      'http://web.test/billing',
      'http://web.test/billing?checkout=done',
      'http://web.test/billing/plans',
      'http://web.test/pricing#pro',
      'http://web.test/checkout/abc',
      'http://web.test/upgrade',
      'http://web.test/plans',
      'http://web.test/topup',
      'http://web.test/top-ups',
      'http://web.test/subscribe',
      'https://WEB.test/Billing',
      'https://polar.sh/textcrew/products/pro',
      'https://buy.polar.sh/polar_cl_abc123',
      'https://sandbox.polar.sh/checkout/xyz',
    ])
      expect(isPurchaseLink(link), link).toBe(true);
    for (const link of [
      'http://web.test',
      'http://web.test/',
      'http://web.test/settings/ai',
      'http://web.test/apps?connected=gmail',
      'http://web.test/billingham', // a different path
      'https://example.com/billing', // somebody else's site
      'https://github.com/acme/repo/pull/7',
      'https://notpolar.sh/checkout',
      'not a link',
    ])
      expect(isPurchaseLink(link), link).toBe(false);
  });

  it('replaces only the purchase links, keeps the sentence and the other links', () => {
    expect(withoutPurchaseLinks('Top up at http://web.test/billing.')).toBe(
      'Top up at the Textcrew web app.',
    );
    expect(
      withoutPurchaseLinks(
        'Upgrade (https://buy.polar.sh/polar_cl_abc), then see https://github.com/acme/repo/pull/7!',
      ),
    ).toBe('Upgrade (the Textcrew web app), then see https://github.com/acme/repo/pull/7!');
    const untouched = 'Docs: https://example.com/billing and http://web.test/settings/ai';
    expect(withoutPurchaseLinks(untouched)).toBe(untouched);
    expect(withoutPurchaseLinks('no links here')).toBe('no links here');
  });

  it('only Telegram is restricted', () => {
    expect(purchaseLinksAllowed('telegram')).toBe(false);
    for (const channel of ['web', 'whatsapp', 'imessage'] as const)
      expect(purchaseLinksAllowed(channel)).toBe(true);
  });
});

describe('platform messages', () => {
  it('out of credits: Telegram names the web app with no URL; other channels keep the link', () => {
    expect(outOfCreditsText('telegram')).toBe(
      "You're out of credits, so I can't work on that right now. Open the Textcrew web app to top up, upgrade or redeem a coupon.",
    );
    expect(outOfCreditsText('telegram')).not.toMatch(ANY_LINK);
    for (const channel of ['web', 'whatsapp', 'imessage'] as const)
      expect(outOfCreditsText(channel)).toBe(
        "You're out of credits, so I can't work on that right now. Top up, upgrade or redeem a coupon at http://web.test/billing",
      );
  });

  it('the other platform texts with a link sell nothing, so they stay as they are on Telegram', () => {
    for (const text of [connectAiText(), linkInstructionsText()]) {
      expect(text).toMatch(ANY_LINK);
      expect(withoutPurchaseLinks(text)).toBe(text);
    }
  });

  it('a turn at zero credits: the Telegram reply has no link, the WhatsApp and web ones do', async () => {
    const broke = await createUser();
    const saved = async (sessionKey: string) => {
      const rows = await db().select().from(messages).where(eq(messages.userId, broke.id));
      return rows.find((m) => m.sessionKey === sessionKey && m.direction === 'out')!.text;
    };
    for (const [channel, sessionKey] of [
      ['telegram', 'telegram:4242'],
      ['whatsapp', 'whatsapp:15550004242'],
      ['web', 'web'],
    ] as const)
      expect(
        await runTurn({
          userId: broke.id,
          deliveryId: `evt-${channel}`,
          kind: 'message',
          sessionKey,
          channel,
          text: 'do something',
        }),
      ).toBe('out_of_credits');

    expect(await saved('telegram:4242')).not.toMatch(ANY_LINK);
    expect(await saved('telegram:4242')).toContain('Open the Textcrew web app');
    expect(await saved('whatsapp:15550004242')).toContain('http://web.test/billing');
    expect(await saved('web')).toContain('http://web.test/billing');
  });
});

describe('the Telegram sender is the safety net', () => {
  it('takes purchase links out of any text it sends', async () => {
    await telegramAdapter.send('99', {
      text: 'Upgrade here: http://web.test/billing or https://buy.polar.sh/polar_cl_abc',
    });
    expect(tg.sent).toEqual([
      {
        chatId: '99',
        text: 'Upgrade here: the Textcrew web app or the Textcrew web app',
      },
    ]);
  });

  it("the agent's own message loses its purchase link on Telegram and keeps it on the web", async () => {
    const u = await chatUser();
    const chatId = await linkTelegram(u.token);
    await ensureSandbox(u.id);
    const token = vm.tokens.get(u.id)!;
    const text =
      'You can upgrade at http://web.test/billing. Your PR: https://github.com/acme/repo/pull/7';

    await mcpCall(token, 'send_message', { text, session_key: `telegram:${chatId}` });
    const sent = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.text.includes('Your PR')),
    );
    expect(sent.text).toBe(
      'You can upgrade at the Textcrew web app. Your PR: https://github.com/acme/repo/pull/7',
    );

    await mcpCall(token, 'send_message', { text, session_key: 'web' });
    const rows = await db().select().from(messages).where(eq(messages.userId, u.id));
    expect(rows.find((m) => m.sessionKey === 'web' && m.direction === 'out')!.text).toBe(text);
  });
});
