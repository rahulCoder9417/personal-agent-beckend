// The real LiteLLM client's model calls (own keys) against a local stand-in for LiteLLM: paths,
// master-key auth, bodies, and the answers LiteLLM 1.104.2 gives (checked against a real proxy):
// update of a missing model → 400, create of an existing one → 500, delete of a missing one → 400.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { litellm, setLiteLLMClient } from '../src/modules/billing/litellm.ts';
import { resetConfig } from '../src/shared/config.ts';

const USER_KEY = 'sk-ant-user-secret-key-9999';
let server: Server;
const seen: Array<{ path: string; auth: string; body: Record<string, unknown> }> = [];
/** Status per path for the next calls (default 200). */
let answers: Record<string, number> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      seen.push({ path, auth: req.headers.authorization ?? '', body: raw ? JSON.parse(raw) : {} });
      const status = answers[path] ?? 200;
      res.writeHead(status, { 'content-type': 'application/json' });
      // A failing LiteLLM may echo what it was sent: the client must not pass that on.
      res.end(JSON.stringify(status === 200 ? { ok: true } : { error: { echoed: raw } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  process.env.LITELLM_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.LITELLM_MASTER_KEY = 'sk-master-test';
  resetConfig();
  setLiteLLMClient(undefined); // the real HTTP client
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});
beforeEach(() => {
  seen.length = 0;
  answers = {};
});

const model = { id: 'own-abc', model: 'anthropic/claude-sonnet-5-5', apiKey: USER_KEY };
const expectedBody = {
  model_name: 'own-abc',
  litellm_params: { model: 'anthropic/claude-sonnet-5-5', api_key: USER_KEY },
  model_info: { id: 'own-abc' },
};

describe('LiteLLM model calls (own keys)', () => {
  it('a new model is created with the master key', async () => {
    await litellm().saveModel(model, { exists: false });
    expect(seen).toEqual([
      { path: '/model/new', auth: 'Bearer sk-master-test', body: expectedBody },
    ]);
  });

  it('a known model is replaced in place; if LiteLLM lost it (400), it is created', async () => {
    await litellm().saveModel(model, { exists: true });
    expect(seen.map((s) => s.path)).toEqual(['/model/update']);
    seen.length = 0;
    answers = { '/model/update': 400 };
    await litellm().saveModel(model, { exists: true });
    expect(seen.map((s) => s.path)).toEqual(['/model/update', '/model/new']);
    expect(seen[1]!.body).toEqual(expectedBody);
  });

  it('creating one LiteLLM already has (500) falls back to replacing it', async () => {
    answers = { '/model/new': 500 };
    await litellm().saveModel(model, { exists: false });
    expect(seen.map((s) => s.path)).toEqual(['/model/new', '/model/update']);
  });

  it('errors carry the status only, never the body that echoed the key', async () => {
    answers = { '/model/update': 503 };
    const err = await litellm()
      .saveModel(model, { exists: true })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('LiteLLM POST /model/update failed: 503');
    expect(JSON.stringify(err)).not.toContain(USER_KEY);
  });

  it('delete: by id; an already deleted model (400) counts as deleted; other errors throw', async () => {
    await litellm().deleteModel('own-abc');
    expect(seen).toEqual([
      { path: '/model/delete', auth: 'Bearer sk-master-test', body: { id: 'own-abc' } },
    ]);
    answers = { '/model/delete': 400 };
    await expect(litellm().deleteModel('own-abc')).resolves.toBeUndefined();
    answers = { '/model/delete': 500 };
    await expect(litellm().deleteModel('own-abc')).rejects.toThrow(/failed: 500/);
  });
});
