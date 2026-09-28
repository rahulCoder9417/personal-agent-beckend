import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { inc } from '../modules/admin/metrics.ts';
import { config } from '../shared/config.ts';
import { rateLimited } from '../shared/errors.ts';
import { logger } from '../shared/logger.ts';
import { hit } from '../shared/rate-limit.ts';
import { clientIp } from './client-ip.ts';
import type { AppEnv } from './types.ts';

/** Client IP for rate limits (see client-ip.ts: the proxy-added X-Forwarded-For entry). */
export const clientIpMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('ip', clientIp(c) ?? 'unknown');
  await next();
};

/** Coarse per-IP limit on every public endpoint (specific endpoints have stricter ones). */
export const ipRateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = c.get('ip');
  if (ip !== 'unknown') {
    const r = await hit({
      key: `ip:${ip}`,
      max: config().RATE_LIMIT_PER_IP_PER_MIN,
      windowSeconds: 60,
    });
    if (!r.allowed) throw rateLimited(r.retryAfter);
  }
  await next();
};

/** Structured access log + request metrics. Never logs bodies or auth headers. */
export const accessLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = performance.now();
  await next();
  const ms = Math.round(performance.now() - start);
  const route = routePath(c) || c.req.path;
  inc('http_requests_total', { method: c.req.method, route, status: c.res.status });
  if (route !== '/healthz') {
    logger().info(
      {
        method: c.req.method,
        route,
        status: c.res.status,
        ms,
        requestId: c.get('requestId' as never),
      },
      'request',
    );
  }
};
