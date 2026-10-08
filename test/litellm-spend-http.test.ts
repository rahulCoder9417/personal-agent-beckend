// The real LiteLLM client's spend-log read (used to refund a failed turn) against a local stand-in
// that answers as LiteLLM 1.103.1 on the server did (checked there with the master key):
// `/spend/logs` with full timestamps → 500 "unconverted data remains"; `/spend/logs/v2` takes
// `YYYY-MM-DD HH:MM:SS`, filters `api_key` on the key's SHA-256, and pages.
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LiteLLMHttpError, litellm, setLiteLLMClient } from '../src/modules/billing/litellm.ts';
import { resetConfig } from '../src/shared/config.ts';

const USER_KEY = 'sk-user-litellm-key-1234';
const KEY_HASH = createHash('sha256').update(USER_KEY).digest('hex');
let server: Server;
const seen: Array<{ path: string; query: Record<string, string>; auth: string; url: string }> = [];
/** Rows LiteLLM holds: what /spend/logs/v2 pages through. */
let rows: Array<Record<string, unknown>> = [];
let pageSize = 1000;
let failWith: number | null = null;

const V2_DATE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
/** LiteLLM's column is UTC without a zone. */
const utc = (s: string) => Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const query = Object.fromEntries(url.searchParams);
    seen.push({ path: url.pathname, query, auth: req.headers.authorization ?? '', url: req.url! });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (failWith) return send(failWith, { error: { message: `echo ${req.url}` } });
    if (url.pathname === '/spend/logs') {
      // What the old endpoint does with anything but `YYYY-MM-DD`.
      if (!/^\d{4}-\d\d-\d\d$/.test(query.start_date ?? ''))
        return send(500, { error: { message: '/spend/logs Errorunconverted data remains' } });
      return send(200, []);
    }
    if (url.pathname !== '/spend/logs/v2') return send(404, {});
    if (!V2_DATE.test(query.start_date ?? '') || !V2_DATE.test(query.end_date ?? ''))
      return send(400, { error: { message: 'Invalid date format' } });
    const from = Date.parse(`${query.start_date!.replace(' ', 'T')}Z`);
    const to = Date.parse(`${query.end_date!.replace(' ', 'T')}Z`);
    const size = Math.min(Number(query.page_size ?? 50), pageSize);
    const page = Number(query.page ?? 1);
    const match = rows.filter((r) => {
      const at = utc(String(r.startTime));
      return r.api_key === query.api_key && at >= from && at <= to; // both ends included
    });
    send(200, {
      data: match.slice((page - 1) * size, page * size),
      total: match.length,
      page,
      page_size: size,
      total_pages: Math.ceil(match.length / size),
      total_is_capped: false,
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
  rows = [];
  pageSize = 1000;
  failWith = null;
});

// The turn that failed on the server, 8 October 2026.
const start = new Date('2026-10-08T14:52:58.386Z');
const end = new Date('2026-10-08T14:53:05.814Z');
const log = (startTime: string, spend: number, model_group = 'cheap', api_key = KEY_HASH) => ({
  request_id: `req-${Math.random()}`,
  api_key,
  spend,
  startTime,
  model: 'openrouter/meta-llama/llama-3.3-70b-instruct',
  model_group,
});

describe("LiteLLM spend log: one turn's AI cost", () => {
  it('asks /spend/logs/v2 for the key hash and the turn rounded out to whole seconds', async () => {
    expect(await litellm().getSpendBetween(USER_KEY, start, end)).toEqual({
      spend: 0,
      modelSpend: {},
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      path: '/spend/logs/v2',
      auth: 'Bearer sk-master-test',
      query: {
        api_key: KEY_HASH,
        start_date: '2026-10-08 14:52:58',
        end_date: '2026-10-08 14:53:06',
        page: '1',
        page_size: '1000',
      },
    });
    // The key itself never goes into the address.
    expect(seen[0]!.url).not.toContain(USER_KEY);
  });

  it('the request the worker used to send is the one LiteLLM answered 500', async () => {
    const old = new URLSearchParams({
      api_key: USER_KEY,
      start_date: start.toISOString(),
      end_date: end.toISOString(),
    });
    const res = await fetch(`${process.env.LITELLM_URL}/spend/logs?${old}`);
    expect(res.status).toBe(500);
  });

  it("adds up only the turn's own calls, by our model name, across pages", async () => {
    rows = [
      log('2026-10-08T14:52:58.100000Z', 0.5), // same second, before the turn
      log('2026-10-08T14:52:58.386000Z', 0.01), // the turn's first instant
      log('2026-10-08T14:53:00.000+00:00', 0.02, 'claude'),
      log('2026-10-08T14:53:03.250', 0.03), // no zone: UTC
      log('2026-10-08T14:53:05.814000Z', 0.7), // the turn's end: not in it
      log('2026-10-08T14:53:01.000000Z', 0.9, 'cheap', 'another-key-hash'),
    ];
    pageSize = 2;
    const spend = await litellm().getSpendBetween(USER_KEY, start, end);
    expect(spend.spend).toBeCloseTo(0.06, 10);
    expect(spend.modelSpend.cheap).toBeCloseTo(0.04, 10);
    expect(spend.modelSpend.claude).toBeCloseTo(0.02, 10);
    expect(seen.map((s) => s.query.page)).toEqual(['1', '2', '3']);
  });

  it('a whole-second window is not widened', async () => {
    await litellm().getSpendBetween(
      USER_KEY,
      new Date('2026-10-08T14:52:58.000Z'),
      new Date('2026-10-08T14:53:06.000Z'),
    );
    expect(seen[0]!.query).toMatchObject({
      start_date: '2026-10-08 14:52:58',
      end_date: '2026-10-08 14:53:06',
    });
  });

  it('a failure carries the status and the path only, never the query or the body', async () => {
    failWith = 500;
    const err = await litellm()
      .getSpendBetween(USER_KEY, start, end)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiteLLMHttpError);
    expect((err as Error).message).toBe('LiteLLM GET /spend/logs/v2 failed: 500');
  });
});
