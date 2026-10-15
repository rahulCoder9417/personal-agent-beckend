// Response times of the api's requests per route (`GET /v1/admin/timings/requests`): the
// percentile maths on time buckets, the counting in Redis per slot, the windows, the admin-only
// endpoint, and that counting never slows or fails a request.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BUCKET_BOUNDS_MS,
  bucketFloor,
  bucketOf,
  histogramPercentile,
  recordRequestTime,
  requestTimesSummary,
} from '../src/modules/admin/request-times.ts';
import { percentile } from '../src/modules/orchestrator/timings-summary.ts';
import { redis } from '../src/shared/redis.ts';
import { call, createUser, expectContract, waitFor } from './helpers.ts';

/** The buckets these times fall in (what the recorder stores). */
function histogram(values: number[]): Map<number, number> {
  const buckets = new Map<number, number>();
  for (const v of values) buckets.set(bucketOf(v), (buckets.get(bucketOf(v)) ?? 0) + 1);
  return buckets;
}

/** The estimate lies in the same bucket as the exact value: "accurate to one bucket". */
function expectWithinBucket(estimate: number, exact: number) {
  const upper = bucketOf(exact);
  expect(estimate).toBeGreaterThanOrEqual(bucketFloor(upper));
  expect(estimate).toBeLessThanOrEqual(upper);
}

describe('percentiles from time buckets', () => {
  it('the buckets: each a third above the one before at most, from 4 ms to 30 s', () => {
    expect(bucketOf(0)).toBe(1);
    expect(bucketOf(42)).toBe(50);
    expect(bucketOf(50)).toBe(50);
    expect(bucketOf(90_000)).toBe(Infinity);
    expect(bucketFloor(50)).toBe(40);
    expect(bucketFloor(1)).toBe(0);
    for (let i = 1; i < BUCKET_BOUNDS_MS.length; i++) {
      const [lo, hi] = [BUCKET_BOUNDS_MS[i - 1]!, BUCKET_BOUNDS_MS[i]!];
      expect(hi).toBeGreaterThan(lo);
      if (lo >= 4 && hi <= 30_000) expect(hi / lo).toBeLessThanOrEqual(4 / 3 + 1e-9);
    }
  });

  it('1 to 1000 ms evenly: p50, p95, p99 within one bucket of the exact values', () => {
    const values = Array.from({ length: 1000 }, (_, i) => i + 1);
    const buckets = histogram(values);
    for (const p of [0.5, 0.95, 0.99]) {
      const est = histogramPercentile(buckets, p, 1000);
      expectWithinBucket(est, percentile(values, p));
    }
    // And close in fact: p50 ≈ 500, p95 ≈ 950, p99 ≈ 990.
    expect(Math.abs(histogramPercentile(buckets, 0.5, 1000) - 500)).toBeLessThanOrEqual(10);
    expect(Math.abs(histogramPercentile(buckets, 0.95, 1000) - 950)).toBeLessThanOrEqual(10);
    expect(Math.abs(histogramPercentile(buckets, 0.99, 1000) - 990)).toBeLessThanOrEqual(10);
  });

  it('a skewed mix: most fast, a few slow, one very slow', () => {
    // 940 × 18 ms, 50 × 280 ms, 9 × 3500 ms, 1 × 9000 ms.
    const values = [
      ...Array<number>(940).fill(18),
      ...Array<number>(50).fill(280),
      ...Array<number>(9).fill(3500),
      9000,
    ];
    const buckets = histogram(values);
    const sorted = [...values].sort((a, b) => a - b);
    const p50 = histogramPercentile(buckets, 0.5, 9000);
    const p95 = histogramPercentile(buckets, 0.95, 9000);
    const p99 = histogramPercentile(buckets, 0.99, 9000);
    expectWithinBucket(p50, percentile(sorted, 0.5)); // 18 → (15, 20]
    expectWithinBucket(p95, percentile(sorted, 0.95)); // 280 → (250, 300]
    expectWithinBucket(p99, percentile(sorted, 0.99)); // 3500 → (3000, 4000]
    expect(histogramPercentile(buckets, 1, 9000)).toBe(9000);
  });

  it('never above the slowest request, also past the last bucket (over 60 s)', () => {
    expect(histogramPercentile(histogram([42]), 0.99, 42)).toBeLessThanOrEqual(42);
    expect(histogramPercentile(histogram([42]), 0.5, 42)).toBeGreaterThan(40);
    const slow = histogram([90_000, 120_000]);
    expect(histogramPercentile(slow, 0.99, 120_000)).toBeLessThanOrEqual(120_000);
    expect(histogramPercentile(slow, 0.5, 120_000)).toBeGreaterThan(60_000);
  });

  it('no requests: zero', () => {
    expect(histogramPercentile(new Map(), 0.95, 0)).toBe(0);
  });
});

describe('counting in Redis', () => {
  // A fixed past hour, so the requests this file makes for real do not mix in.
  const NOW = Date.UTC(2026, 0, 15, 12, 30, 0);
  const MIN = 60_000;

  beforeAll(async () => {
    const at = NOW - 10 * MIN; // inside the last hour
    for (let i = 1; i <= 100; i++) {
      await recordRequestTime({
        method: 'GET',
        route: '/v1/conversations',
        status: 200,
        ms: i * 10,
        at,
      });
    }
    await recordRequestTime({ method: 'POST', route: '/v1/messages', status: 500, ms: 4000, at });
    await recordRequestTime({ method: 'POST', route: '/v1/messages', status: 401, ms: 3, at });
    await recordRequestTime({ method: 'GET', route: null, status: 404, ms: 2, at });
    // Three hours earlier: in the 24-hour view, not in the last hour.
    await recordRequestTime({
      method: 'GET',
      route: '/v1/me',
      status: 200,
      ms: 25,
      at: NOW - 3 * 60 * MIN,
    });
  });

  it('per route: counts, errors, percentiles and the exact slowest, slowest p95 first', async () => {
    const s = await requestTimesSummary('1h', NOW);
    expect(s.window).toBe('1h');
    expect(s.until).toBe(new Date(NOW).toISOString());
    // 13 five-minute slots: the current one and 12 before it.
    expect(s.since).toBe(new Date(NOW - 60 * MIN).toISOString());
    expect(s.routes.map((r) => r.route)).toEqual([
      'POST /v1/messages',
      'GET /v1/conversations',
      'GET (no route)',
    ]);
    const conv = s.routes.find((r) => r.route === 'GET /v1/conversations')!;
    expect(conv).toMatchObject({ count: 100, clientErrors: 0, serverErrors: 0, maxMs: 1000 });
    const values = Array.from({ length: 100 }, (_, i) => (i + 1) * 10);
    expectWithinBucket(conv.p50Ms, percentile(values, 0.5));
    expectWithinBucket(conv.p95Ms, percentile(values, 0.95));
    expectWithinBucket(conv.p99Ms, percentile(values, 0.99));

    expect(s.routes[0]).toMatchObject({
      route: 'POST /v1/messages',
      count: 2,
      clientErrors: 1,
      serverErrors: 1,
      maxMs: 4000,
    });
    expect(s.overall).toMatchObject({
      route: 'all',
      count: 103,
      clientErrors: 2,
      serverErrors: 1,
      maxMs: 4000,
    });
    expect(s.routes.some((r) => r.route === 'GET /v1/me')).toBe(false);
  });

  it('the 24-hour and 7-day views read hourly slots and reach further back', async () => {
    const day = await requestTimesSummary('24h', NOW);
    expect(day.since).toBe(new Date(Date.UTC(2026, 0, 14, 12)).toISOString());
    expect(day.routes.find((r) => r.route === 'GET /v1/me')).toMatchObject({ count: 1, maxMs: 25 });
    expect(day.overall.count).toBe(104);
    const week = await requestTimesSummary('7d', NOW);
    expect(week.since).toBe(new Date(Date.UTC(2026, 0, 8, 12)).toISOString());
    expect(week.overall.count).toBe(104);
  });

  it('an empty window: no routes, all zero', async () => {
    const s = await requestTimesSummary('1h', NOW + 5 * 60 * MIN);
    expect(s.routes).toEqual([]);
    expect(s.overall).toEqual({
      route: 'all',
      count: 0,
      clientErrors: 0,
      serverErrors: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    });
  });

  it('keys expire: 5-minute slots after 2 hours, hourly slots after 8 days', async () => {
    const keys = await redis().keys(`${process.env.QUEUE_PREFIX}:reqtimes:*2026-01-15T12:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const ttl = await redis().ttl(key);
      if (key.includes(':5m:')) expect(ttl).toBeLessThanOrEqual(2 * 3600);
      else expect(ttl).toBeLessThanOrEqual(8 * 86400);
      expect(ttl).toBeGreaterThan(0);
    }
  });
});

describe('GET /v1/admin/timings/requests', () => {
  afterEach(() => vi.restoreAllMocks());

  it('admins only: 401 without a session, 403 in the Error shape for a user', async () => {
    await expectContract('adminRequestTimes', await call('/v1/admin/timings/requests'), 401);
    const user = await createUser();
    const res = await expectContract<{ error: { code: string; message: string } }>(
      'adminRequestTimes',
      await call('/v1/admin/timings/requests', { token: user.token }),
      403,
    );
    expect(res.error).toEqual({ code: 'forbidden', message: 'Admins only' });
  });

  it("counts the api's real requests by route pattern, never by address or user", async () => {
    const admin = await createUser({ role: 'admin' });
    const user = await createUser();
    for (let i = 0; i < 3; i++) await call('/v1/me', { token: user.token });
    await call('/v1/conversations/cnv_planted_id_123', {
      method: 'PATCH',
      token: user.token,
      body: { title: 'x' },
    });
    await call('/healthz'); // not counted

    type Summary = {
      overall: { count: number };
      routes: Array<{ route: string; count: number; p95Ms: number }>;
    };
    const body = await waitFor(async () => {
      const b = await expectContract<Summary>(
        'adminRequestTimes',
        await call('/v1/admin/timings/requests?window=1h', { token: admin.token }),
        200,
      );
      const me = b.routes.find((r) => r.route === 'GET /v1/me');
      const patch = b.routes.find((r) => r.route === 'PATCH /v1/conversations/:conversationId');
      return me && me.count >= 3 && patch ? b : undefined;
    });
    const p95s = body.routes.map((r) => r.p95Ms);
    expect(p95s).toEqual([...p95s].sort((a, b) => b - a));
    expect(body.routes.some((r) => r.route.includes('healthz'))).toBe(false);
    const text = JSON.stringify(body);
    expect(text).not.toContain('cnv_planted_id_123');
    expect(text).not.toContain(user.id);
  });

  it('defaults to 24 hours; an unknown window is a 400', async () => {
    const admin = await createUser({ role: 'admin' });
    const body = await expectContract<{ window: string }>(
      'adminRequestTimes',
      await call('/v1/admin/timings/requests', { token: admin.token }),
      200,
    );
    expect(body.window).toBe('24h');
    await expectContract(
      'adminRequestTimes',
      await call('/v1/admin/timings/requests?window=30d', { token: admin.token }),
      400,
    );
  });

  it('a Redis failure while counting never fails or holds up the request', async () => {
    vi.spyOn(redis(), 'pipeline').mockImplementation(() => {
      throw new Error('redis is down');
    });
    await expect(
      recordRequestTime({ method: 'GET', route: '/x', status: 200, ms: 1 }),
    ).resolves.toBeUndefined();
    const user = await createUser();
    const res = await call('/v1/me', { token: user.token });
    expect(res.status).toBe(200);
  });
});
