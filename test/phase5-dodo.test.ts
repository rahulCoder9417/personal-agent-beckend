import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { getUser } from '../src/modules/auth/users.ts';
import { getBalance } from '../src/modules/billing/credits.ts';
import {
  cancelSubscription,
  startCheckout,
  verifyDodoWebhook,
} from '../src/modules/billing/dodo.ts';
import { handleDodoEvent } from '../src/modules/billing/dodo-events.ts';
import { payments, subscriptions } from '../src/modules/billing/schema.ts';
import {
  endLapsedSubscriptions,
  getCurrentSubscription,
} from '../src/modules/billing/subscriptions.ts';
import { ingestEvent } from '../src/modules/events/intake.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { db } from '../src/shared/db/client.ts';
import { AppError } from '../src/shared/errors.ts';
import { IGNORED } from '../src/worker/runner.ts';
import { installFakes, member } from './billing-fakes.ts';
import { DAY, fakeJob, grantsOf, ledgerMatchesGrants, ledgerOf } from './billing-helpers.ts';
import { installDodo, signDodo } from './dodo-fakes.ts';
import { createUser } from './helpers.ts';

afterAll(closeQueues);
const { llm } = installFakes();
const dodo = installDodo();

// --- Dodo test-mode payloads (shapes from Dodo's webhook docs) ----------------------------------

function subscriptionEvent(
  type: string,
  o: {
    userId: string;
    subId: string;
    product?: string;
    start: Date;
    end: Date;
    cancelAtNext?: boolean;
    status?: string;
  },
) {
  return {
    business_id: 'bus_test',
    type,
    timestamp: new Date().toISOString(),
    data: {
      payload_type: 'Subscription',
      subscription_id: o.subId,
      product_id: o.product ?? 'prod_pro',
      status: o.status ?? 'active',
      customer: { customer_id: 'cus_test', email: 'a@example.com', name: 'A' },
      metadata: { user_id: o.userId, kind: 'plan', plan_id: 'pro' },
      previous_billing_date: o.start.toISOString(),
      next_billing_date: o.end.toISOString(),
      cancel_at_next_billing_date: o.cancelAtNext ?? false,
    },
  };
}

function topUpPayment(userId: string, paymentId: string) {
  return {
    business_id: 'bus_test',
    type: 'payment.succeeded',
    timestamp: new Date().toISOString(),
    data: {
      payload_type: 'Payment',
      payment_id: paymentId,
      subscription_id: null,
      total_amount: 1000,
      currency: 'USD',
      status: 'succeeded',
      product_cart: [{ product_id: 'prod_topup10', quantity: 1 }],
      metadata: { user_id: userId, kind: 'topup', top_up_id: 'topup_10' },
      customer: { customer_id: 'cus_test', email: 'a@example.com', name: 'A' },
    },
  };
}

/** Webhook intake (event + job, deduped on webhook-id) and then the worker's handler. */
async function deliver(
  payload: { type: string; data?: unknown },
  webhookId = `msg_${randomUUID()}`,
) {
  const { eventId } = await ingestEvent({
    source: 'dodo',
    externalId: webhookId,
    type: payload.type,
    payload: payload as Record<string, unknown>,
    queue: 'system',
    jobName: 'dodo-event',
  });
  return handleDodoEvent(fakeJob({ eventId }));
}

const periodFromNow = () => ({ start: new Date(), end: new Date(Date.now() + 30 * DAY) });

describe('Dodo webhook signature (Standard Webhooks)', () => {
  it('accepts a signed body and rejects a tampered one', () => {
    const signed = signDodo(topUpPayment('usr_x', 'pay_x'));
    expect(verifyDodoWebhook(signed.body, signed.headers).type).toBe('payment.succeeded');
    const tampered = signed.body.replace('1000', '100000');
    expect(() => verifyDodoWebhook(tampered, signed.headers)).toThrow(AppError);
    expect(() =>
      verifyDodoWebhook(signed.body, { ...signed.headers, 'webhook-signature': 'v1,AAAA' }),
    ).toThrow(AppError);
  });
});

describe('Dodo events (HLD 7.6)', () => {
  it('a top-up payment adds 800 credits (12 months) exactly once', async () => {
    const u = await member(0, 'pro');
    const paymentId = `pay_${randomUUID()}`;
    const payload = topUpPayment(u.id, paymentId);
    const webhookId = `msg_${randomUUID()}`;
    await deliver(payload, webhookId);
    await deliver(payload, webhookId); // same webhook twice
    await deliver(payload); // Dodo re-sends it under a new webhook id
    const topups = (await grantsOf(u.id)).filter((g) => g.source === 'topup');
    expect(topups).toHaveLength(1);
    expect(topups[0]!.amount).toBe(800);
    expect(topups[0]!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 364 * DAY);
    expect(await getBalance(u.id)).toBe(800);
    expect(llm.remainingBudget(u.id)).toBeCloseTo(800 / 250, 6);
    const rows = await db().select().from(payments).where(eq(payments.dodoPaymentId, paymentId));
    expect(rows).toHaveLength(1);
  });

  it('subscription activated → plan set, monthly credits, paid models; renewed → new grant, old expires', async () => {
    const u = await member(0);
    const subId = `sub_${randomUUID()}`;
    const p1 = periodFromNow();
    await deliver(subscriptionEvent('subscription.active', { userId: u.id, subId, ...p1 }));
    expect((await getUser(u.id))!.plan).toBe('pro');
    expect(await getBalance(u.id)).toBe(1500);
    expect(llm.byUser(u.id)!.models).toEqual(['agent-default', 'cheap', 'claude', 'gpt']);
    expect(llm.byUser(u.id)!.aliases).toEqual({ 'agent-default': 'claude' });
    const monthly = (await grantsOf(u.id)).find((g) => g.source === 'monthly' && g.amount > 0)!;
    expect(monthly.expiresAt!.toISOString()).toBe(p1.end.toISOString());

    // Re-delivered activation: nothing new.
    await deliver(subscriptionEvent('subscription.active', { userId: u.id, subId, ...p1 }));
    expect(await getBalance(u.id)).toBe(1500);

    const p2 = { start: new Date(Date.now() + 1000), end: new Date(Date.now() + 60 * DAY) };
    await deliver(subscriptionEvent('subscription.renewed', { userId: u.id, subId, ...p2 }));
    const grants = (await grantsOf(u.id)).filter((g) => g.source === 'monthly' && g.amount > 0);
    expect(grants).toHaveLength(2);
    expect(await getBalance(u.id)).toBe(1500); // no roll-over
    expect((await ledgerOf(u.id)).filter((l) => l.reason === 'expire')).toHaveLength(1);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('cancelled → Free at the end of the period; monthly credits expire, top-ups stay', async () => {
    const u = await member(0);
    const subId = `sub_${randomUUID()}`;
    const p = periodFromNow();
    await deliver(subscriptionEvent('subscription.active', { userId: u.id, subId, ...p }));
    await deliver(topUpPayment(u.id, `pay_${randomUUID()}`));
    expect(await getBalance(u.id)).toBe(2300);
    await deliver(
      subscriptionEvent('subscription.cancelled', {
        userId: u.id,
        subId,
        ...p,
        status: 'cancelled',
      }),
    );
    // Still Pro until the paid period is over.
    expect((await getUser(u.id))!.plan).toBe('pro');
    expect((await getCurrentSubscription(u.id))!.status).toBe('cancelled');
    expect(await endLapsedSubscriptions(new Date(p.end.getTime() - 1000))).toBe(0);

    const after = new Date(p.end.getTime() + 1000);
    expect(await endLapsedSubscriptions(after)).toBe(1);
    expect((await getUser(u.id))!.plan).toBe('free');
    expect(await getBalance(u.id, after)).toBe(800);
    expect(llm.byUser(u.id)!.models).toEqual(['agent-default', 'cheap']);
    expect(llm.byUser(u.id)!.aliases).toEqual({ 'agent-default': 'cheap' });
    expect(await endLapsedSubscriptions(new Date(p.end.getTime() + 2000))).toBe(0);
  });

  it('an expired subscription whose period is already over → Free right away', async () => {
    const u = await member(0);
    const subId = `sub_${randomUUID()}`;
    await deliver(
      subscriptionEvent('subscription.active', { userId: u.id, subId, ...periodFromNow() }),
    );
    const past = { start: new Date(Date.now() - 31 * DAY), end: new Date(Date.now() - DAY) };
    await db()
      .update(subscriptions)
      .set({ periodEnd: past.end })
      .where(eq(subscriptions.dodoSubscriptionId, subId));
    await deliver(
      subscriptionEvent('subscription.expired', {
        userId: u.id,
        subId,
        ...past,
        status: 'expired',
      }),
    );
    expect((await getUser(u.id))!.plan).toBe('free');
    expect(await getBalance(u.id)).toBe(0);
  });

  it('refund → negative grant for the refunded share, taken from that top-up first', async () => {
    const u = await member(100);
    const paymentId = `pay_${randomUUID()}`;
    await deliver(topUpPayment(u.id, paymentId));
    expect(await getBalance(u.id)).toBe(900);
    const refund = (id: string, amount: number) => ({
      type: 'refund.succeeded',
      data: {
        payload_type: 'Refund',
        refund_id: id,
        payment_id: paymentId,
        amount,
        status: 'succeeded',
      },
    });
    await deliver(refund('ref_1', 500)); // half → 400 credits
    await deliver(refund('ref_1', 500)); // same refund again
    expect(await getBalance(u.id)).toBe(500);
    const topup = (await grantsOf(u.id)).find((g) => g.source === 'topup')!;
    expect(topup.remaining).toBe(400); // the sign-up credits were left alone
    await deliver(refund('ref_2', 1000)); // "the rest": capped at what's left of the purchase
    expect(await getBalance(u.id)).toBe(100);
    expect(await ledgerMatchesGrants(u.id)).toBe(true);
  });

  it('chargeback → negative grant and the account is flagged', async () => {
    const u = await member(0, 'pro');
    const paymentId = `pay_${randomUUID()}`;
    await deliver(topUpPayment(u.id, paymentId));
    const dispute = {
      type: 'dispute.opened',
      data: { payload_type: 'Dispute', dispute_id: 'dsp_1', payment_id: paymentId, amount: '1000' },
    };
    await deliver(dispute);
    await deliver(dispute);
    expect((await getUser(u.id))!.flagged).toBe(true);
    expect(await getBalance(u.id)).toBe(0);
  });

  it('unknown events are ignored', async () => {
    expect(await deliver({ type: 'license_key.created' })).toBe(IGNORED);
    expect(
      await deliver({
        type: 'refund.succeeded',
        data: { refund_id: 'r', payment_id: 'pay_unknown' },
      }),
    ).toBe(IGNORED);
  });
});

describe('checkout + cancel', () => {
  it('creates a hosted checkout with the user id in the metadata; changes nothing yet', async () => {
    const u = await createUser();
    const url = await startCheckout(u, { kind: 'plan', planId: 'pro' });
    expect(url).toMatch(/^https:\/\//);
    expect(dodo.checkouts.at(-1)).toMatchObject({
      productId: 'prod_pro',
      quantity: 1,
      metadata: { user_id: u.id, kind: 'plan', plan_id: 'pro' },
    });
    expect((await getUser(u.id))!.plan).toBe('free');
  });

  it('top-ups are for paid plans only', async () => {
    const free = await createUser();
    await expect(startCheckout(free, { kind: 'topup', topUpId: 'topup_10' })).rejects.toMatchObject(
      {
        status: 403,
        code: 'plan_limit',
      },
    );
    const pro = await createUser({ plan: 'pro' });
    await startCheckout(pro, { kind: 'topup', topUpId: 'topup_10' });
    expect(dodo.checkouts.at(-1)).toMatchObject({
      productId: 'prod_topup10',
      metadata: { user_id: pro.id, kind: 'topup', top_up_id: 'topup_10' },
    });
    await expect(startCheckout(pro, { kind: 'topup', topUpId: 'topup_99' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('cancel = at the end of the period, through Dodo; the plan stays until then', async () => {
    const u = await member(0);
    await expect(cancelSubscription(u.id)).rejects.toMatchObject({ status: 409 });
    const subId = `sub_${randomUUID()}`;
    await deliver(
      subscriptionEvent('subscription.active', { userId: u.id, subId, ...periodFromNow() }),
    );
    // A second plan checkout while subscribed is refused.
    await expect(
      startCheckout((await getUser(u.id))!, { kind: 'plan', planId: 'max' }),
    ).rejects.toMatchObject({
      status: 400,
    });
    const sub = await cancelSubscription(u.id);
    expect(sub.status).toBe('cancel_at_period_end');
    expect(dodo.cancelled).toContain(subId);
    expect((await getUser(u.id))!.plan).toBe('pro');
  });
});
