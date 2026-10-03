// Billing wired into chat, onboarding and automations (the cross-module paths).
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../src/modules/auth/schema.ts';
import { automations } from '../src/modules/automations/schema.ts';
import { createAutomation } from '../src/modules/automations/automations.ts';
import { createCoupon } from '../src/modules/billing/coupons.ts';
import { getBalance } from '../src/modules/billing/credits.ts';
import { fireBalanceDepleted, fireCreditsAdded } from '../src/modules/billing/hooks.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakeTelegram, installFakeVm, telegramUpdate, type SentTelegram } from './fakes.ts';
import { call, chatUser, createUser, signClerk, waitFor } from './helpers.ts';

let workers: Worker[];
let tg: { sent: SentTelegram[] };
let vmFake: ReturnType<typeof installFakeVm>;

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
  vmFake = installFakeVm();
});

const chat = () => Math.floor(Math.random() * 1e9);
const tgPost = (update: unknown) =>
  call('/webhooks/telegram', {
    method: 'POST',
    body: update,
    headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
  });

async function link(token: string, chatId: number) {
  const lc = (await (
    await call('/v1/channels/link-codes', { method: 'POST', token, body: { channel: 'telegram' } })
  ).json()) as { code: string };
  await tgPost(telegramUpdate(chatId, lc.code));
  await waitFor(async () =>
    tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('✅')),
  );
}

describe('billing wired in', () => {
  it('sign-up: 100 free credits, a LiteLLM key, and a sandbox created with that key', async () => {
    const clerkId = `user_${randomUUID()}`;
    const signed = signClerk({
      type: 'user.created',
      data: {
        id: clerkId,
        primary_email_address_id: 'e1',
        email_addresses: [
          { id: 'e1', email_address: 'new@example.com', verification: { status: 'verified' } },
        ],
      },
    });
    await call('/webhooks/clerk', { method: 'POST', body: signed.body, headers: signed.headers });
    const user = await waitFor(
      async () => (await db().select().from(users).where(eq(users.clerkId, clerkId)))[0],
    );
    await waitFor(async () => vmFake.created.includes(user.id));
    expect(await getBalance(user.id)).toBe(100);
  });

  it('at 0 credits the agent stops and says so (no container wake)', async () => {
    const broke = await createUser({ credits: 0 });
    const chatId = chat();
    await link(broke.token, chatId);
    await tgPost(telegramUpdate(chatId, 'do something'));
    const reply = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.text.includes('out of credits')),
    );
    // Telegram: the web app by name, no purchase link (HLD 7.6).
    expect(reply.text).toContain('Open the Textcrew web app to top up, upgrade or redeem a coupon');
    expect(reply.text).not.toMatch(/https?:\/\//);
    expect(vmFake.deliveries.filter((d) => d.userId === broke.id)).toHaveLength(0);
  });

  it('a coupon code sent in chat is redeemed, not given to the agent', async () => {
    const admin = await createUser({ role: 'admin' });
    const { codes } = await createCoupon({
      campaign: 'chat-test',
      credits: 200,
      maxRedemptions: 5,
      expiresAt: new Date(Date.now() + 86400_000),
      createdBy: admin.id,
    });
    const u = await chatUser();
    const chatId = chat();
    await link(u.token, chatId);
    await tgPost(telegramUpdate(chatId, codes[0]!));
    const ok = await waitFor(async () =>
      tg.sent.find((m) => m.chatId === String(chatId) && m.text.startsWith('🎉')),
    );
    expect(ok.text).toContain('+200 credits');
    await tgPost(telegramUpdate(chatId, codes[0]!));
    await waitFor(async () =>
      tg.sent.find(
        (m) => m.chatId === String(chatId) && m.text === 'That code is invalid or expired.',
      ),
    );
    expect(vmFake.deliveries.filter((d) => d.userId === u.id)).toHaveLength(0);
    expect(await getBalance(u.id)).toBe(1200);
  });

  it('balance depleted pauses automations; credits added resumes only those', async () => {
    const u = await chatUser({ plan: 'pro' });
    const a = await createAutomation({
      userId: u.id,
      title: 'weekly',
      instruction: 'x',
      sessionKey: 'web',
      cron: '0 9 * * 1',
    });
    const b = await createAutomation({
      userId: u.id,
      title: 'mine-paused',
      instruction: 'x',
      sessionKey: 'web',
      cron: '0 10 * * 1',
    });
    await call(`/v1/automations/${b.id}`, {
      method: 'PATCH',
      token: u.token,
      body: { enabled: false },
    });
    await fireBalanceDepleted(u.id);
    const paused = await db().select().from(automations).where(eq(automations.userId, u.id));
    expect(paused.find((r) => r.id === a.id)).toMatchObject({
      enabled: false,
      pausedReason: 'out_of_credits',
    });
    await fireCreditsAdded(u.id);
    const after = await db().select().from(automations).where(eq(automations.userId, u.id));
    expect(after.find((r) => r.id === a.id)).toMatchObject({ enabled: true, pausedReason: null });
    expect(after.find((r) => r.id === b.id)).toMatchObject({
      enabled: false,
      pausedReason: 'user',
    });
  });
});
