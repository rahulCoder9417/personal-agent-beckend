import { describe, expect, it } from 'vitest';
import { allRoutes } from '../src/api/app.ts';
import { allOperations, getOperation } from '../src/api/openapi/spec.ts';
import { call, createUser, expectContract, sessionToken } from './helpers.ts';

describe('contract: system + me', () => {
  it('every mounted route is an operation in openapi.yaml', () => {
    for (const r of allRoutes) expect(() => getOperation(r.operationId)).not.toThrow();
  });

  it('every operation in openapi.yaml is implemented', () => {
    const mounted = new Set<string>(allRoutes.map((r) => r.operationId));
    expect(
      allOperations()
        .map((o) => o.operationId)
        .filter((id) => !mounted.has(id)),
    ).toEqual([]);
  });

  it('GET /healthz', async () => {
    const body = await expectContract('getHealth', await call('/healthz'), 200);
    expect(body).toEqual({ status: 'ok' });
  });

  it('unknown route → 404 Error shape', async () => {
    const res = await call('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('GET /v1/me requires a Clerk session', async () => {
    const body = await expectContract<{ error: { code: string } }>(
      'getMe',
      await call('/v1/me'),
      401,
    );
    expect(body.error.code).toBe('unauthorized');
    await expectContract('getMe', await call('/v1/me', { token: 'garbage' }), 401);
  });

  it('a valid session for an unknown Clerk user (and no Clerk API) → 401', async () => {
    await expectContract(
      'getMe',
      await call('/v1/me', { token: await sessionToken('user_missing') }),
      401,
    );
  });

  it('GET /v1/me returns the profile', async () => {
    const u = await createUser();
    const me = await expectContract<{ id: string; plan: string }>(
      'getMe',
      await call('/v1/me', { token: u.token }),
      200,
    );
    expect(me.id).toBe(u.id);
    expect(me.plan).toBe('free');
  });

  it('PATCH /v1/me updates name + timezone and validates input', async () => {
    const u = await createUser();
    const me = await expectContract<{ name: string; timezone: string }>(
      'updateMe',
      await call('/v1/me', {
        method: 'PATCH',
        token: u.token,
        body: { name: 'Priya', timezone: 'Asia/Kolkata' },
      }),
      200,
    );
    expect(me).toMatchObject({ name: 'Priya', timezone: 'Asia/Kolkata' });

    const bad = await expectContract<{ error: { code: string } }>(
      'updateMe',
      await call('/v1/me', { method: 'PATCH', token: u.token, body: { timezone: 'Mars/Base' } }),
      400,
    );
    expect(bad.error.code).toBe('invalid_request');
    await expectContract(
      'updateMe',
      await call('/v1/me', { method: 'PATCH', token: u.token, body: { name: 'x'.repeat(81) } }),
      400,
    );
    await expectContract(
      'updateMe',
      await call('/v1/me', { method: 'PATCH', token: u.token, body: '{not json' }),
      400,
    );
  });

  it('timezoneSet: false until a time zone is given, then true; a name alone or a bad zone leaves it', async () => {
    const u = await createUser();
    const me = (body?: unknown) =>
      body === undefined
        ? call('/v1/me', { token: u.token })
        : call('/v1/me', { method: 'PATCH', token: u.token, body });
    type Me = { timezone: string; timezoneSet: boolean };
    expect(await expectContract<Me>('getMe', await me(), 200)).toMatchObject({
      timezone: 'UTC',
      timezoneSet: false,
    });
    expect(await expectContract<Me>('updateMe', await me({ name: 'Asha' }), 200)).toMatchObject({
      timezoneSet: false,
    });
    await expectContract('updateMe', await me({ timezone: 'Mars/Base' }), 400);
    expect(await expectContract<Me>('getMe', await me(), 200)).toMatchObject({
      timezoneSet: false,
    });
    // The same zone as the default still counts: someone chose it.
    expect(await expectContract<Me>('updateMe', await me({ timezone: 'UTC' }), 200)).toMatchObject({
      timezone: 'UTC',
      timezoneSet: true,
    });
    expect(
      await expectContract<Me>('updateMe', await me({ timezone: 'Asia/Kolkata' }), 200),
    ).toMatchObject({ timezone: 'Asia/Kolkata', timezoneSet: true });
  });
});

describe('Bull Board', () => {
  it('is admin only', async () => {
    expect((await call('/admin/queues')).status).toBe(401);
    const user = await createUser();
    expect((await call('/admin/queues', { token: user.token })).status).toBe(403);
    const admin = await createUser({ role: 'admin' });
    expect((await call('/admin/queues', { token: admin.token })).status).toBe(200);
  });
});
