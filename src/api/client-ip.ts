import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { config } from '../shared/config.ts';

/**
 * The caller's IP (rate limits, coupon abuse signals). Behind Caddy (TRUST_PROXY=true) it is the
 * last X-Forwarded-For entry — the one our proxy added, which a client can't forge.
 */
export function clientIp(c: Context): string | null {
  if (config().TRUST_PROXY) {
    const parts = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}
