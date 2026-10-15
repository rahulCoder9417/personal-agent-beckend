// Response times of the api's own requests, per route, for the admins
// (`GET /v1/admin/timings/requests`). Each request is counted in Redis, never in Postgres: a
// database write per request would cost a trip to Neon (~260 ms) and grow without end.
//
// Each request's time goes into a bucket ("up to 250 ms"), counted per route, status class and
// time slot, in two sizes of slot:
//   <prefix>:reqtimes:<size>:<slot start>      hash  "<route>|<class>|<bucket>" → requests
//   <prefix>:reqtimes:<size>:<slot start>:max  zset  "<route>|<class>" → the slowest, in ms
// 5-minute slots are kept 2 hours (the last-hour view), hourly slots 8 days (24 hours, 7 days).
// Bounded: about 130 routes × 4 classes × 45 buckets per slot at the very most.
import { config } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';

/**
 * Upper ends of the time buckets, in ms. From 4 ms to 30 s each is at most a third above the one
 * before, so an estimate read inside a bucket is off by at most a third, usually much less.
 */
export const BUCKET_BOUNDS_MS = [
  1,
  2,
  3,
  4,
  5,
  6,
  8,
  10,
  12,
  15,
  20,
  25,
  30,
  40,
  50,
  60,
  75,
  100,
  125,
  150,
  200,
  250,
  300,
  400,
  500,
  600,
  750,
  1000,
  1250,
  1500,
  2000,
  2500,
  3000,
  4000,
  5000,
  6000,
  7500,
  10000,
  12500,
  15000,
  20000,
  25000,
  30000,
  60000,
  Infinity,
];

const MINUTE = 60_000;
const SLOTS = {
  '5m': { ms: 5 * MINUTE, ttlSeconds: 2 * 3600 },
  '1h': { ms: 60 * MINUTE, ttlSeconds: 8 * 86400 },
} as const;
type SlotSize = keyof typeof SLOTS;

/** Each window reads its slot size, the current slot included (so up to one slot more). */
export const WINDOWS = {
  '1h': { size: '5m', slots: 13 },
  '24h': { size: '1h', slots: 25 },
  '7d': { size: '1h', slots: 169 },
} as const satisfies Record<string, { size: SlotSize; slots: number }>;
export type RequestTimesWindow = keyof typeof WINDOWS;

/** The label for a request no route answered (unknown address, or stopped before routing). */
export const NO_ROUTE = '(no route)';

export interface RequestTime {
  method: string;
  /** The route pattern, e.g. `/v1/conversations/:conversationId`; null when no route answered. */
  route: string | null;
  status: number;
  ms: number;
  /** When it ended (epoch ms); now by default. */
  at?: number;
}

export interface RouteTimes {
  route: string;
  count: number;
  clientErrors: number;
  serverErrors: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface RequestTimesSummary {
  window: RequestTimesWindow;
  since: string;
  until: string;
  overall: RouteTimes;
  routes: RouteTimes[];
}

/** The bucket a time falls in: the first upper end at or above it. */
export function bucketOf(ms: number): number {
  return BUCKET_BOUNDS_MS.find((b) => ms <= b)!;
}

/** The lower end of the bucket with this upper end (the next smaller upper end, or 0). */
export function bucketFloor(upper: number): number {
  return BUCKET_BOUNDS_MS.filter((b) => b < upper).at(-1) ?? 0;
}

const label = (bound: number) => (bound === Infinity ? 'inf' : String(bound));
const parseLabel = (s: string) => (s === 'inf' ? Infinity : Number(s));
const statusClass = (status: number) => `${Math.floor(status / 100)}xx`;

function slotKey(size: SlotSize, start: number): string {
  return `${config().QUEUE_PREFIX}:reqtimes:${size}:${new Date(start).toISOString().slice(0, 16)}`;
}
const slotStart = (at: number, size: SlotSize) => at - (at % SLOTS[size].ms);

/**
 * Counts one request's time. Never throws and never makes the request wait: the caller does not
 * await it. A failure is a debug line. While Redis is down the time is dropped, not queued.
 */
export async function recordRequestTime(t: RequestTime): Promise<void> {
  try {
    const r = redis();
    if (r.status === 'reconnecting' || r.status === 'close' || r.status === 'end') return;
    const at = t.at ?? Date.now();
    const series = `${t.method} ${t.route ?? NO_ROUTE}|${statusClass(t.status)}`;
    const field = `${series}|${label(bucketOf(t.ms))}`;
    const p = r.pipeline();
    for (const size of Object.keys(SLOTS) as SlotSize[]) {
      const key = slotKey(size, slotStart(at, size));
      p.hincrby(key, field, 1);
      p.zadd(`${key}:max`, 'GT', t.ms, series);
      p.expire(key, SLOTS[size].ttlSeconds);
      p.expire(`${key}:max`, SLOTS[size].ttlSeconds);
    }
    await p.exec();
  } catch (err) {
    logger().debug({ err: String(err) }, 'request time not counted');
  }
}

/** One route's counts while they are added up. Buckets: upper end → requests. */
interface Tally {
  buckets: Map<number, number>;
  count: number;
  clientErrors: number;
  serverErrors: number;
  max: number;
}

const newTally = (): Tally => ({
  buckets: new Map(),
  count: 0,
  clientErrors: 0,
  serverErrors: 0,
  max: 0,
});

/**
 * The p-th percentile (0 to 1) from bucket counts: the bucket that holds the p-th request, read in
 * a straight line from its lower end to its upper end, or to the slowest request when that is
 * lower. Never above the slowest request. Rounded to whole milliseconds; 0 with no requests.
 */
export function histogramPercentile(buckets: Map<number, number>, p: number, max: number): number {
  const sorted = [...buckets].filter(([, n]) => n > 0).sort(([a], [b]) => a - b);
  const total = sorted.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return 0;
  const rank = p * total;
  let below = 0;
  for (const [upper, n] of sorted) {
    if (below + n >= rank) {
      const lower = bucketFloor(upper);
      const top = Math.max(lower, Math.min(upper, max));
      return Math.round(Math.min(lower + (top - lower) * ((rank - below) / n), max));
    }
    below += n;
  }
  return Math.round(max);
}

function finish(route: string, t: Tally): RouteTimes {
  // The slowest is exact when recorded; if its record is missing, the top bucket's end stands in.
  const topBucket = Math.max(0, ...t.buckets.keys());
  const max = t.max || (topBucket === Infinity ? bucketFloor(Infinity) : topBucket);
  return {
    route,
    count: t.count,
    clientErrors: t.clientErrors,
    serverErrors: t.serverErrors,
    p50Ms: histogramPercentile(t.buckets, 0.5, max),
    p95Ms: histogramPercentile(t.buckets, 0.95, max),
    p99Ms: histogramPercentile(t.buckets, 0.99, max),
    maxMs: Math.round(max),
  };
}

/** Response times per route over the window, slowest p95 first, plus every request together. */
export async function requestTimesSummary(
  window: RequestTimesWindow,
  now = Date.now(),
): Promise<RequestTimesSummary> {
  const { size, slots } = WINDOWS[window];
  const newest = slotStart(now, size);
  const starts = Array.from({ length: slots }, (_, i) => newest - i * SLOTS[size].ms);
  const p = redis().pipeline();
  for (const start of starts) {
    const key = slotKey(size, start);
    p.hgetall(key);
    p.zrange(`${key}:max`, '0', '-1', 'WITHSCORES');
  }
  const results = (await p.exec()) ?? [];

  const byRoute = new Map<string, Tally>();
  const overall = newTally();
  const tallyOf = (route: string) => {
    let t = byRoute.get(route);
    if (!t) byRoute.set(route, (t = newTally()));
    return t;
  };
  for (let i = 0; i < results.length; i += 2) {
    const [hashErr, hash] = results[i]!;
    const [maxErr, maxes] = results[i + 1]!;
    if (hashErr || maxErr) throw hashErr ?? maxErr;
    for (const [field, value] of Object.entries(hash as Record<string, string>)) {
      const cut = field.lastIndexOf('|');
      const series = field.slice(0, cut);
      const bound = parseLabel(field.slice(cut + 1));
      const classCut = series.lastIndexOf('|');
      const route = series.slice(0, classCut);
      const cls = series.slice(classCut + 1);
      const n = Number(value);
      for (const t of [tallyOf(route), overall]) {
        t.buckets.set(bound, (t.buckets.get(bound) ?? 0) + n);
        t.count += n;
        if (cls === '4xx') t.clientErrors += n;
        if (cls === '5xx') t.serverErrors += n;
      }
    }
    const pairs = maxes as string[];
    for (let j = 0; j < pairs.length; j += 2) {
      const route = pairs[j]!.slice(0, pairs[j]!.lastIndexOf('|'));
      const ms = Number(pairs[j + 1]);
      for (const t of [tallyOf(route), overall]) t.max = Math.max(t.max, ms);
    }
  }

  const routes = [...byRoute]
    .filter(([, t]) => t.count > 0)
    .map(([route, t]) => finish(route, t))
    .sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count || a.route.localeCompare(b.route));
  return {
    window,
    since: new Date(starts.at(-1)!).toISOString(),
    until: new Date(now).toISOString(),
    overall: finish('all', overall),
    routes,
  };
}
