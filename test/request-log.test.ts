// The request log: one structured line per HTTP request (method, route, path, status, time, user,
// client IP, request id), the request id on every answer and on every log line written during the
// request, the right level per status, and never a secret: no header, body or query string.
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.ts';
import { requestIdFor } from '../src/api/middleware.ts';
import { sandboxTokens } from '../src/modules/orchestrator/schema.ts';
import { resetConfig } from '../src/shared/config.ts';
import { sha256Hex } from '../src/shared/crypto.ts';
import { db } from '../src/shared/db/client.ts';
import { buildLogger, setLogger } from '../src/shared/logger.ts';
import { call, createUser, signClerk, testApp } from './helpers.ts';

type Line = Record<string, unknown> & { level: number; msg: string };

let raw: string[] = [];
const text = () => raw.join('');
const lines = (): Line[] => raw.map((l) => JSON.parse(l) as Line);
const requestLines = () => lines().filter((l) => l.msg === 'request');
const lineFor = (requestId: string | null) => requestLines().find((l) => l.requestId === requestId);

beforeEach(() => {
  raw = [];
  setLogger(
    buildLogger(
      new Writable({
        write(chunk, _enc, cb) {
          raw.push(String(chunk));
          cb();
        },
      }),
      'trace',
    ),
  );
});
afterEach(() => setLogger(undefined));

describe('one line per request', () => {
  it('logs method, route, path, status, time, user, IP and the id the answer carries', async () => {
    const u = await createUser();
    const res = await call(`/v1/me`, { token: u.token });
    expect(res.status).toBe(200);
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^req_[0-9a-z]{26}$/);
    const line = lineFor(id)!;
    expect(line).toMatchObject({
      level: 30, // info
      msg: 'request',
      method: 'GET',
      route: '/v1/me',
      path: '/v1/me',
      status: 200,
      userId: u.id,
      ip: 'unknown', // no proxy and no socket in tests
    });
    expect(typeof line.ms).toBe('number');
    expect(requestLines()).toHaveLength(1);
  });

  it('logs the route pattern and the path, never the query string', async () => {
    const u = await createUser();
    const res = await call(`/v1/conversations/cnv_doesnotexist?limit=5&cursor=c_abc`, {
      method: 'PATCH',
      token: u.token,
      body: { title: 'x' },
    });
    const line = lineFor(res.headers.get('x-request-id'))!;
    expect(line.route).toBe('/v1/conversations/:conversationId');
    expect(line.path).toBe('/v1/conversations/cnv_doesnotexist');
    expect(text()).not.toContain('c_abc');
    expect(text()).not.toContain('limit=5');
  });

  it('behind Caddy, logs the address Caddy added (the last X-Forwarded-For entry)', async () => {
    process.env.TRUST_PROXY = 'true';
    resetConfig();
    try {
      const res = await call('/v1/me', {
        headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' },
      });
      expect(lineFor(res.headers.get('x-request-id'))!.ip).toBe('203.0.113.9');
    } finally {
      delete process.env.TRUST_PROXY;
      resetConfig();
    }
  });

  it('cuts a very long path', async () => {
    const res = await call(`/v1/${'a'.repeat(500)}`);
    expect(res.status).toBe(404);
    const line = lineFor(res.headers.get('x-request-id'))!;
    expect((line.path as string).length).toBe(201);
    expect(line.path as string).toMatch(/…$/);
  });
});

describe('the request id', () => {
  it("keeps a caller's id only when it is short and plain", () => {
    expect(requestIdFor('trace-123_ABC')).toBe('trace-123_ABC');
    expect(requestIdFor('a'.repeat(64))).toBe('a'.repeat(64));
    for (const bad of ['a'.repeat(65), 'has space', '"quoted"', 'x=1;y', '<script>', '', undefined])
      expect(requestIdFor(bad)).toMatch(/^req_[0-9a-z]{26}$/);
  });

  it("answers with the caller's safe id and logs it", async () => {
    const res = await call('/v1/me', { headers: { 'x-request-id': 'web-7f3a9c' } });
    expect(res.headers.get('x-request-id')).toBe('web-7f3a9c');
    expect(lineFor('web-7f3a9c')).toMatchObject({ status: 401 });
  });

  it('replaces an unsafe one, and the unsafe text is never logged', async () => {
    const res = await call('/v1/me', { headers: { 'x-request-id': 'evil"} injected' } });
    const id = res.headers.get('x-request-id')!;
    expect(id).toMatch(/^req_/);
    expect(lineFor(id)).toBeDefined();
    expect(text()).not.toContain('injected');
  });

  it('is on answers a route builds itself: /mcp, /git, files', async () => {
    const u = await createUser();
    const token = randomBytes(24).toString('hex');
    await db()
      .insert(sandboxTokens)
      .values({ userId: u.id, mcpTokenHash: sha256Hex(token) });
    const mcp = await testApp().request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(mcp.status).toBe(200);
    const mcpId = mcp.headers.get('x-request-id');
    expect(mcpId).toMatch(/^req_/);
    // The container token's user is named; the token itself is not.
    expect(lineFor(mcpId)).toMatchObject({ route: '/mcp', status: 200, userId: u.id });

    const git = await testApp().request('/git/octo/repo/info/refs?service=git-upload-pack');
    expect(git.status).toBe(401);
    expect(lineFor(git.headers.get('x-request-id'))).toMatchObject({
      route: '/git/:owner/:repo/info/refs',
      status: 401,
    });

    const file = await call('/mcp/files/att_x?exp=1&sig=planted-file-signature');
    expect(file.status).toBe(403);
    expect(lineFor(file.headers.get('x-request-id'))).toMatchObject({ route: '/mcp/files/:id' });

    expect(text()).not.toContain(token);
    expect(text()).not.toContain('planted-file-signature');
  });
});

describe('levels', () => {
  let app: ReturnType<typeof createApp>;
  beforeAll(() => {
    // A fresh app with one route that breaks the way a bug would.
    app = createApp();
    app.get('/test/boom', () => {
      throw new Error('kaboom');
    });
  });

  it('a 5xx is an error line, and every line of that request carries its id', async () => {
    const res = await app.request('/test/boom');
    expect(res.status).toBe(500);
    const id = res.headers.get('x-request-id')!;
    // The Error shape, with the id to quote when reporting it.
    expect(await res.json()).toEqual({
      error: { code: 'internal', message: 'Internal error', details: { requestId: id } },
    });
    expect(lineFor(id)).toMatchObject({ level: 50, status: 500, route: '/test/boom' });
    const unhandled = lines().find((l) => l.msg === 'unhandled error')!;
    expect(unhandled).toMatchObject({ level: 50, requestId: id, err: 'kaboom' });
  });

  it('a 4xx is a warning; 2xx is info', async () => {
    const bad = await call('/v1/me');
    expect(lineFor(bad.headers.get('x-request-id'))).toMatchObject({ level: 40, status: 401 });
    const notFound = await call('/nope');
    expect(lineFor(notFound.headers.get('x-request-id'))).toMatchObject({
      level: 40,
      status: 404,
      route: null, // no route answered
      path: '/nope',
    });
  });

  it('the health check is only at debug', async () => {
    const res = await call('/healthz');
    expect(res.status).toBe(200);
    expect(lineFor(res.headers.get('x-request-id'))).toMatchObject({ level: 20 });
  });

  it('lines outside a request carry no request id', () => {
    buildLogger(
      new Writable({
        write(chunk, _enc, cb) {
          raw.push(String(chunk));
          cb();
        },
      }),
      'trace',
    ).info({ x: 1 }, 'outside');
    expect(lines().find((l) => l.msg === 'outside')).not.toHaveProperty('requestId');
  });
});

describe('never a secret', () => {
  const SECRETS = {
    session: 'eyJhbGciOiJSUzI1NiJ9.planted-session-token.sig',
    cookie: 'planted-cookie-value-123',
    queryToken: 'planted-query-token-456',
    code: 'planted-one-time-code-789',
    password: 'planted-body-password',
    apiKey: 'sk-planted-body-api-key',
  };

  afterAll(() => setLogger(undefined));

  it('no header, cookie, query value or body reaches the log', async () => {
    const u = await createUser();
    await call(
      `/v1/stream?token=${SECRETS.queryToken}&code=${SECRETS.code}`, // SSE signs in by query
      { headers: { cookie: `__session=${SECRETS.cookie}` } },
    );
    await call(`/v1/byok/openai?apiKey=${SECRETS.apiKey}`, {
      method: 'PUT',
      token: SECRETS.session,
      body: { apiKey: SECRETS.apiKey, password: SECRETS.password },
    });
    await call('/v1/me', {
      token: u.token,
      headers: { cookie: `__session=${SECRETS.cookie}; other=${SECRETS.cookie}` },
    });
    await call(`/oauth/callback?code=${SECRETS.code}&state=st_x`);
    expect(requestLines().length).toBeGreaterThanOrEqual(4);
    const logged = text();
    for (const secret of [...Object.values(SECRETS), u.token]) expect(logged).not.toContain(secret);
    expect(logged).not.toMatch(/authorization|cookie|bearer/i);
  });

  it('webhooks: signatures still verify (the body is not consumed), none is logged', async () => {
    const signed = signClerk({ type: 'session.created', data: { id: 'sess_planted' } });
    const clerk = await call('/webhooks/clerk', {
      method: 'POST',
      body: signed.body,
      headers: signed.headers,
    });
    expect(clerk.status).toBe(200);
    expect(lineFor(clerk.headers.get('x-request-id'))).toMatchObject({
      route: '/webhooks/clerk',
      status: 200,
    });

    const telegram = await call('/webhooks/telegram', {
      method: 'POST',
      body: { update_id: 424242, planted: SECRETS.password },
      headers: { 'x-telegram-bot-api-secret-token': 'tg-secret' },
    });
    expect(telegram.status).toBe(200);
    const forged = await call('/webhooks/telegram', {
      method: 'POST',
      body: { update_id: 424243 },
      headers: { 'x-telegram-bot-api-secret-token': 'planted-wrong-secret' },
    });
    expect(forged.status).toBe(401);
    expect(lineFor(forged.headers.get('x-request-id'))).toMatchObject({ level: 40 });

    const logged = text();
    expect(logged).not.toContain(signed.headers['svix-signature']);
    expect(logged).not.toContain('sess_planted');
    expect(logged).not.toContain('tg-secret');
    expect(logged).not.toContain('planted-wrong-secret');
    expect(logged).not.toContain(SECRETS.password);
  });
});
