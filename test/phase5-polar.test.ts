import { randomUUID } from 'node:crypto';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { getUser } from '../src/modules/auth/users.ts';
import { getBalance } from '../src/modules/billing/credits.ts';
import {
  cancelSubscription,
  resumeSubscription,
  startCheckout,
  verifyPolarWebhook,
} from '../src/modules/billing/polar.ts';
import { handlePolarEvent } from '../src/modules/billing/polar-events.ts';
import { payments } from '../src/modules/billing/schema.ts';
import {
  endLapsedSubscriptions,
  getCurrentSubscription,
} from '../src/modules/billing/subscriptions.ts';
import { ingestEvent } from '../src/modules/events/intake.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { AppError } from '../src/shared/errors.ts';
import { IGNORED } from '../src/worker/runner.ts';
import { installFakes, member } from './billing-fakes.ts';
import { DAY, fakeJob, grantsOf, ledgerMatchesGrants, ledgerOf } from './billing-helpers.ts';
import { createUser } from './helpers.ts';
import {
  PRODUCTS,
  installPolar,
  orderPaid,
  refundEvent,
  signPolar,
  signPolarLegacy,
  subscriptionEvent,
  topUpOrder,
  type SubOpts,
} from './polar-fakes.ts';

afterAll(closeQueues);
const { llm } = installFakes();
const polar = installPolar();

/** Webhook intake (event + job, deduped on webhook-id) and then the worker's handler. */
async function deliver(
  payload: { type: string; data?: unknown },
  webhookId = `msg_${randomUUID()}`,
) {
  const { eventId } = await ingestEvent({
    source: 'polar',
    externalId: webhookId,
    type: payload.type,
    payload: payload as Record<string, unknown>,
    queue: 'system',
    jobName: 'polar-event',
  });
  return handlePolarEvent(fakeJob({ eventId }));
}

const periodFromNow = () => ({ start: new Date(), end: new Date(Date.now() + 30 * DAY) });

/** A Pro subscriber: subscription.active delivered. */
async function subscribed(credits = 0) {
  const u = await member(credits);
  const sub: SubOpts = { userId: u.id, subId: randomUUID(), ...periodFromNow() };
  await deliver(subscriptionEvent('subscription.active', sub));
  return { u, sub };
}

describe('Polar webhook signature (Standard Webhooks)', () => {
  it('accepts a signed body and rejects a tampered one or a bad signature', () => {
    const signed = signPolar(topUpOrder('usr_x', randomUUID()));
    expect(verifyPolarWebhook(signed.body, signed.headers).type).toBe('order.paid');
    const tampered = signed.body.replace('"net_amount":1000', '"net_amount":100000');
    expect(tampered).not.toBe(signed.body);
    expect(() => verifyPolarWebhook(tampered, signed.headers)).toThrow(AppError);
    expect(() =>
      verifyPolarWebhook(signed.body, { ...signed.headers, 'webhook-signature': 'v1,AAAA' }),
    ).toThrow(AppError);
    const other = signPolar(
      { type: 'order.paid' },
      undefined,
      'whsec_' + Buffer.from('another-secret-0123456789').toString('base64'),
    );
    expect(() => verifyPolarWebhook(other.body, other.headers)).toThrow(AppError);
  });

  it('also accepts an older Polar secret (key = the whole whsec_ string)', () => {
    const signed = signPolarLegacy({ type: 'subscription.active', data: {} });
    expect(verifyPolarWebhook(signed.body, signed.headers).type).toBe('subscription.active');
  });

  it('rejects everything when no secret is configured', () => {
    const signed = signPolar({ type: 'order.paid' });
    const saved = process.env.POLAR_WEBHOOK_SECRET;
    delete process.env.POLAR_WEBHOOK_SECRET;
    resetConfig();
    try {
      expect(() => verifyPolarWebhook(signed.body, signed.headers)).toThrow(AppError);
    } finally {
      process.env.POLAR_WEBHOOK_SECRET = saved;
      resetConfig();
    }
  });
});

describe('Polar events (HLD 7.6)', () => {
  it('a top-up order adds 800 credits (90 days) exactly once', async () => {
    const u = await member(0, 'pro');
    const orderId = randomUUID();
    const payload = topUpOrder(u.id, orderId);
    const webhookId = `msg_${randomUUID()}`;
    await deliver(payload, webhookId);
    await deliver(payload, webhookId); // same webhook twice
    await deliver(payload); // Polar re-sends it under a new webhook id
    const topups = (await grantsOf(u.id)).filter((g) => g.source === 'topup');
    expect(topups).toHaveLength(1);
    expect(topups[0]!.amount).toBe(800);
    expect(topups[0]!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 89.9 * DAY);
    expect(topups[0]!.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 90 * DAY);
    expect(await getBalance(u.id)).toBe(800);
    expect(llm.remainingBudget(u.id)).toBeCloseTo(800 / 250, 6);
    const rows = await db().select().from(payments).where(eq(payments.polarOrderId, orderId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'topup', amountCents: 1000, credits: 800 });
  });

  it('subscription active → plan set, monthly credits (90 days), paid models; the first order grants nothing more', async () => {
    const { u, sub } = await subscribed();
    expect((await getUser(u.id))!.plan).toBe('pro');
    expect(await getBalance(u.id)).toBe(1500);
    expect(llm.byUser(u.id)!.models).toEqual([
      'agent-default',
      'agent-crew',
      'cheap',
      'claude',
      'gpt',
      'claude-crew',
    ]);
    expect(llm.byUser(u.id)!.aliases).toEqual({
      'agent-default': 'claude',
      'agent-crew': 'claude-crew',
    });
    const monthly = (await grantsOf(u.id)).find((g) => g.source === 'monthly' && g.amount > 0)!;
    // Every credit lasts 90 days from the grant, not until the period ends.
    expect(monthly.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 89.9 * DAY);
    expect((await getCurrentSubscription(u.id))!.status).toBe('active');

    // Re-delivered activation, and the first order being paid: same period, nothing new.
    await deliver(subscriptionEvent('subscription.active', sub));
    await deliver(
      orderPaid(
        { userId: u.id, orderId: randomUUID(), product: PRODUCTS.pro, netAmount: 1900 },
        sub,
      ),
    );
    expect(await getBalance(u.id)).toBe(1500);
  });

  it('order.paid for the first period alone (no subscription.active yet) starts the plan', async () => {
    const u = await member(0);
    const sub: SubOpts = { userId: u.id, subId: randomUUID(), ...periodFromNow() };
    await deliver(
      orderPaid(
        { userId: u.id, orderId: randomUUID(), product: PRODUCTS.pro, netAmount: 1900 },
        sub,
      ),
    );
    expect((await getUser(u.id))!.plan).toBe('pro');
    expect(await getBalance(u.id)).toBe(1500);
    await deliver(subscriptionEvent('subscription.active', sub)); // arrives late
    expect(await getBalance(u.id)).toBe(1500);
  });

  it('renewal: the paid renewal order grants the new period once; unused credits carry over', async () => {
    const { u, sub } = await subscribed();
    const next: SubOpts = {
      ...sub,
      start: new Date(Date.now() + 1000),
      end: new Date(Date.now() + 60 * DAY),
    };
    // Polar: subscription.cycled + subscription.updated, then order.paid once the payment clears.
    await deliver(subscriptionEvent('subscription.updated', next));
    expect(await getBalance(u.id)).toBe(1500); // not paid yet
    const renewal = orderPaid(
      {
        userId: u.id,
        orderId: randomUUID(),
        product: PRODUCTS.pro,
        netAmount: 1900,
        billingReason: 'subscription_cycle',
      },
      next,
    );
    await deliver(renewal);
    await deliver(renewal); // re-sent under a new webhook id
    const grants = (await grantsOf(u.id)).filter((g) => g.source === 'monthly' && g.amount > 0);
    expect(grants).toHaveLength(2);
    expect(await getBalance(u.id)).toBe(3000); // unused monthly credits carry over (90 days)
    expect((await ledgerOf(u.id)).filter((l) => l.reason === 'expire')).toHaveLength(0);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
    const current = (await getCurrentSubscription(u.id))!;
    expect(current.periodEnd!.toISOString()).toBe(next.end.toISOString());
  });

  it('canceled → plan kept until the period ends; revoked → Free; credits keep their own 90-day expiry', async () => {
    const { u, sub } = await subscribed();
    await deliver(topUpOrder(u.id, randomUUID()));
    expect(await getBalance(u.id)).toBe(2300);
    const canceled = { ...sub, cancelAtPeriodEnd: true };
    await deliver(subscriptionEvent('subscription.updated', canceled));
    await deliver(subscriptionEvent('subscription.canceled', canceled));
    // Still Pro until the paid period is over.
    expect((await getUser(u.id))!.plan).toBe('pro');
    expect((await getCurrentSubscription(u.id))!.status).toBe('cancel_at_period_end');

    // Uncancel, then cancel again.
    await deliver(subscriptionEvent('subscription.uncanceled', sub));
    expect((await getCurrentSubscription(u.id))!.status).toBe('active');
    await deliver(subscriptionEvent('subscription.canceled', canceled));
    expect(await endLapsedSubscriptions(new Date(sub.end.getTime() - 1000))).toBe(0);

    // End of the period: Polar revokes it.
    await deliver(
      subscriptionEvent('subscription.revoked', {
        ...canceled,
        status: 'canceled',
        endedAt: new Date(),
      }),
    );
    expect((await getUser(u.id))!.plan).toBe('free');
    expect(await getBalance(u.id)).toBe(2300);
    // …until 90 days after they were granted.
    expect(await getBalance(u.id, new Date(Date.now() + 91 * DAY))).toBe(0);
    expect(llm.byUser(u.id)!.models).toEqual(['agent-default', 'agent-crew', 'cheap']);
    expect(llm.byUser(u.id)!.aliases).toEqual({ 'agent-default': 'cheap', 'agent-crew': 'cheap' });
    // Nothing more to end; a late revoked/updated changes nothing.
    expect(await endLapsedSubscriptions(new Date(sub.end.getTime() + 2000))).toBe(0);
    expect(
      await deliver(subscriptionEvent('subscription.updated', { ...canceled, status: 'canceled' })),
    ).toBe(IGNORED);
  });

  it('a cancelled period ends on time even if subscription.revoked never arrives', async () => {
    const { u, sub } = await subscribed();
    await deliver(subscriptionEvent('subscription.canceled', { ...sub, cancelAtPeriodEnd: true }));
    expect(await endLapsedSubscriptions(new Date(sub.end.getTime() + 1000))).toBe(1);
    expect((await getUser(u.id))!.plan).toBe('free');
    expect(await getBalance(u.id)).toBe(1500); // the monthly grant keeps its 90 days
  });

  it('immediate revocation → Free right away', async () => {
    const { u, sub } = await subscribed();
    await deliver(
      subscriptionEvent('subscription.revoked', {
        ...sub,
        status: 'canceled',
        endedAt: new Date(),
      }),
    );
    expect((await getUser(u.id))!.plan).toBe('free');
    expect(await getCurrentSubscription(u.id)).toBeUndefined(); // ended
  });

  it('past due keeps the plan; a recovered payment makes it active again with no extra grant', async () => {
    const { u, sub } = await subscribed();
    await deliver(subscriptionEvent('subscription.past_due', { ...sub, status: 'past_due' }));
    expect((await getCurrentSubscription(u.id))!.status).toBe('past_due');
    expect((await getUser(u.id))!.plan).toBe('pro');
    await deliver(subscriptionEvent('subscription.active', sub));
    expect((await getCurrentSubscription(u.id))!.status).toBe('active');
    expect(await getBalance(u.id)).toBe(1500);
  });

  it('a plan change (subscription.updated with the Max product) switches the plan now', async () => {
    const { u, sub } = await subscribed();
    await deliver(subscriptionEvent('subscription.updated', { ...sub, product: PRODUCTS.max }));
    expect((await getUser(u.id))!.plan).toBe('max');
    expect((await getCurrentSubscription(u.id))!.plan).toBe('max');
    expect(await getBalance(u.id)).toBe(1500); // Max credits come with the next period
  });

  it('refund → negative grant for the refunded share, taken from that top-up first', async () => {
    const u = await member(100, 'pro');
    const orderId = randomUUID();
    await deliver(topUpOrder(u.id, orderId));
    expect(await getBalance(u.id)).toBe(900);
    const refundId = randomUUID();
    // Created pending, then succeeded: acts once, on success.
    expect(await deliver(refundEvent({ refundId, orderId, amount: 500, status: 'pending' }))).toBe(
      IGNORED,
    );
    expect(await getBalance(u.id)).toBe(900);
    await deliver(refundEvent({ refundId, orderId, amount: 500 }, 'refund.updated')); // half → 400
    await deliver(refundEvent({ refundId, orderId, amount: 500 }, 'refund.updated')); // again
    expect(await getBalance(u.id)).toBe(500);
    const topup = (await grantsOf(u.id)).find((g) => g.source === 'topup')!;
    expect(topup.remaining).toBe(400); // the sign-up credits were left alone
    await deliver(refundEvent({ orderId, amount: 1000 })); // "the rest": capped at what's left
    expect(await getBalance(u.id)).toBe(100);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('a refunded subscription order takes back its share of the monthly credits', async () => {
    const { u, sub } = await subscribed();
    const orderId = randomUUID();
    await deliver(
      orderPaid({ userId: u.id, orderId, product: PRODUCTS.pro, netAmount: 1900 }, sub),
    );
    const [payment] = await db().select().from(payments).where(eq(payments.polarOrderId, orderId));
    expect(payment).toMatchObject({
      kind: 'plan',
      credits: 1500,
      amountCents: 1900,
      polarSubscriptionId: sub.subId,
    });
    expect(await getBalance(u.id)).toBe(1500); // the order itself grants nothing extra
    await deliver(refundEvent({ orderId, amount: 950 }));
    expect(await getBalance(u.id)).toBe(750);
  });

  it('a refund Polar makes to prevent a chargeback → take back all bought credits + flag', async () => {
    const u = await member(0, 'pro');
    const orderId = randomUUID();
    await deliver(topUpOrder(u.id, orderId));
    const dispute = refundEvent({
      orderId,
      amount: 1000,
      reason: 'dispute_prevention',
      dispute: {
        id: randomUUID(),
        status: 'prevented',
        resolved: false,
        closed: true,
        amount: 1000,
        order_id: orderId,
      },
    });
    await deliver(dispute);
    await deliver(dispute);
    expect((await getUser(u.id))!.flagged).toBe(true);
    expect(await getBalance(u.id)).toBe(0);
    const refunds = (await grantsOf(u.id)).filter((g) => g.source === 'refund');
    expect(refunds.map((g) => g.amount)).toEqual([-800]);
  });

  it('unknown events and unknown orders or subscriptions are ignored', async () => {
    expect(await deliver({ type: 'benefit_grant.created', data: {} })).toBe(IGNORED);
    expect(await deliver(refundEvent({ orderId: randomUUID(), amount: 100 }))).toBe(IGNORED);
    const stranger = await createUser();
    expect(
      await deliver(
        subscriptionEvent('subscription.updated', {
          userId: stranger.id,
          subId: randomUUID(),
          ...periodFromNow(),
        }),
      ),
    ).toBe(IGNORED);
    expect((await getUser(stranger.id))!.plan).toBe('free');
  });
});

describe('checkout + cancel', () => {
  it('creates a hosted checkout with the user id as the external customer id; changes nothing yet', async () => {
    const u = await createUser();
    const { checkoutUrl: url, discountApplied } = await startCheckout(u, {
      kind: 'plan',
      planId: 'pro',
    });
    expect(url).toMatch(/^https:\/\//);
    expect(discountApplied).toBe(false);
    const sent = polar.checkouts.at(-1)!;
    expect(sent).toMatchObject({
      productId: PRODUCTS.pro,
      externalCustomerId: u.id,
      customerEmail: u.email,
      successUrl: 'http://web.test/billing?checkout=done&checkout_id={CHECKOUT_ID}',
      returnUrl: 'http://web.test/pricing',
      metadata: { user_id: u.id, kind: 'plan', plan_id: 'pro' },
    });
    expect(sent.discountId).toBeUndefined();
    expect((await getUser(u.id))!.plan).toBe('free');
  });

  it('top-ups are for paid plans only', async () => {
    const free = await createUser();
    await expect(startCheckout(free, { kind: 'topup', topUpId: 'topup_10' })).rejects.toMatchObject(
      { status: 403, code: 'plan_limit' },
    );
    const pro = await createUser({ plan: 'pro' });
    await startCheckout(pro, { kind: 'topup', topUpId: 'topup_10' });
    expect(polar.checkouts.at(-1)).toMatchObject({
      productId: PRODUCTS.topup10,
      externalCustomerId: pro.id,
      metadata: { user_id: pro.id, kind: 'topup', top_up_id: 'topup_10' },
    });
    await expect(startCheckout(pro, { kind: 'topup', topUpId: 'topup_99' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('cancel = at the end of the period, through Polar; the plan stays until then', async () => {
    const u = await member(0);
    await expect(cancelSubscription(u.id)).rejects.toMatchObject({ status: 409 });
    const sub: SubOpts = { userId: u.id, subId: randomUUID(), ...periodFromNow() };
    await deliver(subscriptionEvent('subscription.active', sub));
    // A second plan checkout while subscribed is refused.
    await expect(
      startCheckout((await getUser(u.id))!, { kind: 'plan', planId: 'max' }),
    ).rejects.toMatchObject({ status: 400 });
    const cancelled = await cancelSubscription(u.id);
    expect(cancelled.status).toBe('cancel_at_period_end');
    expect(polar.cancelled).toEqual([sub.subId]);
    expect((await getUser(u.id))!.plan).toBe('pro');
    // Asking again does not call Polar again.
    await cancelSubscription(u.id);
    expect(polar.cancelled).toEqual([sub.subId]);
    // Polar's confirmation keeps the same state.
    await deliver(subscriptionEvent('subscription.canceled', { ...sub, cancelAtPeriodEnd: true }));
    expect((await getCurrentSubscription(u.id))!.status).toBe('cancel_at_period_end');
  });

  it('Keep my plan: un-cancels through Polar before the period ends; no charge, no credits', async () => {
    const u = await member(0);
    // Nothing cancelled: refused, and Polar is not called.
    await expect(resumeSubscription(u.id)).rejects.toMatchObject({ status: 409 });
    const sub: SubOpts = { userId: u.id, subId: randomUUID(), ...periodFromNow() };
    await deliver(subscriptionEvent('subscription.active', sub));
    const grantsBefore = (await grantsOf(u.id)).length;
    // Active and renewing: nothing to keep.
    await expect(resumeSubscription(u.id)).rejects.toMatchObject({ status: 409 });
    expect(polar.uncancelled).not.toContain(sub.subId);

    await cancelSubscription(u.id);
    // Subscribing to the same plan again while it still runs is refused: Keep my plan instead.
    await expect(
      startCheckout((await getUser(u.id))!, { kind: 'plan', planId: 'pro' }),
    ).rejects.toMatchObject({ status: 400 });

    // Polar does not answer: an error, and nothing changes here.
    polar.failUncancel = true;
    await expect(resumeSubscription(u.id)).rejects.toThrow();
    expect((await getCurrentSubscription(u.id))!.status).toBe('cancel_at_period_end');

    const kept = await resumeSubscription(u.id);
    expect(kept.status).toBe('active');
    expect(polar.uncancelled).toEqual([sub.subId]);
    expect((await getUser(u.id))!.plan).toBe('pro');
    // Asking again: it already renews, so refused and Polar is not called twice.
    await expect(resumeSubscription(u.id)).rejects.toMatchObject({ status: 409 });
    expect(polar.uncancelled).toEqual([sub.subId]);
    // Polar's confirmation keeps it active and grants nothing.
    await deliver(subscriptionEvent('subscription.uncanceled', sub));
    await deliver(subscriptionEvent('subscription.updated', sub));
    expect((await getCurrentSubscription(u.id))!.status).toBe('active');
    expect((await grantsOf(u.id)).length).toBe(grantsBefore);
  });

  it('Keep my plan is refused once the period is over, and for another user', async () => {
    const a = await member(0);
    const b = await member(0);
    const subA: SubOpts = { userId: a.id, subId: randomUUID(), ...periodFromNow() };
    await deliver(subscriptionEvent('subscription.active', subA));
    await cancelSubscription(a.id);
    // B has nothing cancelled: B's request never touches A's subscription.
    await expect(resumeSubscription(b.id)).rejects.toMatchObject({ status: 409 });
    expect(polar.uncancelled).not.toContain(subA.subId);
    expect((await getCurrentSubscription(a.id))!.status).toBe('cancel_at_period_end');

    // A period that is already over cannot be kept.
    const c = await member(0);
    const past = { start: new Date(Date.now() - 31 * DAY), end: new Date(Date.now() - DAY) };
    const subC: SubOpts = { userId: c.id, subId: randomUUID(), ...past };
    await deliver(subscriptionEvent('subscription.active', subC));
    await deliver(subscriptionEvent('subscription.canceled', { ...subC, cancelAtPeriodEnd: true }));
    await expect(resumeSubscription(c.id)).rejects.toMatchObject({ status: 409 });
    expect(polar.uncancelled).not.toContain(subC.subId);
  });
});

/** The plan lines in a user's audit log, oldest first: [actor, action]. */
async function planAudit(userId: string) {
  const rows = await db()
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), like(auditLog.action, 'plan_%')))
    .orderBy(auditLog.createdAt);
  return rows.filter((r) => !['plan_activated', 'plan_renewed'].includes(r.action));
}

describe('plan changes leave audit lines', () => {
  it('cancel writes one row (actor user); cancelling twice adds none; resume writes one', async () => {
    const { u, sub } = await subscribed();
    await cancelSubscription(u.id);
    let rows = await planAudit(u.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'user', action: 'plan_cancelled' });
    expect(rows[0]!.summary).toMatch(/^Pro plan cancelled: stays until \d{1,2} \w{3}$/);
    expect(rows[0]!.details).toMatchObject({
      subscriptionId: sub.subId,
      periodEnd: sub.end.toISOString(),
    });
    await cancelSubscription(u.id);
    expect(await planAudit(u.id)).toHaveLength(1);
    // Polar's echo of our own cancel adds nothing.
    await deliver(subscriptionEvent('subscription.canceled', { ...sub, cancelAtPeriodEnd: true }));
    expect(await planAudit(u.id)).toHaveLength(1);

    await resumeSubscription(u.id);
    rows = await planAudit(u.id);
    expect(rows.map((r) => [r.actor, r.action])).toEqual([
      ['user', 'plan_cancelled'],
      ['user', 'plan_resumed'],
    ]);
    expect(rows[1]!.summary).toBe('Pro plan kept: renews again');
    expect(rows[1]!.details).toMatchObject({ subscriptionId: sub.subId });
    await deliver(subscriptionEvent('subscription.uncanceled', sub));
    expect(await planAudit(u.id)).toHaveLength(2);
  });

  it('Polar-only canceled / uncanceled / past_due / revoked write one system row each, once', async () => {
    const { u, sub } = await subscribed();
    const canceled = { ...sub, cancelAtPeriodEnd: true };
    await deliver(subscriptionEvent('subscription.canceled', canceled));
    // A re-run of the same state (updated, or the same event again) adds nothing.
    await deliver(subscriptionEvent('subscription.canceled', canceled));
    await deliver(subscriptionEvent('subscription.updated', canceled));
    expect((await planAudit(u.id)).map((r) => [r.actor, r.action])).toEqual([
      ['system', 'plan_cancelled'],
    ]);
    await deliver(subscriptionEvent('subscription.uncanceled', sub));
    await deliver(subscriptionEvent('subscription.uncanceled', sub));
    await deliver(subscriptionEvent('subscription.past_due', { ...sub, status: 'past_due' }));
    await deliver(subscriptionEvent('subscription.past_due', { ...sub, status: 'past_due' }));
    await deliver(
      subscriptionEvent('subscription.revoked', {
        ...sub,
        status: 'canceled',
        endedAt: new Date(),
      }),
    );
    await deliver(
      subscriptionEvent('subscription.revoked', {
        ...sub,
        status: 'canceled',
        endedAt: new Date(),
      }),
    );
    const rows = await planAudit(u.id);
    expect(rows.map((r) => [r.actor, r.action])).toEqual([
      ['system', 'plan_cancelled'],
      ['system', 'plan_resumed'],
      ['system', 'plan_past_due'],
      ['system', 'plan_ended'],
    ]);
    expect(rows[3]!.summary).toBe('Pro plan ended: now on Free');
  });

  it('the hourly safety net that ends a lapsed plan writes the plan_ended row once', async () => {
    const { u, sub } = await subscribed();
    await deliver(subscriptionEvent('subscription.canceled', { ...sub, cancelAtPeriodEnd: true }));
    const late = new Date(sub.end.getTime() + 2000);
    await endLapsedSubscriptions(late);
    await endLapsedSubscriptions(late);
    expect((await planAudit(u.id)).map((r) => r.action)).toEqual(['plan_cancelled', 'plan_ended']);
  });
});
