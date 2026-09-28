import { randomUUID } from 'node:crypto';
import { importPKCS8, SignJWT } from 'jose';
import { Webhook } from 'svix';
import { expect } from 'vitest';
import { createApp } from '../src/api/app.ts';
import { formatErrors, responseValidator } from '../src/api/openapi/spec.ts';
import { upsertUserFromClerk, type User } from '../src/modules/auth/users.ts';
import { users } from '../src/modules/auth/schema.ts';
import { db } from '../src/shared/db/client.ts';
import { eq } from 'drizzle-orm';

let app: ReturnType<typeof createApp> | undefined;
export function testApp() {
  app ??= createApp();
  return app;
}

export async function sessionToken(clerkId: string): Promise<string> {
  const key = await importPKCS8(process.env.TEST_JWT_PRIVATE_KEY!, 'RS256');
  return new SignJWT({ sid: 'sess_test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test', typ: 'JWT' })
    .setSubject(clerkId)
    .setIssuedAt()
    .setNotBefore(Math.floor(Date.now() / 1000) - 5)
    .setExpirationTime('10m')
    .sign(key);
}

/**
 * A signed-in test user. `credits` seeds a grant (default 0, so billing tests start empty;
 * chat tests pass credits so turns go through the real balance check).
 */
export async function createUser(
  overrides: Partial<User> & { credits?: number } = {},
): Promise<User & { token: string }> {
  const clerkId = `user_${randomUUID()}`;
  const { user } = await upsertUserFromClerk({
    clerkId,
    email: `${clerkId}@example.com`,
    emailVerified: overrides.emailVerified ?? true,
    name: 'Test User',
    role: overrides.role ?? 'user',
  });
  const extra = { ...overrides };
  delete extra.emailVerified;
  delete extra.role;
  delete extra.credits;
  if (overrides.credits) {
    const { createGrant } = await import('../src/modules/billing/credits.ts');
    await createGrant({
      userId: user.id,
      source: 'admin',
      amount: overrides.credits,
      expiresAt: null,
      idempotencyKey: `test-seed:${user.id}`,
      description: 'test seed',
    });
  }
  let row = user;
  if (Object.keys(extra).length) {
    [row] = (await db().update(users).set(extra).where(eq(users.id, user.id)).returning()) as [
      User,
    ];
  }
  return { ...row, token: await sessionToken(clerkId) };
}

type ReqInit = {
  method?: string;
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
};

export async function call(path: string, init: ReqInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...init.headers };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    headers['content-type'] ??= 'application/json';
  }
  return testApp().request(path, { method: init.method ?? 'GET', headers, body });
}

/** Asserts the response status is documented for the operation and the body matches the spec. */
export async function expectContract<T = unknown>(
  operationId: string,
  res: Response,
  status: number,
): Promise<T> {
  const text = await res.text();
  expect(res.status, `unexpected status; body: ${text}`).toBe(status);
  const validate = responseValidator(operationId, status);
  const body = text ? JSON.parse(text) : undefined;
  if (validate) {
    const ok = validate(body);
    expect(
      ok,
      `${operationId} ${status} does not match openapi.yaml: ${JSON.stringify(formatErrors(validate))}\n${text}`,
    ).toBe(true);
  }
  return body as T;
}

export function signClerk(payload: unknown, msgId = `msg_${randomUUID()}`) {
  const secret = process.env.CLERK_WEBHOOK_SECRET!;
  const body = JSON.stringify(payload);
  const timestamp = new Date();
  const signature = new Webhook(secret).sign(msgId, timestamp, body);
  return {
    body,
    headers: {
      'svix-id': msgId,
      'svix-timestamp': String(Math.floor(timestamp.getTime() / 1000)),
      'svix-signature': signature,
      'content-type': 'application/json',
    },
  };
}

export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A user with credits (for tests that run agent turns through the real balance check). */
export function chatUser(overrides: Partial<User> & { credits?: number } = {}) {
  return createUser({ credits: 1000, ...overrides });
}
