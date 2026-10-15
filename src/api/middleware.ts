import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { inc } from '../modules/admin/metrics.ts';
import { recordRequestTime } from '../modules/admin/request-times.ts';
import { config } from '../shared/config.ts';
import { rateLimited } from '../shared/errors.ts';
import { newId } from '../shared/ids.ts';
import { logger } from '../shared/logger.ts';
import { hit } from '../shared/rate-limit.ts';
import { runInRequest } from '../shared/request-context.ts';
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

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** A caller's own request id is kept only if it is short and plain: letters, digits, `_` and `-`. */
const SAFE_REQUEST_ID = /^[\w-]{1,64}$/;

/** Routes polled by machines (Docker's health check, Prometheus): debug lines, times not counted. */
const QUIET_ROUTES = new Set(['/healthz', '/metrics']);

/** Longest path written to the log; a longer one is cut (a scanner can send any length). */
const MAX_LOGGED_PATH = 200;

/** The caller's id when it looks safe, else a new one (`req_…`, time-sortable). */
export function requestIdFor(given: string | undefined): string {
  return given && SAFE_REQUEST_ID.test(given) ? given : newId('req');
}

/**
 * The route pattern that answered (e.g. `/v1/conversations/:conversationId`). Null when none did:
 * an unknown address, or a request stopped before routing (the per-address limit), which leaves
 * the pattern of the app-wide middleware (`/*`).
 */
export function routeOf(c: Context): string | null {
  const pattern = routePath(c);
  return pattern && pattern !== '/*' && pattern !== '*' ? pattern : null;
}

/**
 * The request log: one structured line per request, written when the answer is ready. It gives
 * the request an id (kept for the whole request: every log line written meanwhile carries it, and
 * the answer has it in `X-Request-Id`), and logs method, route pattern, path, status, time taken,
 * the signed-in user and the client IP. Never a body, a header or the query string (where tokens
 * and one-time codes travel). 5xx is logged as an error, 4xx as a warning; `/healthz` and
 * `/metrics` only at debug. Also counts the request for `/metrics`, and its time per route for the
 * admins' response-time view (in Redis, without waiting: see modules/admin/request-times.ts).
 */
export const requestLog: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = performance.now();
  const requestId = requestIdFor(c.req.header(REQUEST_ID_HEADER));
  c.set('requestId', requestId);
  c.header(REQUEST_ID_HEADER, requestId);
  await runInRequest({ requestId }, next);
  // A route that built its own Response (/mcp, /git, file downloads) skipped the header above.
  if (c.res.headers.get(REQUEST_ID_HEADER) !== requestId) c.header(REQUEST_ID_HEADER, requestId);

  const ms = Math.round(performance.now() - start);
  const route = routeOf(c);
  const status = c.res.status;
  const quiet = route !== null && QUIET_ROUTES.has(route);
  inc('http_requests_total', { method: c.req.method, route: route ?? 'none', status });
  if (!quiet) void recordRequestTime({ method: c.req.method, route, status, ms });

  const userId = c.get('user')?.id ?? c.get('containerUserId');
  const path = c.req.path; // the address only: the query string is never logged
  const line = {
    requestId,
    method: c.req.method,
    route,
    path: path.length > MAX_LOGGED_PATH ? `${path.slice(0, MAX_LOGGED_PATH)}…` : path,
    status,
    ms,
    ...(userId ? { userId } : {}),
    ip: c.get('ip'),
  };
  const level = quiet ? 'debug' : status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
  logger()[level](line, 'request');
};
