// Scout's browser, the platform's side (HLD section 11). The browser itself is in the agent image
// and the vm-manager; here: who has it (the Max plan, and the setting that says the deployed image
// has it), and telling the vm-manager at creation, when the plan changes and after a wake.
// Browser time is charged by the usage sync (test/phase5-usage.test.ts); what the apps are told is
// in test/crew.test.ts and test/phase5-api.test.ts.
import { randomUUID } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import type { Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { getUser, setPlan, type PlanId } from '../src/modules/auth/users.ts';
import { getBalance } from '../src/modules/billing/credits.ts';
import { onPlanChanged } from '../src/modules/billing/hooks.ts';
import { PLANS } from '../src/modules/billing/plans.ts';
import {
  endLapsedSubscriptions,
  getCurrentSubscription,
} from '../src/modules/billing/subscriptions.ts';
import { syncUsageForUser } from '../src/modules/billing/usage.ts';
import { messages } from '../src/modules/channels/schema.ts';
import { ingestEvent } from '../src/modules/events/intake.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import {
  browserWanted,
  handleSyncBrowser,
  queueBrowserSync,
  syncBrowser,
} from '../src/modules/orchestrator/browser.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { runTurn } from '../src/modules/orchestrator/turn.ts';
import { loadConfig, resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { processors } from '../src/worker/processors.ts';
import { startWorkers } from '../src/worker/runner.ts';
// Importing the billing fakes sets the Polar products in the environment.
import './billing-fakes.ts';
import { DAY, fakeJob, turnsBilled } from './billing-helpers.ts';
import { installFakeVm } from './fakes.ts';
import { chatUser, createUser, waitFor } from './helpers.ts';
import { PRODUCTS, installPolar, subscriptionEvent, type SubOpts } from './polar-fakes.ts';

let workers: Worker[];
let fake: ReturnType<typeof installFakeVm>;

beforeAll(() => {
  wireModules();
  installPolar();
  workers = startWorkers(processors(), { retryDelaysMs: [50, 50, 50, 50] });
});
afterAll(async () => {
  await Promise.all(workers.map((w) => w.close()));
  await closeQueues();
});
beforeEach(() => {
  fake = installFakeVm();
  imageHasBrowser(true);
});
afterEach(() => imageHasBrowser(undefined));

/** The setting that says whether the deployed agent image has the browser. */
function imageHasBrowser(on: boolean | undefined): void {
  if (on === undefined) delete process.env.BROWSER_AVAILABLE;
  else process.env.BROWSER_AVAILABLE = String(on);
  resetConfig();
}

/** A user with credits and a container. */
async function withContainer(plan: PlanId = 'free') {
  const u = await chatUser({ plan });
  await ensureSandbox(u.id);
  return u;
}

/** A Polar webhook, through the real intake: the worker runs the event and whatever it queues. */
async function polar(payload: { type: string }) {
  await ingestEvent({
    source: 'polar',
    externalId: `msg_${randomUUID()}`,
    type: payload.type,
    payload: payload as Record<string, unknown>,
    queue: 'system',
    jobName: 'polar-event',
  });
}

const period = () => ({ start: new Date(), end: new Date(Date.now() + 30 * DAY) });
const planOf = async (userId: string) => (await getUser(userId))!.plan;
const callsFor = (userId: string) =>
  fake.browserCalls.filter((c) => c.userId === userId).map((c) => c.enabled);
const switchLog = async (userId: string) =>
  (
    await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.actor, 'system')))
      .orderBy(auditLog.id)
  )
    .filter((e) => e.action.startsWith('browser_'))
    .map((e) => e.action);

const turn = (userId: string) =>
  runTurn({
    userId,
    deliveryId: `evt_${randomUUID()}`,
    kind: 'message',
    sessionKey: 'web',
    channel: 'web',
    text: 'hello',
  });

describe('who has the browser: the Max plan, while the deployed image has it', () => {
  it('the setting is off by default, and then no plan has the browser', () => {
    expect(loadConfig({ ...process.env, BROWSER_AVAILABLE: '' }).BROWSER_AVAILABLE).toBe(false);
    expect(loadConfig({ ...process.env, BROWSER_AVAILABLE: 'true' }).BROWSER_AVAILABLE).toBe(true);
    expect(() => loadConfig({ ...process.env, BROWSER_AVAILABLE: 'yes' })).toThrow(
      /BROWSER_AVAILABLE/,
    );
    expect((['free', 'pro', 'max'] as const).map(browserWanted)).toEqual([false, false, true]);
    imageHasBrowser(false);
    expect((['free', 'pro', 'max'] as const).map(browserWanted)).toEqual([false, false, false]);
    imageHasBrowser(undefined);
    expect(browserWanted('max')).toBe(false);
  });

  it('a new container is created with the browser on for Max and off for Free and Pro', async () => {
    const [free, pro, max] = await Promise.all(
      (['free', 'pro', 'max'] as const).map((plan) => withContainer(plan)),
    );
    expect([free, pro, max].map((u) => fake.browser.get(u!.id))).toEqual([false, false, true]);
    // Nothing more was sent: the state came with CreateSandbox.
    // (Only these users' calls count: another test's job can finish late on a busy machine.)
    expect([free, pro, max].flatMap((u) => callsFor(u!.id))).toEqual([]);

    // The image without the browser: a Max user's container is created with it off.
    imageHasBrowser(false);
    const early = await withContainer('max');
    expect(fake.browser.get(early.id)).toBe(false);
  });
});

describe('the plan changes: the sync-browser job tells the vm-manager', () => {
  it('upgrade to Max → on; downgrade to Pro → off; a renewal changes nothing', async () => {
    const u = await withContainer();
    const fired: string[] = [];
    // Only this user's plan changes: another test's can arrive late on a busy machine.
    const off = onPlanChanged((id) => void (id === u.id && fired.push(id)));
    try {
      const sub: SubOpts = {
        userId: u.id,
        subId: randomUUID(),
        product: PRODUCTS.max,
        ...period(),
      };
      await polar(subscriptionEvent('subscription.active', sub));
      await waitFor(async () => fake.browser.get(u.id) === true);
      expect(await planOf(u.id)).toBe('max');
      expect(callsFor(u.id)).toEqual([true]);

      // Max → Pro on the same subscription.
      await polar(subscriptionEvent('subscription.updated', { ...sub, product: PRODUCTS.pro }));
      await waitFor(async () => fake.browser.get(u.id) === false);
      expect(await planOf(u.id)).toBe('pro');

      // Pro → Max again.
      await polar(subscriptionEvent('subscription.updated', sub));
      await waitFor(async () => fake.browser.get(u.id) === true);
      expect(callsFor(u.id)).toEqual([true, false, true]);
      expect(fired).toEqual([u.id, u.id, u.id]);

      // The next period of the same plan: the plan did not change, so no job is added.
      const next = { ...sub, start: sub.end, end: new Date(sub.end.getTime() + 30 * DAY) };
      await polar(subscriptionEvent('subscription.active', next));
      await waitFor(async () => (await getBalance(u.id)) === 1000 + 2 * PLANS.max.monthlyCredits);
      expect(fired).toHaveLength(3);
      expect(callsFor(u.id)).toEqual([true, false, true]);
      // The user can see in the activity log when the browser was switched.
      expect(await switchLog(u.id)).toEqual([
        'browser_enabled',
        'browser_disabled',
        'browser_enabled',
      ]);
    } finally {
      off();
    }
  });

  it('a cancellation takes effect when the paid period ends: on until then, off after', async () => {
    const u = await withContainer();
    const sub: SubOpts = { userId: u.id, subId: randomUUID(), product: PRODUCTS.max, ...period() };
    await polar(subscriptionEvent('subscription.active', sub));
    await waitFor(async () => fake.browser.get(u.id) === true);

    // Cancelled, but the period is paid for: still Max, the browser stays.
    await polar(subscriptionEvent('subscription.canceled', { ...sub, cancelAtPeriodEnd: true }));
    await waitFor(
      async () => (await getCurrentSubscription(u.id))?.status === 'cancel_at_period_end',
    );
    expect(await endLapsedSubscriptions(new Date(sub.end.getTime() - 1000))).toBe(0);
    expect(await planOf(u.id)).toBe('max');
    expect(fake.browser.get(u.id)).toBe(true);
    expect(callsFor(u.id)).toEqual([true]);

    // The period is over (the hourly job): back to Free, and the browser goes off.
    expect(await endLapsedSubscriptions(new Date(sub.end.getTime() + 1000))).toBe(1);
    await waitFor(async () => fake.browser.get(u.id) === false);
    expect(await planOf(u.id)).toBe('free');
    expect(callsFor(u.id)).toEqual([true, false]);
  });

  it('a subscription that Polar ends at once (revoked) switches the browser off', async () => {
    const u = await withContainer();
    const sub: SubOpts = { userId: u.id, subId: randomUUID(), product: PRODUCTS.max, ...period() };
    await polar(subscriptionEvent('subscription.active', sub));
    await waitFor(async () => fake.browser.get(u.id) === true);
    await polar(
      subscriptionEvent('subscription.revoked', {
        ...sub,
        status: 'canceled',
        endedAt: new Date(),
      }),
    );
    await waitFor(async () => fake.browser.get(u.id) === false);
    expect(await planOf(u.id)).toBe('free');
  });

  it('is safe to repeat: the job sends the wanted state, and only when it differs', async () => {
    const u = await withContainer();
    await setPlan(u.id, 'max');
    expect(await handleSyncBrowser(fakeJob({ userId: u.id }))).toEqual({
      enabled: true,
      changed: true,
    });
    for (let i = 0; i < 3; i++)
      expect(await handleSyncBrowser(fakeJob({ userId: u.id }))).toEqual({
        enabled: true,
        changed: false,
      });
    expect(callsFor(u.id)).toEqual([true]);
    // Through the queue too, several at once.
    await setPlan(u.id, 'pro');
    await Promise.all([queueBrowserSync(u.id), queueBrowserSync(u.id), queueBrowserSync(u.id)]);
    await waitFor(async () => fake.browser.get(u.id) === false);
    await new Promise((r) => setTimeout(r, 200));
    expect(fake.browser.get(u.id)).toBe(false);
    expect(callsFor(u.id).filter((on) => on)).toEqual([true]);
  });

  it('no container yet, or no such user: nothing to do; the container is then created right', async () => {
    const u = await createUser({ plan: 'max' });
    expect(await syncBrowser(u.id)).toBeNull();
    expect(fake.browser.has(u.id)).toBe(false);
    await ensureSandbox(u.id);
    expect(fake.browser.get(u.id)).toBe(true);
    expect(await syncBrowser('usr_nobody')).toBeNull();
    expect(await switchLog(u.id)).toEqual([]);
  });

  it('the vm-manager can’t be reached: the job fails so it is retried, and nothing is logged as switched', async () => {
    const u = await withContainer();
    await setPlan(u.id, 'max');
    fake.state.browserError = new ConnectError('vm-manager is down', Code.Unavailable);
    await expect(syncBrowser(u.id)).rejects.toThrow(/vm-manager is down/);
    expect(await switchLog(u.id)).toEqual([]);
    // Through the queue: the job is tried again, and goes through once the vm-manager is back.
    let failures = 2;
    fake.state.browserError = () =>
      failures-- > 0 ? new ConnectError('vm-manager is down', Code.Unavailable) : null;
    await queueBrowserSync(u.id);
    await waitFor(async () => fake.browser.get(u.id) === true);
    expect(callsFor(u.id)).toEqual([true, true, true, true]); // one direct, then three tries
    expect(await switchLog(u.id)).toEqual(['browser_enabled']);
  });
});

describe('after a wake: what the vm-manager has on record is checked against the plan', () => {
  it('a container made before the browser existed gets it after its next turn; later turns send nothing', async () => {
    imageHasBrowser(false);
    const u = await withContainer('max');
    expect(await turn(u.id)).toBe('done');
    expect(callsFor(u.id)).toEqual([]);

    // The image with the browser is deployed and the setting is switched on.
    imageHasBrowser(true);
    expect(await turn(u.id)).toBe('done');
    expect(callsFor(u.id)).toEqual([true]);
    expect(fake.browser.get(u.id)).toBe(true);
    expect(await turn(u.id)).toBe('done');
    expect(callsFor(u.id)).toEqual([true]);

    // The setting switched off closes it again, whatever the plan.
    imageHasBrowser(false);
    expect(await turn(u.id)).toBe('done');
    expect(callsFor(u.id)).toEqual([true, false]);
    expect(await switchLog(u.id)).toEqual(['browser_enabled', 'browser_disabled']);
  });

  it('a plan change the job never delivered is caught: a user who left Max loses the browser', async () => {
    const u = await withContainer('max');
    expect(fake.browser.get(u.id)).toBe(true);
    await setPlan(u.id, 'free'); // changed with no job (say it ran out of tries)
    expect(await turn(u.id)).toBe('done');
    expect(callsFor(u.id)).toEqual([false]);
    expect(fake.browser.get(u.id)).toBe(false);
  });

  it('never fails the turn: if the switch can’t be sent, the turn runs and the next one tries again', async () => {
    imageHasBrowser(false);
    const u = await withContainer('max');
    imageHasBrowser(true);
    fake.state.browserError = new ConnectError('vm-manager is busy', Code.Unavailable);
    expect(await turn(u.id)).toBe('done');
    expect(fake.browser.get(u.id)).toBe(false);
    fake.state.browserError = null;
    expect(await turn(u.id)).toBe('done');
    expect(fake.browser.get(u.id)).toBe(true);
    expect(callsFor(u.id)).toEqual([true, true]);
    expect(fake.deliveries.filter((d) => d.userId === u.id)).toHaveLength(2);
  });
});

describe('browser time and credits', () => {
  it('a user at zero credits is not woken, so no browser runs; they are told where to top up', async () => {
    const u = await createUser({ plan: 'max' });
    await ensureSandbox(u.id);
    expect(fake.browser.get(u.id)).toBe(true);
    expect(await getBalance(u.id)).toBe(0);
    expect(await turn(u.id)).toBe('out_of_credits');
    expect(fake.wakes).not.toContain(u.id);
    expect(fake.deliveries.filter((d) => d.userId === u.id)).toEqual([]);
    const [reply] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, u.id), eq(messages.direction, 'out')));
    expect(reply!.text).toMatch(/out of credits/);
  });

  it('browser minutes that use up the credits stop the next turn before the wake', async () => {
    const u = await chatUser({ plan: 'max', credits: 10 });
    await ensureSandbox(u.id);
    expect(await turn(u.id)).toBe('done');
    await turnsBilled(u.id); // its billing runs as a job after the turn
    expect(fake.wakes.filter((id) => id === u.id)).toHaveLength(1);
    // Ten minutes of browser time in that turn: 20 credits, more than the 10 there were.
    fake.state.usage.set(u.id, { awakeSeconds: 0n, browserSeconds: 600n });
    const sync = await syncUsageForUser(u.id);
    fake.state.usage.delete(u.id);
    expect(sync.charged).toBe(20);
    expect(sync.balance).toBe(-10); // no wake fee (removed 18 Oct 2026)
    expect(await turn(u.id)).toBe('out_of_credits');
    expect(fake.wakes.filter((id) => id === u.id)).toHaveLength(1);
  });
});
