// The balance shown in the web app (GET /v1/me, GET /v1/credits, the live `credits.updated`) comes
// from one read of the grants. It must give exactly what the separate reads give, at any moment:
// grants that never expire, ones that expire, ones already expired, spent ones and a debt.
import { describe, expect, it } from 'vitest';
import { getBalanceSummary } from '../src/modules/billing/balance.ts';
import {
  createGrant,
  getBalance,
  getBalanceAndGrants,
  getBalanceAndNextExpiry,
  getNextExpiry,
  listBalanceGrants,
  type GrantSource,
} from '../src/modules/billing/credits.ts';
import { DAY } from './billing-helpers.ts';
import { installDbMeter, meter } from './db-meter.ts';
import { createUser } from './helpers.ts';

let seq = 0;
async function grant(userId: string, source: GrantSource, amount: number, days: number | null) {
  await createGrant({
    userId,
    source,
    amount,
    expiresAt: days === null ? null : new Date(Date.now() + days * DAY),
    idempotencyKey: `credit-reads:${userId}:${seq++}`,
    description: source,
  });
}

/** Today, in 5 days (one grant gone), in 40 days (all but the lasting ones gone). */
const moments = () => [0, 5, 40].map((d) => new Date(Date.now() + d * DAY));

async function expectSameAsSeparateReads(userId: string) {
  for (const now of moments()) {
    const balance = await getBalance(userId, now);
    expect(await getBalanceAndNextExpiry(userId, now)).toEqual({
      balance,
      nextExpiry: await getNextExpiry(userId, now),
    });
    expect(await getBalanceAndGrants(userId, now)).toEqual({
      balance,
      grants: await listBalanceGrants(userId, now),
    });
  }
}

describe('the balance from one read', () => {
  it('no grants at all: 0, no expiry, no grants', async () => {
    const u = await createUser();
    expect(await getBalanceAndNextExpiry(u.id)).toEqual({ balance: 0, nextExpiry: null });
    expect(await getBalanceAndGrants(u.id)).toEqual({ balance: 0, grants: [] });
    await expectSameAsSeparateReads(u.id);
  });

  it('lasting, expiring and partly spent grants', async () => {
    const u = await createUser();
    await grant(u.id, 'topup', 100, null);
    await grant(u.id, 'monthly', 50, 30);
    await grant(u.id, 'coupon', 30, 2);
    // A refund takes 60 back: from the grant that expires first, then the next.
    await grant(u.id, 'refund', -60, null);
    await expectSameAsSeparateReads(u.id);
    expect((await getBalanceAndNextExpiry(u.id)).balance).toBe(120);
  });

  it('a debt (more taken back than was left) counts at every moment', async () => {
    const u = await createUser();
    await grant(u.id, 'coupon', 40, 3);
    await grant(u.id, 'refund', -100, null);
    await expectSameAsSeparateReads(u.id);
    expect((await getBalanceAndGrants(u.id)).balance).toBe(-60);
    // New credits pay the debt first.
    await grant(u.id, 'topup', 500, null);
    await expectSameAsSeparateReads(u.id);
  });

  it("GET /v1/me's summary is one round trip", async () => {
    installDbMeter();
    const u = await createUser();
    await grant(u.id, 'monthly', 70, 10);
    const m = await meter(() => getBalanceSummary(u.id));
    expect(m.queries).toBe(1);
    expect(m.result.balance).toBe(70);
    expect(m.result.nextExpiry).toBeInstanceOf(Date);
  });
});
