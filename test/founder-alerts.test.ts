// Founder alerts on Telegram: sign-ups, server usage bands, paying clients, errors. The Telegram
// Bot API is a fake; the system queue's founder-alert jobs are run by hand.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { alert } from '../src/modules/admin/alerts.ts';
import { handleFounderAlert, notifyFounder } from '../src/modules/admin/ops-alerts.ts';
import {
  bandOf,
  handleUsageCheck,
  nextBandState,
  type Metric,
  type Reading,
} from '../src/modules/admin/usage-alerts.ts';
import { setTelegramApi } from '../src/modules/channels/adapters/telegram.ts';
import { provisionUser } from '../src/modules/auth/provision.ts';
import { handlePolarEvent } from '../src/modules/billing/polar-events.ts';
import { ingestEvent } from '../src/modules/events/intake.ts';
import { closeQueues, queue } from '../src/modules/events/queues.ts';
import { resetConfig } from '../src/shared/config.ts';
import { redis } from '../src/shared/redis.ts';
import { installFakes } from './billing-fakes.ts';
import { DAY, fakeJob, linkChat } from './billing-helpers.ts';
import { createUser } from './helpers.ts';
import {
  PRODUCTS,
  installPolar,
  orderPaid,
  refundEvent,
  subscriptionEvent,
  topUpOrder,
} from './polar-fakes.ts';

installFakes();
const sent: Array<{ chat: string; text: string }> = [];
setTelegramApi(async (method, body) => {
  if (method === 'sendMessage') sent.push({ chat: String(body.chat_id), text: String(body.text) });
  return { message_id: 1 };
});
afterAll(async () => {
  setTelegramApi(undefined);
  await closeQueues();
});

function setEnv(env: Record<string, string>) {
  Object.assign(process.env, env);
  resetConfig();
}
beforeAll(() => setEnv({ FOUNDER_TELEGRAM_CHAT_IDS: '111,222' }));
beforeEach(async () => {
  sent.length = 0;
  await queue('system').obliterate({ force: true });
  const keys = [...(await redis().keys('founder-*'))];
  if (keys.length) await redis().del(...keys);
});

/** Runs the founder-alert jobs that are waiting, like the worker would. */
async function drain() {
  const jobs = await queue('system').getJobs(['waiting', 'delayed', 'prioritized']);
  for (const job of jobs.filter((j) => j.name === 'founder-alert').reverse()) {
    await handleFounderAlert(job);
    await job.remove();
  }
}
const texts = () => [...new Set(sent.map((s) => s.text))];

describe('notifyFounder', () => {
  it('sends once to every configured chat, and a repeated key sends nothing more', async () => {
    await notifyFounder('payment', 'hello', 'k1');
    await notifyFounder('payment', 'hello', 'k1');
    await drain();
    expect(sent).toEqual([
      { chat: '111', text: 'hello' },
      { chat: '222', text: 'hello' },
    ]);
  });

  it('falls back to the linked Telegram chat of admins when no chat id is configured', async () => {
    setEnv({ FOUNDER_TELEGRAM_CHAT_IDS: '' });
    const admin = await createUser({ role: 'admin' });
    const other = await createUser();
    await linkChat(admin.id, '9001');
    await linkChat(other.id, '9002');
    await notifyFounder('payment', 'to admins');
    await drain();
    expect(sent.map((s) => s.chat)).toEqual(['9001']);
    setEnv({ FOUNDER_TELEGRAM_CHAT_IDS: '111,222' });
  });

  it('a muted kind sends nothing', async () => {
    setEnv({ FOUNDER_ALERT_PAYMENTS: 'false' });
    await notifyFounder('payment', 'muted');
    await drain();
    expect(sent).toEqual([]);
    setEnv({ FOUNDER_ALERT_PAYMENTS: 'true' });
  });

  it('a failed send does not throw into the caller; the job only fails when no chat got it', async () => {
    setTelegramApi(async () => {
      throw new Error('telegram down');
    });
    await expect(notifyFounder('payment', 'x', 'kfail')).resolves.toBeUndefined();
    const [job] = (await queue('system').getJobs(['waiting'])).filter(
      (j) => j.name === 'founder-alert',
    );
    await expect(handleFounderAlert(job!)).rejects.toThrow('not sent');
    setTelegramApi(async (m, b) => {
      if (m === 'sendMessage' && b.chat_id === '111') throw new Error('blocked');
      sent.push({ chat: String(b.chat_id), text: String(b.text) });
      return {};
    });
    await expect(handleFounderAlert(job!)).resolves.toEqual({ sent: 1 });
    setTelegramApi(async (m, b) => {
      if (m === 'sendMessage') sent.push({ chat: String(b.chat_id), text: String(b.text) });
      return { message_id: 1 };
    });
  });
});

describe('sign-up', () => {
  it('tells once per user with name, email, way and total, and again calls add nothing', async () => {
    const data = {
      clerkId: `user_${randomUUID()}`,
      email: 'new@example.com',
      emailVerified: true,
      name: 'Nia New',
      role: 'user' as const,
      via: 'Google' as const,
    };
    await provisionUser(data);
    await provisionUser(data);
    await drain();
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toMatch(
      /^New sign-up: Nia New new@example\.com, via Google, total users: \d+$/,
    );
  });
});

describe('server usage bands', () => {
  it('alerts on a new band, and keeps quiet until the metric falls a whole band below', () => {
    expect(bandOf(9.9)).toBe(0);
    expect(bandOf(70)).toBe(70);
    expect(bandOf(100)).toBe(100);
    let st = { band: 0, high: false };
    const step = (pct: number) => {
      const r = nextBandState(st, pct);
      st = r.state;
      return r.alert;
    };
    expect(step(10)).toBe('band');
    expect(step(20)).toBe('band');
    expect(step(15)).toBeNull();
    expect(step(20)).toBeNull(); // 20 -> 15 -> 20: quiet
    expect(step(5)).toBeNull();
    expect(step(20)).toBe('band'); // 20 -> 5 -> 20: again
    expect(step(85)).toBe('band');
    expect(step(60)).toBeNull();
    expect(step(40)).toBe('normal'); // was 80+, now under 50
    expect(step(41)).toBeNull();
  });

  it('the job alerts per metric and remembers the band in Redis', async () => {
    let pct = 72;
    const readers: Record<Metric, () => Promise<Reading>> = {
      disk: async () => ({ pct, label: '26 of 38 GB' }),
      memory: async () => {
        throw new Error('no meminfo');
      },
      agents: async () => ({ pct: 75, label: '6/8' }),
    };
    await handleUsageCheck(readers);
    await handleUsageCheck(readers);
    pct = 91;
    await handleUsageCheck(readers);
    await drain();
    expect(texts()).toEqual([
      'Disk 72% (26 of 38 GB), band 70%',
      'Agents awake 6/8 = 75% (band 70%)',
      'Disk 91% (26 of 38 GB), band 90%',
    ]);
  });
});

describe('errors', () => {
  it('an ops alert reaches the founder, at most once per kind every 10 minutes, with no secrets', async () => {
    await alert('Nightly backup failed', {
      err: 'boom token=sk-ant-PLANTEDplanted0123456789abcdef',
    });
    await alert('Nightly backup failed', { err: 'again' });
    await alert('Health check failed', { problems: ['redis'] });
    await drain();
    const t = texts();
    expect(t).toHaveLength(2);
    expect(t[0]).toContain('Problem: Nightly backup failed');
    expect(t.join('\n')).not.toContain('sk-ant-PLANTED');
  });
});

describe('paying clients', () => {
  let user: Awaited<ReturnType<typeof createUser>>;
  beforeEach(() => {
    installPolar();
  });
  async function deliver(payload: { type: string }) {
    const { eventId } = await ingestEvent({
      source: 'polar',
      externalId: `msg_${randomUUID()}`,
      type: payload.type,
      payload: payload as Record<string, unknown>,
      queue: 'system',
      jobName: 'polar-event',
    });
    await handlePolarEvent(fakeJob({ eventId }));
    return eventId;
  }
  const sub = () => ({
    userId: user.id,
    subId: `sub_${randomUUID()}`,
    start: new Date(),
    end: new Date(Date.now() + 30 * DAY),
  });

  it('one alert for each event: subscription, top-up, cancel, resume, past due, end, refund', async () => {
    user = await createUser();
    const s = sub();
    await deliver(subscriptionEvent('subscription.active', s));
    await deliver(
      orderPaid(
        { userId: user.id, orderId: `o_${randomUUID()}`, product: PRODUCTS.pro, netAmount: 1900 },
        s,
      ),
    );
    const topOrder = `o_${randomUUID()}`;
    await deliver(topUpOrder(user.id, topOrder));
    await deliver(subscriptionEvent('subscription.canceled', { ...s, cancelAtPeriodEnd: true }));
    await deliver(subscriptionEvent('subscription.uncanceled', s));
    await deliver(subscriptionEvent('subscription.past_due', { ...s, status: 'past_due' }));
    await deliver(refundEvent({ orderId: topOrder, amount: 1000 }));
    await deliver(
      subscriptionEvent('subscription.revoked', { ...s, status: 'canceled', endedAt: new Date() }),
    );
    await drain();
    const t = texts();
    expect(t.some((x) => x.startsWith('New subscription:') && x.includes('Pro $19/month'))).toBe(
      true,
    );
    expect(t.some((x) => x.startsWith('Top-up bought:') && x.includes('$10'))).toBe(true);
    for (const w of [
      'Cancellation:',
      'Resumed:',
      'Payment failed (past due):',
      'Refund:',
      'Plan ended:',
    ]) {
      expect(
        t.some((x) => x.startsWith(w)),
        w,
      ).toBe(true);
    }
    expect(t.filter((x) => x.startsWith('New subscription:'))).toHaveLength(1);
    expect(t.every((x) => x.includes(user.email))).toBe(true);
  });

  it('a renewal says Renewal, and running the same event again adds no second alert', async () => {
    user = await createUser();
    const s = sub();
    await deliver(subscriptionEvent('subscription.active', s));
    const renew = orderPaid(
      {
        userId: user.id,
        orderId: `o_${randomUUID()}`,
        product: PRODUCTS.pro,
        netAmount: 1900,
        billingReason: 'subscription_cycle',
      },
      { ...s, start: new Date(Date.now() + 31 * DAY), end: new Date(Date.now() + 61 * DAY) },
    );
    const eventId = await deliver(renew);
    await handlePolarEvent(fakeJob({ eventId }));
    await drain();
    expect(texts().filter((x) => x.startsWith('Renewal:'))).toHaveLength(1);
  });
});
