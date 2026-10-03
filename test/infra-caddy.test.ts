// /mcp and /git are closed to the internet at Caddy (HLD section 4). Docker and Caddy aren't
// available in the test run, so this checks the Caddyfile's rule against the routes the api
// really mounts, and that nothing public is built on those two paths.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signedFileUrl } from '../src/modules/channels/files.ts';
import { config } from '../src/shared/config.ts';
import { testApp } from './helpers.ts';

const caddyfile = readFileSync(new URL('../infra/caddy/Caddyfile', import.meta.url), 'utf8');
const code = caddyfile
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

/** Caddy's `path` matcher: case-insensitive, exact unless the pattern ends with `*` (a prefix). */
function blocked(path: string): boolean {
  const line = code.find((l) => l.startsWith('@containers_only path '));
  const patterns = line!.split(/\s+/).slice(2);
  const p = path.toLowerCase();
  return patterns.some((pat) => (pat.endsWith('*') ? p.startsWith(pat.slice(0, -1)) : p === pat));
}

describe('Caddy: /mcp and /git are closed to the internet', () => {
  it('answers 404 for the container-only paths before anything is proxied', () => {
    const matcher = code.indexOf('@containers_only path /mcp* /git /git/*');
    const handle = code.indexOf('handle @containers_only {');
    const respond = code.indexOf('respond "Not found" 404');
    const proxy = code.findIndex((l) => l.startsWith('reverse_proxy '));
    expect(matcher).toBeGreaterThan(-1);
    expect(handle).toBeGreaterThan(matcher);
    expect(respond).toBe(handle + 1);
    // The proxy sits in the catch-all `handle`, which only runs when the first one didn't match.
    expect(code[proxy - 1]).toBe('handle {');
    expect(proxy).toBeGreaterThan(respond);
    expect(code.filter((l) => l.startsWith('reverse_proxy '))).toHaveLength(1);
  });

  it('covers every /mcp and /git route the api mounts, and no other route', () => {
    const paths = [...new Set(testApp().routes.map((r) => r.path))].filter((p) => p !== '/*');
    const internal = paths.filter((p) => p.startsWith('/mcp') || p.startsWith('/git'));
    expect(internal.sort()).toEqual([
      '/git/:owner/:repo/git-receive-pack',
      '/git/:owner/:repo/git-upload-pack',
      '/git/:owner/:repo/info/refs',
      '/mcp',
      '/mcp/files/:id',
    ]);
    for (const p of internal) expect(blocked(p), p).toBe(true);
    const open = paths.filter((p) => !internal.includes(p));
    expect(open.length).toBeGreaterThan(50);
    for (const p of open) expect(blocked(p), p).toBe(false);
    // Spot checks, including look-alikes of the user's own MCP servers API.
    for (const p of [
      '/mcp',
      '/MCP',
      '/mcp/',
      '/mcp/files/att_1',
      '/git',
      '/git/acme/repo/info/refs',
    ])
      expect(blocked(p), p).toBe(true);
    for (const p of ['/healthz', '/v1/mcp-servers', '/v1/me', '/webhooks/telegram', '/metrics'])
      expect(blocked(p), p).toBe(false);
  });

  it('nothing public is built on them: attachment URLs use the internal api address', () => {
    const url = signedFileUrl('att_123');
    expect(url.startsWith(`${config().INTERNAL_API_URL}/mcp/files/att_123?`)).toBe(true);
    expect(url.startsWith(config().PUBLIC_API_URL)).toBe(false);
  });
});
