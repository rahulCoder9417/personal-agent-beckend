import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitlistAttempts, waitlistEntries } from '../src/modules/auth/schema.ts';
import { normalizeEmail } from '../src/modules/auth/waitlist.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { call, createUser, expectContract } from './helpers.ts';

beforeAll(() => {
  process.env.TRUST_PROXY = 'true';
  resetConfig();
});
afterAll(() => {
  delete process.env.TRUST_PROXY;
  resetConfig();
});

// Unique per call, so rate-limit counters of different tests never share an IP.
let ipSeq = Math.floor(Math.random() * 60000);
const ipN = () => {
  ipSeq += 1;
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`;
};
const uniq = () => randomUUID().slice(0, 8);

function join(body: unknown, ip: string, extra: Record<string, string> = {}) {
  return call('/v1/waitlist', {
    method: 'POST',
    body,
    headers: {
      // Caddy appends the real client IP last; anything before it is client-supplied.
      'x-forwarded-for': `10.9.9.9, ${ip}`,
      'user-agent': 'Mozilla/5.0 (test)',
      'accept-language': 'en-IN,en;q=0.9',
      referer: 'https://landing.example/pricing',
      origin: 'https://landing.example',
      ...extra,
    },
  });
}

const entryFor = async (email: string) =>
  (
    await db()
      .select()
      .from(waitlistEntries)
      .where(eq(waitlistEntries.emailNormalized, normalizeEmail(email)))
  )[0];

describe('waitlist: public join', () => {
  it('stores the entry with IP, headers and UTM, and logs the attempt', async () => {
    const ip = ipN();
    const email = `asha.${uniq()}@example.com`;
    const res = await expectContract<{ status: string }>(
      'joinWaitlist',
      await join(
        {
          email,
          name: 'Asha',
          referralSource: 'twitter',
          useCase: 'email triage',
          utm: { source: 'x', campaign: 'launch' },
        },
        ip,
      ),
      202,
    );
    expect(res.status).toBe('ok');
    const e = await entryFor(email);
    expect(e).toMatchObject({
      email,
      name: 'Asha',
      ip,
      forwardedFor: `10.9.9.9, ${ip}`,
      userAgent: 'Mozilla/5.0 (test)',
      acceptLanguage: 'en-IN,en;q=0.9',
      referer: 'https://landing.example/pricing',
      origin: 'https://landing.example',
      utm: { source: 'x', campaign: 'launch' },
      status: 'pending',
      flagged: false,
      submitCount: 1,
    });
    const attempts = await db()
      .select()
      .from(waitlistAttempts)
      .where(eq(waitlistAttempts.entryId, e!.id));
    expect(attempts).toEqual([expect.objectContaining({ outcome: 'created', ip })]);
  });

  it('the same answer for a repeat; Gmail aliases collapse into one entry and are flagged', async () => {
    const ip = ipN();
    const base = `john.doe.${uniq()}`;
    await expectContract('joinWaitlist', await join({ email: `${base}@gmail.com` }, ip), 202);
    const again = await expectContract<{ message: string }>(
      'joinWaitlist',
      await join({ email: `${base}@gmail.com` }, ip),
      202,
    );
    expect(again.message).toContain("You're on the list");
    await expectContract(
      'joinWaitlist',
      await join({ email: `${base.replace('.', '')}+promo@googlemail.com` }, ip),
      202,
    );
    const e = await entryFor(`${base}@gmail.com`);
    expect(e!.submitCount).toBe(3);
    expect(e!.flagReasons).toContain('email_alias');
    expect(e!.flagged).toBe(true);
    const outcomes = (
      await db().select().from(waitlistAttempts).where(eq(waitlistAttempts.entryId, e!.id))
    ).map((a) => a.outcome);
    expect(outcomes.sort()).toEqual(['created', 'duplicate', 'duplicate']);
  });

  it('honeypot: looks accepted, but no entry is made and the attempt is logged', async () => {
    const ip = ipN();
    const email = `bot.${uniq()}@example.com`;
    await expectContract(
      'joinWaitlist',
      await join({ email, website: 'http://spam.example' }, ip),
      202,
    );
    expect(await entryFor(email)).toBeUndefined();
    const [a] = await db()
      .select()
      .from(waitlistAttempts)
      .where(eq(waitlistAttempts.emailNormalized, email));
    expect(a).toMatchObject({ outcome: 'honeypot', ip });
  });

  it('flags disposable emails and bursts from one IP', async () => {
    const ip = ipN();
    await join({ email: `x.${uniq()}@mailinator.com` }, ip);
    const [d] = await db().select().from(waitlistEntries).where(eq(waitlistEntries.ip, ip));
    expect(d!.flagReasons).toContain('disposable_email');
    for (let i = 0; i < 3; i++) await join({ email: `burst${i}.${uniq()}@example.com` }, ip);
    const rows = await db().select().from(waitlistEntries).where(eq(waitlistEntries.ip, ip));
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.flagReasons.includes('ip_burst'))).toHaveLength(1);
  });

  it('rate limits per IP (and logs the blocked attempts)', async () => {
    const ip = ipN();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++)
      statuses.push((await join({ email: `rl${i}.${uniq()}@example.com` }, ip)).status);
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    const res = await join({ email: `rl-last.${uniq()}@example.com` }, ip);
    await expectContract('joinWaitlist', res, 429);
    const blocked = await db().select().from(waitlistAttempts).where(eq(waitlistAttempts.ip, ip));
    expect(blocked.filter((a) => a.outcome === 'rate_limited').length).toBeGreaterThanOrEqual(3);
  });

  it('rejects bad input', async () => {
    const ip = ipN();
    await expectContract('joinWaitlist', await join({ email: 'not-an-email' }, ip), 400);
    await expectContract(
      'joinWaitlist',
      await join({ email: `a.${uniq()}@example.com`, isAdmin: true }, ip),
      400,
    );
    await expectContract(
      'joinWaitlist',
      await join({ email: `a.${uniq()}@example.com`, useCase: 'x'.repeat(501) }, ip),
      400,
    );
  });
});

describe('waitlist: admin', () => {
  it('is admin only', async () => {
    await expectContract('adminListWaitlist', await call('/v1/admin/waitlist'), 401);
    const user = await createUser();
    await expectContract(
      'adminListWaitlist',
      await call('/v1/admin/waitlist', { token: user.token }),
      403,
    );
    await expectContract(
      'adminWaitlistStats',
      await call('/v1/admin/waitlist/stats', { token: user.token }),
      403,
    );
  });

  it('lists with filters, shows abuse stats, and updates entries', async () => {
    const admin = await createUser({ role: 'admin' });
    const ip = ipN();
    const email = `review.${uniq()}@example.com`;
    await join({ email }, ip);
    await join({ email }, ip);
    await join({ email: `other.${uniq()}@example.com` }, ip);

    const byIp = await expectContract<{
      items: Array<{ id: string; email: string; ip: string; userAgent: string }>;
    }>(
      'adminListWaitlist',
      await call(`/v1/admin/waitlist?ip=${ip}&limit=10`, { token: admin.token }),
      200,
    );
    expect(byIp.items).toHaveLength(2);
    expect(byIp.items.every((i) => i.ip === ip && i.userAgent === 'Mozilla/5.0 (test)')).toBe(true);

    const stats = await expectContract<{
      total: number;
      topIps: Array<{ ip: string; entries: number; attempts: number }>;
    }>('adminWaitlistStats', await call('/v1/admin/waitlist/stats', { token: admin.token }), 200);
    expect(stats.total).toBeGreaterThan(0);
    expect(stats.topIps.find((t) => t.ip === ip)).toMatchObject({ entries: 2, attempts: 3 });

    const target = byIp.items.find((i) => i.email === email)!;
    const flagged = await expectContract<{
      flagged: boolean;
      flagReasons: string[];
      status: string;
    }>(
      'adminUpdateWaitlistEntry',
      await call(`/v1/admin/waitlist/${target.id}`, {
        method: 'PATCH',
        token: admin.token,
        body: { flagged: true, status: 'rejected' },
      }),
      200,
    );
    expect(flagged).toMatchObject({ flagged: true, status: 'rejected', flagReasons: ['manual'] });
    const onlyFlagged = await expectContract<{ items: Array<{ id: string }> }>(
      'adminListWaitlist',
      await call(`/v1/admin/waitlist?flagged=true&ip=${ip}`, { token: admin.token }),
      200,
    );
    expect(onlyFlagged.items.map((i) => i.id)).toEqual([target.id]);
    await expectContract(
      'adminUpdateWaitlistEntry',
      await call(`/v1/admin/waitlist/${target.id}`, {
        method: 'PATCH',
        token: admin.token,
        body: {},
      }),
      400,
    );
    await expectContract(
      'adminUpdateWaitlistEntry',
      await call('/v1/admin/waitlist/wl_nope', {
        method: 'PATCH',
        token: admin.token,
        body: { status: 'invited' },
      }),
      404,
    );
  });
});
