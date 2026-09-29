// Waitlist offer: 50% off the first month of Pro or Max, applied automatically at checkout.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users, waitlistEntries } from '../src/modules/auth/schema.ts';
import { findWaitlistOffer, joinWaitlist, normalizeEmail } from '../src/modules/auth/waitlist.ts';
import { handleDodoEvent } from '../src/modules/billing/dodo-events.ts';
import { ingestEvent } from '../src/modules/events/intake.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { installFakes } from './billing-fakes.ts';
import { DAY, fakeJob } from './billing-helpers.ts';
import { installDodo } from './dodo-fakes.ts';
import { call, createUser, expectContract } from './helpers.ts';

installFakes();
const dodo = installDodo();
const CODE = 'WAITLIST50';

beforeAll(() => {
  process.env.DODO_WAITLIST_DISCOUNT_CODE = CODE;
  resetConfig();
});
afterAll(async () => {
  delete process.env.DODO_WAITLIST_DISCOUNT_CODE;
  resetConfig();
  await closeQueues();
});

const req = { ip: '203.0.113.9', userAgent: 'test' };

async function waitlisted(
  opts: { emailVerified?: boolean; waitlistEmail?: (email: string) => string } = {},
) {
  const u = await createUser({ emailVerified: opts.emailVerified ?? true });
  await joinWaitlist(
    { email: opts.waitlistEmail ? opts.waitlistEmail(u.email) : u.email },
    { ...req, ip: `203.0.113.${Math.floor(Math.random() * 250)}` },
  );
  return u;
}

const checkout = (token: string, body: unknown) =>
  call('/v1/billing/checkout', { method: 'POST', token, body });

describe('waitlist offer at checkout', () => {
  it('a verified waitlist member gets the discount code on a plan checkout', async () => {
    const u = await waitlisted();
    const res = await expectContract<{ checkoutUrl: string; discountApplied: boolean }>(
      'createCheckout',
      await checkout(u.token, { kind: 'plan', planId: 'max' }),
      200,
    );
    expect(res.discountApplied).toBe(true);
    const sent = dodo.checkouts.at(-1)!;
    expect(sent.discountCode).toBe(CODE);
    const offer = await findWaitlistOffer(u.email);
    expect(sent.metadata).toMatchObject({
      user_id: u.id,
      plan_id: 'max',
      waitlist_offer_entry: offer!.entryId,
    });
  });

  it('matches Gmail aliases of the same inbox', async () => {
    const local = `jane.doe.${randomUUID().slice(0, 6)}`;
    const u = await createUser();
    await db()
      .update(users)
      .set({ email: `${local.replace(/\./g, '')}@gmail.com` })
      .where(eq(users.id, u.id));
    await joinWaitlist({ email: `${local}+beta@googlemail.com` }, req);
    const res = await expectContract<{ discountApplied: boolean }>(
      'createCheckout',
      await checkout(u.token, { kind: 'plan', planId: 'pro' }),
      200,
    );
    expect(res.discountApplied).toBe(true);
  });

  it('is used once: the subscription starting marks it used', async () => {
    const u = await waitlisted();
    await checkout(u.token, { kind: 'plan', planId: 'pro' });
    const { metadata } = dodo.checkouts.at(-1)!;
    const subId = `sub_${randomUUID()}`;
    const payload = {
      type: 'subscription.active',
      timestamp: new Date().toISOString(),
      data: {
        subscription_id: subId,
        product_id: 'prod_pro',
        status: 'active',
        metadata,
        previous_billing_date: new Date().toISOString(),
        next_billing_date: new Date(Date.now() + 30 * DAY).toISOString(),
      },
    };
    const { eventId } = await ingestEvent({
      source: 'dodo',
      externalId: `msg_${randomUUID()}`,
      type: payload.type,
      payload,
      queue: 'system',
      jobName: 'dodo-event',
    });
    await handleDodoEvent(fakeJob({ eventId }));
    const [entry] = await db()
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.emailNormalized, normalizeEmail(u.email)));
    expect(entry!.offerUsedAt).not.toBeNull();
    expect(await findWaitlistOffer(u.email)).toBeNull();
  });

  it('no discount: unverified email, not on the list, rejected or flagged entry, top-ups', async () => {
    const unverified = await waitlisted({ emailVerified: false });
    const discounted = async (token: string) =>
      (
        await expectContract<{ discountApplied: boolean }>(
          'createCheckout',
          await checkout(token, { kind: 'plan', planId: 'pro' }),
          200,
        )
      ).discountApplied;
    expect(await discounted(unverified.token)).toBe(false);

    const stranger = await createUser();
    expect(await discounted(stranger.token)).toBe(false);

    for (const patch of [{ status: 'rejected' as const }, { flagged: true }]) {
      const u = await waitlisted();
      await db()
        .update(waitlistEntries)
        .set(patch)
        .where(eq(waitlistEntries.emailNormalized, normalizeEmail(u.email)));
      const res = await expectContract<{ discountApplied: boolean }>(
        'createCheckout',
        await checkout(u.token, { kind: 'plan', planId: 'pro' }),
        200,
      );
      expect(res.discountApplied).toBe(false);
      expect(dodo.checkouts.at(-1)!.discountCode).toBeUndefined();
    }

    const paid = await waitlisted();
    await db().update(users).set({ plan: 'pro' }).where(eq(users.id, paid.id));
    const topup = await expectContract<{ discountApplied: boolean }>(
      'createCheckout',
      await checkout(paid.token, { kind: 'topup', topUpId: 'topup_10' }),
      200,
    );
    expect(topup.discountApplied).toBe(false);
  });

  it('no discount when the Dodo code is not configured', async () => {
    delete process.env.DODO_WAITLIST_DISCOUNT_CODE;
    resetConfig();
    try {
      const u = await waitlisted();
      const res = await expectContract<{ discountApplied: boolean }>(
        'createCheckout',
        await checkout(u.token, { kind: 'plan', planId: 'pro' }),
        200,
      );
      expect(res.discountApplied).toBe(false);
    } finally {
      process.env.DODO_WAITLIST_DISCOUNT_CODE = CODE;
      resetConfig();
    }
  });
});
