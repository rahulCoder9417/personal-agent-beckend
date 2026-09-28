import { rateLimited } from './errors.ts';
import { redis } from './redis.ts';

export interface Limit {
  /** Key, e.g. `redeem:user:<id>`. */
  key: string;
  max: number;
  windowSeconds: number;
}

const HIT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('TTL', KEYS[1])}`;

/** Fixed-window counter in Redis. Counts this attempt; returns whether it is allowed. */
export async function hit(
  limit: Limit,
): Promise<{ allowed: boolean; retryAfter: number; count: number }> {
  const [count, ttl] = (await redis().eval(HIT, 1, `rl:${limit.key}`, limit.windowSeconds)) as [
    number,
    number,
  ];
  return { allowed: count <= limit.max, retryAfter: Math.max(ttl, 1), count };
}

/** Counts one attempt against every limit; throws 429 if any is exceeded. */
export async function enforce(...limits: Limit[]): Promise<void> {
  let retryAfter = 0;
  for (const l of limits) {
    const r = await hit(l);
    if (!r.allowed) retryAfter = Math.max(retryAfter, r.retryAfter);
  }
  if (retryAfter > 0) throw rateLimited(retryAfter);
}
