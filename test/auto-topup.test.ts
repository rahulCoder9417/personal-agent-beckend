// Auto top-up (HLD 7, backend-report Part C): the setting, the line, the monthly cap, the
// cooldown, the "waiting" marker, switching itself off after declined cards, and that a job run
// again never charges twice. Polar is a fake; credits come only from its order.paid event.
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getUser, setPlan } from '../src/modules/auth/users.ts';
import { chargeAppAction } from '../src/modules/billing/app-actions.ts';
import {
  getAutoTopUp,
  maybeQueueAutoTopUp,
  runAutoTopUp,
  setAutoTopUp,
} from '../src/modules/billing/auto-topup.ts';
import { getBalance } from '../src/modules/billing/credits.ts';
import { handlePolarEvent } from '../src/modules/billing/polar-events.ts';
import { autoTopUpAttempts, autoTopUpSettings } from '../src/modules/billing/schema.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { ingestEvent } from '../src/modules/events/intake.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakes, member } from './billing-fakes.ts';
import { DAY, fakeJob, grantsOf, ledgerMatchesGrants, linkChat } from './billing-helpers.ts';
import { call, expectContract } from './helpers.ts';
import type { FakePolar } from './polar-fakes.ts';
import { PRODUCTS, installPolar, orderPaid } from './polar-fakes.ts';

process.env.AUTO_TOPUP_ENABLED = 'true';
resetConfig();
afterAll(closeQueues);
installFakes();
wireModules();
let polar: FakePolar;
beforeEach(() => {
  polar = installPolar();
});

const HOUR = 3600_000;
const at = (ms: number) => new Date(Date.now() + ms);

/** Switch the setting off for one test. */
async function withFlagOff(fn: () => Promise<void>) {
  process.env.AUTO_TOPUP_ENABLED = 'false';
  resetConfig();
  try {
    await fn();
  } finally {
    process.env.AUTO_TOPUP_ENABLED = 'true';
    resetConfig();
  }
}

/** A Pro user with `credits`, auto top-up on (consent given). */
async function subscriber(
  credits: number,
  opts: { thresholdCredits?: number; monthlyCap?: number } = {},
) {
  const u = await member(credits, 'pro');
  await setAutoTopUp((await getUser(u.id))!, { enabled: true, consent: true, ...opts });
  return u;
}

const attemptsOf = (userId: string) =>
  db().select().from(autoTopUpAttempts).where(eq(autoTopUpAttempts.userId, userId));

/** Polar's order.paid for an auto top-up's draft order, through intake and the worker handler. */
async function orderPaidFor(userId: string, orderId: string, webhookId = `msg_${randomUUID()}`) {
  const payload = orderPaid({
    userId,
    orderId,
    product: PRODUCTS.topup10,
    netAmount: 1000,
    metadata: polar.orders.get(orderId)!.metadata,
  });
  const { eventId } = await ingestEvent({
    source: 'polar',
    externalId: webhookId,
    type: payload.type,
    payload: payload as unknown as Record<string, unknown>,
    queue: 'system',
    jobName: 'polar-event',
  });
  return handlePolarEvent(fakeJob({ eventId }));
}

const put = (token: string, body: unknown) => ({ method: 'PUT', token, body });

describe('the setting (AUTO_TOPUP_ENABLED)', () => {
  it('off: GET says not available, PUT is refused, nothing is queued or charged', async () => {
    const u = await subscriber(10); // switched on while the setting was on
    await withFlagOff(async () => {
      const body = await expectContract<{ available: boolean; enabled: boolean }>(
        'getAutoTopUp',
        await call('/v1/billing/auto-topup', { token: u.token }),
        200,
      );
      expect(body).toMatchObject({ available: false, enabled: false, lastAttempt: null });
      await expectContract(
        'setAutoTopUp',
        await call('/v1/billing/auto-topup', put(u.token, { enabled: true, consent: true })),
        404,
      );
      const before = (await queue('system').getJobs(['waiting', 'delayed'])).length;
      await maybeQueueAutoTopUp(u.id, 0);
      expect((await queue('system').getJobs(['waiting', 'delayed'])).length).toBe(before);
      expect(await runAutoTopUp(u.id)).toEqual({ skipped: 'off' });
    });
    expect(polar.orders.size).toBe(0);
    expect(await attemptsOf(u.id)).toEqual([]);
  });
});

describe('GET / PUT /v1/billing/auto-topup', () => {
  it('switching on needs a paid plan, explicit consent and a saved card; off always works', async () => {
    const free = await member(10, 'free');
    const refused = await expectContract<{ error: { code: string } }>(
      'setAutoTopUp',
      await call('/v1/billing/auto-topup', put(free.token, { enabled: true, consent: true })),
      403,
    );
    expect(refused.error.code).toBe('plan_limit');

    const u = await member(10, 'pro');
    await expectContract(
      'setAutoTopUp',
      await call('/v1/billing/auto-topup', put(u.token, { enabled: true })),
      400,
    );
    await expectContract(
      'setAutoTopUp',
      await call(
        '/v1/billing/auto-topup',
        put(u.token, { enabled: true, consent: true, thresholdCredits: 5 }),
      ),
      400,
    );
    await expectContract(
      'setAutoTopUp',
      await call(
        '/v1/billing/auto-topup',
        put(u.token, { enabled: true, consent: true, monthlyCap: 9 }),
      ),
      400,
    );
    polar.cards.set(u.id, null);
    await expectContract(
      'setAutoTopUp',
      await call('/v1/billing/auto-topup', put(u.token, { enabled: true, consent: true })),
      409,
    );
    polar.cards.delete(u.id);

    const on = await expectContract<{
      enabled: boolean;
      thresholdCredits: number;
      monthlyCap: number;
      card: { brand: string; last4: string } | null;
      consentedAt: string | null;
    }>(
      'setAutoTopUp',
      await call(
        '/v1/billing/auto-topup',
        put(u.token, { enabled: true, consent: true, thresholdCredits: 150, monthlyCap: 3 }),
      ),
      200,
    );
    expect(on).toMatchObject({
      enabled: true,
      thresholdCredits: 150,
      monthlyCap: 3,
      card: { brand: 'visa', last4: '4242' },
    });
    expect(on.consentedAt).not.toBeNull();

    // Another user sees only their own (defaults).
    const other = await member(10, 'pro');
    const theirs = await expectContract<{ enabled: boolean; thresholdCredits: number }>(
      'getAutoTopUp',
      await call('/v1/billing/auto-topup', { token: other.token }),
      200,
    );
    expect(theirs).toMatchObject({ enabled: false, thresholdCredits: 100 });

    // Off: no consent needed; the other settings stay.
    const off = await expectContract<{ enabled: boolean; thresholdCredits: number }>(
      'setAutoTopUp',
      await call('/v1/billing/auto-topup', put(u.token, { enabled: false })),
      200,
    );
    expect(off).toMatchObject({ enabled: false, thresholdCredits: 150 });
    await expectContract('getAutoTopUp', await call('/v1/billing/auto-topup'), 401);
  });
});

describe('the auto-topup job', () => {
  it('a charge that leaves the balance under the line queues the job', async () => {
    const u = await subscriber(101);
    await chargeAppAction(u.id, { action: 'GMAIL_SEND_EMAIL', ref: randomUUID() });
    expect(await getBalance(u.id)).toBe(100);
    // 100 is not under 100: nothing yet.
    let jobs = (await queue('system').getJobs(['waiting', 'delayed'])).filter(
      (j) => j.name === 'auto-topup' && j.data.userId === u.id,
    );
    expect(jobs).toHaveLength(0);
    await chargeAppAction(u.id, { action: 'GMAIL_SEND_EMAIL', ref: randomUUID() });
    jobs = (await queue('system').getJobs(['waiting', 'delayed'])).filter(
      (j) => j.name === 'auto-topup' && j.data.userId === u.id,
    );
    expect(jobs).toHaveLength(1);
  });

  it('above the line: nothing; under it: one charge through Polar, credits only from order.paid', async () => {
    const rich = await subscriber(500);
    expect(await runAutoTopUp(rich.id)).toEqual({ skipped: 'enough' });

    const u = await subscriber(40);
    const grantsBefore = (await grantsOf(u.id)).length;
    const res = await runAutoTopUp(u.id);
    expect(res).toMatchObject({ charged: true });
    expect(polar.paidOrders).toHaveLength(1);
    const [orderId] = polar.paidOrders;
    expect(polar.orders.get(orderId!)).toMatchObject({
      customerId: `cus_${u.id}`,
      productId: PRODUCTS.topup10,
      metadata: { user_id: u.id, kind: 'topup', top_up_id: 'topup_10' },
    });
    // Charged, but no credits until Polar says the order is paid.
    expect((await grantsOf(u.id)).length).toBe(grantsBefore);
    expect(await getBalance(u.id)).toBe(40);
    const view = await getAutoTopUp(u.id);
    expect(view.lastAttempt).toMatchObject({ status: 'waiting', credits: 800, amountCents: 1000 });
    expect(view.thisMonth).toEqual({ count: 1, spentCents: 1000 });

    await orderPaidFor(u.id, orderId!, 'msg_same');
    await orderPaidFor(u.id, orderId!, 'msg_same'); // Polar sends it twice
    await orderPaidFor(u.id, orderId!); // or the job runs again
    expect(await getBalance(u.id)).toBe(840);
    expect((await grantsOf(u.id)).filter((g) => g.source === 'topup')).toHaveLength(1);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
    expect((await getAutoTopUp(u.id)).lastAttempt?.status).toBe('credited');
  });

  it('the waiting marker: a paid top-up whose credits have not come blocks another', async () => {
    const u = await subscriber(10);
    expect(await runAutoTopUp(u.id)).toMatchObject({ charged: true });
    // Past the cooldown, balance still low (order.paid not here yet): no second charge.
    expect(await runAutoTopUp(u.id, at(2 * HOUR))).toEqual({ skipped: 'waiting' });
    expect(await runAutoTopUp(u.id, at(20 * HOUR))).toEqual({ skipped: 'waiting' });
    expect(polar.paidOrders).toHaveLength(1);
  });

  it('cooldown between tries, then the monthly cap', async () => {
    const u = await subscriber(10, { thresholdCredits: 1000, monthlyCap: 2 });
    expect(await runAutoTopUp(u.id)).toMatchObject({ charged: true });
    await orderPaidFor(u.id, polar.paidOrders[0]!);
    expect(await getBalance(u.id)).toBe(810); // still under 1000
    expect(await runAutoTopUp(u.id, at(10 * 60_000))).toEqual({ skipped: 'cooldown' });
    expect(await runAutoTopUp(u.id, at(2 * HOUR))).toMatchObject({ charged: true });
    await orderPaidFor(u.id, polar.paidOrders[1]!);
    expect(await getBalance(u.id)).toBe(1610);
    // Spend it down: still at most 2 this month.
    await db()
      .update(autoTopUpSettings)
      .set({ thresholdCredits: 5000 })
      .where(eq(autoTopUpSettings.userId, u.id));
    expect(await runAutoTopUp(u.id, at(4 * HOUR))).toEqual({ skipped: 'cap' });
    expect(polar.paidOrders).toHaveLength(2);
    expect((await getAutoTopUp(u.id)).thisMonth).toEqual({ count: 2, spentCents: 2000 });
  });

  it('two declined cards in a row switch it off, and the user is told on web and Telegram once', async () => {
    const u = await subscriber(10);
    await linkChat(u.id);
    polar.finalizeScript = ['declined', 'declined'];
    expect(await runAutoTopUp(u.id)).toEqual({ declined: true, turnedOff: false });
    expect((await getAutoTopUp(u.id)).enabled).toBe(true);
    // A day must pass after a decline.
    expect(await runAutoTopUp(u.id, at(3 * HOUR))).toEqual({ skipped: 'cooldown' });
    expect(await runAutoTopUp(u.id, at(DAY + HOUR))).toEqual({ declined: true, turnedOff: true });
    const view = await getAutoTopUp(u.id);
    expect(view).toMatchObject({ enabled: false, turnedOffReason: 'declined' });
    expect(view.lastAttempt?.status).toBe('declined');
    expect(view.thisMonth).toEqual({ count: 0, spentCents: 0 });
    expect(polar.paidOrders).toHaveLength(0);
    expect(await getBalance(u.id)).toBe(10);
    expect(await runAutoTopUp(u.id, at(3 * DAY))).toEqual({ skipped: 'off' });

    const told = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, u.id), eq(messages.direction, 'out')));
    expect(told.map((m) => m.channel).sort()).toEqual(['telegram', 'web']);
    const web = told.find((m) => m.channel === 'web')!;
    const tg = told.find((m) => m.channel === 'telegram')!;
    expect(web.text).toContain('Auto top-up is off. Your card was declined twice');
    expect(web.text).toContain('http://web.test/pricing');
    expect(tg.text).toContain('the Textcrew web app');
    expect(tg.text).not.toContain('http');

    // Switching on again starts the count afresh.
    await setAutoTopUp((await getUser(u.id))!, { enabled: true, consent: true });
    expect((await getAutoTopUp(u.id)).turnedOffReason).toBeNull();
  });

  it('no saved card, or Polar refusing, switches it off at once', async () => {
    const a = await subscriber(10);
    polar.cards.set(a.id, null);
    expect(await runAutoTopUp(a.id)).toEqual({ failed: 'no_card' });
    expect(await getAutoTopUp(a.id)).toMatchObject({ enabled: false, turnedOffReason: 'no_card' });

    const b = await subscriber(10);
    polar.finalizeScript = ['refused'];
    expect(await runAutoTopUp(b.id)).toEqual({ failed: 'refused' });
    expect(await getAutoTopUp(b.id)).toMatchObject({ enabled: false, turnedOffReason: 'refused' });

    const c = await subscriber(10);
    polar.refuseDraft = 422;
    expect(await runAutoTopUp(c.id)).toEqual({ failed: 'refused' });
    polar.refuseDraft = null;
    expect(polar.paidOrders).toHaveLength(0);
  });

  it('a downgrade to Free stops it without charging', async () => {
    const u = await subscriber(10);
    await setPlan(u.id, 'free');
    expect(await runAutoTopUp(u.id)).toEqual({ skipped: 'plan' });
    expect(polar.orders.size).toBe(0);
  });
});

describe('safe to run again', () => {
  it('charged at Polar but the answer was lost: the re-run finds it paid, no second charge', async () => {
    const u = await subscriber(10);
    polar.finalizeScript = ['crash'];
    await expect(runAutoTopUp(u.id)).rejects.toThrow();
    expect((await attemptsOf(u.id))[0]).toMatchObject({ status: 'charging' });
    expect(await runAutoTopUp(u.id)).toMatchObject({ charged: true });
    expect(polar.orders.size).toBe(1);
    expect(polar.paidOrders).toHaveLength(1);
    expect(polar.finalized).toHaveLength(1);
    expect(await attemptsOf(u.id)).toHaveLength(1);
  });

  it('Polar did not answer before charging: the re-run charges the same order', async () => {
    const u = await subscriber(10);
    polar.finalizeScript = ['timeout'];
    await expect(runAutoTopUp(u.id)).rejects.toThrow();
    expect(await runAutoTopUp(u.id)).toMatchObject({ charged: true });
    expect(polar.orders.size).toBe(1);
    expect(polar.paidOrders).toHaveLength(1);
  });

  it('an unfinished try is dropped, not charged, once the balance is fine again', async () => {
    const u = await subscriber(10);
    polar.finalizeScript = ['timeout'];
    await expect(runAutoTopUp(u.id)).rejects.toThrow();
    await db()
      .update(autoTopUpSettings)
      .set({ thresholdCredits: 5 })
      .where(eq(autoTopUpSettings.userId, u.id));
    expect(await runAutoTopUp(u.id)).toEqual({ failed: 'not_needed' });
    expect(polar.paidOrders).toHaveLength(0);
  });

  it('two runs at once make one charge', async () => {
    const u = await subscriber(10);
    const results = await Promise.all([runAutoTopUp(u.id), runAutoTopUp(u.id), runAutoTopUp(u.id)]);
    expect(results.filter((r) => 'charged' in r)).toHaveLength(1);
    expect(polar.paidOrders).toHaveLength(1);
    expect(await attemptsOf(u.id)).toHaveLength(1);
  });
});
