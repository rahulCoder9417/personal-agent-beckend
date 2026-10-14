// Routes are declared by operationId; method, path, auth and validation all come from
// openapi/openapi.yaml, so the api can't drift from the contract.
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { verifySessionToken } from '../modules/auth/session.ts';
import { resolveSessionUser } from '../modules/auth/provision.ts';
import type { AppError } from '../shared/errors.ts';
import { accountSuspended, badRequest, forbidden, unauthorized } from '../shared/errors.ts';
import {
  bodyValidator,
  formatErrors,
  getOperation,
  paramValidator,
  type SpecOperation,
} from './openapi/spec.ts';
import type { AppEnv, JsonBody, OperationId, PathParams, QueryParams } from './types.ts';

export interface RouteInput<K extends OperationId> {
  params: PathParams<K>;
  query: QueryParams<K>;
  body: JsonBody<K>;
  /** Raw request body (webhooks verify signatures on this). */
  rawBody: string;
}

export type Handler<K extends OperationId> = (
  c: Context<AppEnv>,
  input: RouteInput<K>,
) => Promise<Response> | Response;

export interface RouteDef {
  operationId: OperationId;
  handler: Handler<OperationId>;
}

export function route<K extends OperationId>(operationId: K, handler: Handler<K>): RouteDef {
  return { operationId, handler: handler as unknown as Handler<OperationId> };
}

export function bearerToken(c: Context): string | undefined {
  const h = c.req.header('authorization');
  if (h?.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return undefined;
}

/** Clerk session → our user. Also accepts `?token=` (SSE) and the `__session` cookie (Bull Board). */
export function requireUser(
  opts: { allowQueryToken?: boolean; allowCookie?: boolean } = {},
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token =
      bearerToken(c) ??
      (opts.allowQueryToken ? c.req.query('token') : undefined) ??
      (opts.allowCookie ? getCookie(c, '__session') : undefined);
    if (!token) throw unauthorized();
    const clerkId = await verifySessionToken(token);
    const user = await resolveSessionUser(clerkId);
    if (!user) throw unauthorized('Account not found');
    // Suspended by an admin: refused everywhere a user signs in, the live stream too.
    if (user.status === 'suspended') throw accountSuspended();
    c.set('user', user);
    await next();
  };
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('user').role !== 'admin') throw forbidden('Admins only');
  await next();
};

function validateParams(
  op: SpecOperation,
  location: 'path' | 'query',
  values: Record<string, unknown>,
) {
  const v = paramValidator(op, location);
  if (!v(values)) throw badRequest(`Invalid ${location} parameters`, { errors: formatErrors(v) });
  return values;
}

export function mountRoutes(app: Hono<AppEnv>, defs: RouteDef[]): void {
  for (const def of defs) {
    const op = getOperation(def.operationId);
    const isWebhook = op.tags.includes('webhooks');
    const middlewares: MiddlewareHandler<AppEnv>[] = [];
    if (op.requiresAuth)
      middlewares.push(requireUser({ allowQueryToken: op.operationId === 'streamEvents' }));
    if (op.tags.includes('admin')) middlewares.push(requireAdmin);

    const main: MiddlewareHandler<AppEnv> = async (c) => {
      const params = validateParams(op, 'path', { ...c.req.param() });
      const query = validateParams(op, 'query', { ...c.req.query() });
      let rawBody = '';
      let body: unknown = undefined;
      if (op.hasJsonBody || isWebhook) {
        rawBody = await c.req.text();
        if (!isWebhook) {
          if (rawBody.length > 0) {
            try {
              body = JSON.parse(rawBody);
            } catch {
              throw badRequest('Body must be valid JSON');
            }
          } else if (op.bodyRequired) {
            throw badRequest('Request body is required');
          }
          const v = bodyValidator(op);
          if (v && body !== undefined && !v(body)) {
            throw badRequest('Invalid request body', { errors: formatErrors(v) });
          }
        }
      }
      return def.handler(c, { params, query, body, rawBody } as RouteInput<OperationId>);
    };

    app.on([op.method.toUpperCase()], [op.honoPath], ...middlewares, main);
  }
}

export function errorResponse(c: Context, err: AppError): Response {
  return c.json(err.toBody(), err.status, err.headers);
}
