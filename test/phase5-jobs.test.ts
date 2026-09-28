import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { createGrant, getBalance } from '../src/modules/billing/credits.ts';
import { freeCreditStats } from '../src/modules/billing/free-credits.ts';
import { handleDodoEvent } from '../src/modules/billing/dodo-events.ts';
import {
  EXPIRE_CREDITS_EVERY_MS,
  SYNC_USAGE_EVERY_MS,
  handleExpireCredits,
  registerBillingSchedules,
} from '../src/modules/billing/jobs.ts';
import { offboardBilling, onboardBilling } from '../src/modules/billing/onboard.ts';
import { creditGrants } from '../src/modules/billing/schema.ts';
import { ingestEvent } from '../src/modules/events/intake.ts';
import { addJob, closeQueues, queue } from '../src/modules/events/queues.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
import { installFakes, member } from './billing-fakes.ts';
import { DAY, fakeJob, grantsOf } from './billing-helpers.ts';
import { installDodo } from './dodo-fakes.ts';
import { createUser, waitFor } from './helpers.ts';

afterAll(closeQueues);
const { llm, vm } = installFakes();
const dodo = installDodo();

describe('onboarding', () => {
  it('grants the 100 sign-up credits and creates the LiteLLM key, once', async () => {
    const u = await createUser();
    const results = await Promise.all([onboardBilling(u.id), onboardBilling(u.id)]);
    await onboardBilling(u.id);
    expect(results.filter((r) => r.signupGranted)).toHaveLength(1);
    const grants = await grantsOf(u.id);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ source: 'signup', amount: 100, expiresAt: null });
    // A parallel onboarding may generate a second key; the loser deletes its own.
    expect([...llm.keys.values()].filter((k) => k.userId === u.id && !k.deleted)).toHaveLength(1);
    expect(llm.remainingBudget(u.id)).toBeCloseTo(0.4, 6);
  });

  it('the free-credit monthly cap blocks new sign-up grants', async () => {
    const stats = await freeCreditStats();
    process.env.FREE_CREDITS_MONTHLY_CAP = String(stats.signupCredits + stats.couponCredits + 50);
    resetConfig();
    try {
      const u = await createUser();
      expect(await onboardBilling(u.id)).toEqual({ signupGranted: false });
      expect(await getBalance(u.id)).toBe(0);
      expect(llm.byUser(u.id)).toBeDefined(); // the key is still created
      const skipped = await db()
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, u.id), eq(auditLog.action, 'signup_credits_skipped')));
      expect(skipped).toHaveLength(1);
    } finally {
      delete process.env.FREE_CREDITS_MONTHLY_CAP;
      resetConfig();
    }
  });

  it('offboarding revokes the key and stops the subscription renewing', async () => {
    const u = await member(0);
    const subId = `sub_${randomUUID()}`;
    const { eventId } = await ingestEvent({
      source: 'dodo',
      externalId: `msg_${randomUUID()}`,
      type: 'subscription.active',
      payload: {
        type: 'subscription.active',
        data: {
          subscription_id: subId,
          product_id: 'prod_pro',
          metadata: { user_id: u.id },
          previous_billing_date: new Date().toISOString(),
          next_billing_date: new Date(Date.now() + 30 * DAY).toISOString(),
        },
      },
      queue: 'system',
      jobName: 'dodo-event',
    });
    await handleDodoEvent(fakeJob({ eventId }));
    const key = llm.byUser(u.id)!.key;
    await offboardBilling(u.id);
    expect(llm.keys.get(key)!.deleted).toBe(true);
    expect(dodo.cancelled).toContain(subId);
  });
});

describe('billing jobs', () => {
  it('are registered with the worker', () => {
    expect(Object.keys(processors().system ?? {})).toEqual(
      expect.arrayContaining(['dodo-event', 'sync-usage', 'expire-credits']),
    );
  });

  it('schedules sync-usage every 5 minutes and expire-credits hourly (idempotent)', async () => {
    await registerBillingSchedules();
    await registerBillingSchedules();
    const schedulers = await queue('system').getJobSchedulers();
    const byId = Object.fromEntries(schedulers.map((s) => [s.key, s.every]));
    expect(Number(byId['sync-usage'])).toBe(SYNC_USAGE_EVERY_MS);
    expect(Number(byId['expire-credits'])).toBe(EXPIRE_CREDITS_EVERY_MS);
    expect(schedulers).toHaveLength(2);
    for (const s of schedulers) await queue('system').removeJobScheduler(s.key);
  });

  it('expire-credits expires grants past their end date', async () => {
    const u = await createUser();
    await createGrant({
      userId: u.id,
      source: 'coupon',
      amount: 200,
      expiresAt: new Date(Date.now() + 50),
      cheapModelOnly: true,
      idempotencyKey: `soon:${u.id}`,
      description: 'coupon',
    });
    await new Promise((r) => setTimeout(r, 60));
    await handleExpireCredits(fakeJob({}));
    const [g] = await db().select().from(creditGrants).where(eq(creditGrants.userId, u.id));
    expect(g!.remaining).toBe(0);
  });

  it('sync-usage runs through the worker (all users, or one user after a turn)', async () => {
    const u = await member(100);
    llm.spend(u.id, 'cheap', 0.008); // 2 credits
    vm.add(u.id, 600); // 1 credit
    const workers = startWorkers(processors());
    try {
      const id = `sync-${randomUUID()}`;
      await addJob('system', 'sync-usage', { userId: u.id }, { jobId: id });
      await waitFor(async () => (await queue('system').getJob(id))?.isCompleted());
      expect(await getBalance(u.id)).toBe(97);
      const all = `sync-all-${randomUUID()}`;
      await addJob('system', 'sync-usage', {}, { jobId: all });
      await waitFor(async () => (await queue('system').getJob(all))?.isCompleted());
      expect(await getBalance(u.id)).toBe(97);
    } finally {
      await Promise.all(workers.map((w) => w.close()));
    }
  });
});
