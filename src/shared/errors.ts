import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Always rendered as the OpenAPI `Error` shape: { error: { code, message, details? } }. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }

  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, 'invalid_request', message, details);
export const unauthorized = (message = 'Missing or invalid session') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const planLimit = (message: string, details?: Record<string, unknown>) =>
  new AppError(403, 'plan_limit', message, details);
export const outOfCredits = () =>
  new AppError(
    402,
    'out_of_credits',
    'You are out of credits. Upgrade, top up or redeem a coupon.',
  );
export const rateLimited = (retryAfterSeconds: number) =>
  new AppError(429, 'rate_limited', 'Too many requests', undefined, {
    'Retry-After': String(retryAfterSeconds),
  });
