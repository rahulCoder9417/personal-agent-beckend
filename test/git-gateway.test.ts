// Git gateway (/git/<owner>/<repo>): container token → user → the user's GitHub token from
// Composio → github.com. The token never reaches the caller; pushes to the default branch,
// deletes and tags are refused before anything is sent to GitHub.
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import {
  checkPush,
  GitGatewayError,
  readPushCommands,
  setGitUpstream,
} from '../src/modules/integrations/git-gateway.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { sandboxTokens } from '../src/modules/orchestrator/schema.ts';
import { sha256Hex } from '../src/shared/crypto.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio } from './fakes.ts';
import { chatUser, testApp } from './helpers.ts';

interface Seen {
  url: string;
  method: string;
  authorization: string | null;
  body: string;
}

const ZERO = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const pkt = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line;
/** A git-receive-pack request body: the command list, a flush, then the pack. */
const pushBody = (commands: Array<[string, string, string]>, pack = 'PACK-bytes') =>
  commands
    .map(([o, n, ref], i) => pkt(`${o} ${n} ${ref}${i === 0 ? '\0report-status' : ''}\n`))
    .join('') +
  '0000' +
  pack;

let seen: Seen[];

function fakeGithub(opts: { status?: number; defaultBranch?: string | null } = {}) {
  seen = [];
  setGitUpstream(async (input, init) => {
    const url = String(input);
    const body = init?.body ? await new Response(init.body as ReadableStream | string).text() : '';
    seen.push({
      url,
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
      body,
    });
    if (url.startsWith('https://api.github.com/')) {
      return opts.defaultBranch === null
        ? new Response('{}', { status: 404 })
        : Response.json({ default_branch: opts.defaultBranch ?? 'main' });
    }
    return new Response('git-data', {
      status: opts.status ?? 200,
      headers: {
        'content-type': 'application/x-git-upload-pack-result',
        'www-authenticate': 'Basic realm="GitHub"',
        'set-cookie': 'secret=1',
      },
    });
  });
}

async function containerUser(opts: { github?: boolean } = {}) {
  const user = await chatUser();
  const token = randomBytes(24).toString('hex');
  await db()
    .insert(sandboxTokens)
    .values({ userId: user.id, mcpTokenHash: sha256Hex(token) });
  const accountId = `ca_${randomUUID()}`;
  if (opts.github !== false) {
    await db()
      .insert(connections)
      .values({
        id: newId('con'),
        userId: user.id,
        app: 'github',
        composioAccountId: accountId,
        status: 'active',
      });
  }
  return { user, token, accountId };
}

const git = (path: string, token: string | null, init: RequestInit = {}) =>
  testApp().request(`/git/${path}`, {
    ...init,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });

const auditFor = (userId: string) =>
  db().select().from(auditLog).where(eq(auditLog.userId, userId));

beforeAll(() => wireModules());
beforeEach(async () => {
  await installFakeComposio();
  fakeGithub();
});
afterEach(() => setGitUpstream(undefined));

describe('git gateway', () => {
  it('needs a valid container token', async () => {
    for (const token of [null, 'not-a-token']) {
      const res = await git('acme/app/info/refs?service=git-upload-pack', token);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBeNull();
    }
    expect(seen).toHaveLength(0);
  });

  it('forwards a clone to github.com with the user’s GitHub token, which the caller never sees', async () => {
    const { user, token, accountId } = await containerUser();
    const expected = `Basic ${Buffer.from(`x-access-token:gho_fake_token_for_${accountId}`).toString('base64')}`;

    const refs = await git('acme/app.git/info/refs?service=git-upload-pack', token);
    expect(refs.status).toBe(200);
    expect(await refs.text()).toBe('git-data');
    expect(refs.headers.get('content-type')).toBe('application/x-git-upload-pack-result');
    // Only safe response headers are passed back.
    expect(refs.headers.get('set-cookie')).toBeNull();
    expect(refs.headers.get('www-authenticate')).toBeNull();

    const pack = await git('acme/app/git-upload-pack', token, {
      method: 'POST',
      body: '0032want something',
      headers: { 'content-type': 'application/x-git-upload-pack-request' },
    });
    expect(pack.status).toBe(200);

    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ['GET', 'https://github.com/acme/app.git/info/refs?service=git-upload-pack'],
      ['POST', 'https://github.com/acme/app.git/git-upload-pack'],
    ]);
    expect(seen.every((s) => s.authorization === expected)).toBe(true);
    expect(seen[1]!.body).toBe('0032want something');

    const log = await auditFor(user.id);
    expect(log.map((l) => l.action)).toEqual(['git_fetch']);
    expect(JSON.stringify(log)).not.toContain('gho_fake_token');
  });

  it('accepts the container token as a Basic auth password too', async () => {
    const { token } = await containerUser();
    const res = await testApp().request('/git/acme/app/info/refs?service=git-upload-pack', {
      headers: { authorization: `Basic ${Buffer.from(`git:${token}`).toString('base64')}` },
    });
    expect(res.status).toBe(200);
  });

  it('refuses when GitHub is not connected', async () => {
    const { token } = await containerUser({ github: false });
    const res = await git('acme/app/info/refs?service=git-upload-pack', token);
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('GitHub is not connected');
    expect(seen).toHaveLength(0);
  });

  it('only speaks git smart HTTP for a real owner/repo path', async () => {
    const { token } = await containerUser();
    expect((await git('acme/app/info/refs', token)).status).toBe(400);
    expect((await git('acme/app/info/refs?service=git-upload-archive', token)).status).toBe(400);
    expect((await git('acme/../info/refs?service=git-upload-pack', token)).status).not.toBe(200);
    expect((await git('acme/a%20b/info/refs?service=git-upload-pack', token)).status).toBe(400);
    expect((await git('acme/app/HEAD', token)).status).toBe(404);
    expect((await git('acme/app/git-upload-pack', token)).status).toBe(404); // GET
    expect(seen).toHaveLength(0);
  });

  it('pushes a branch and audit-logs it', async () => {
    const { user, token } = await containerUser();
    const body = pushBody([[ZERO, A, 'refs/heads/agent-test-1']]);
    const res = await git('acme/app/git-receive-pack', token, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-git-receive-pack-request' },
    });
    expect(res.status).toBe(200);
    const push = seen.find((s) => s.url.endsWith('/git-receive-pack'))!;
    // The whole request (commands + pack) reaches GitHub unchanged.
    expect(push.body).toBe(body);
    const log = await auditFor(user.id);
    expect(log.map((l) => l.action)).toEqual(['git_push']);
    expect(log[0]!.summary).toBe('Pushed agent-test-1 to acme/app');
  });

  it('lets git’s empty probe request through without a default-branch lookup', async () => {
    const { token } = await containerUser();
    const res = await git('acme/app/git-receive-pack', token, { method: 'POST', body: '0000' });
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(['https://github.com/acme/app.git/git-receive-pack']);
  });

  it('refuses pushes to the default branch, deletes and tags before anything reaches GitHub', async () => {
    fakeGithub({ defaultBranch: 'trunk' });
    const { user, token } = await containerUser();
    const refused: Array<[Array<[string, string, string]>, string]> = [
      [[[A, B, 'refs/heads/trunk']], 'default branch (trunk)'],
      [[[A, ZERO, 'refs/heads/feature']], 'Deleting refs/heads/feature'],
      [[[ZERO, A, 'refs/tags/v1']], 'Only branches can be pushed'],
      [
        [
          [ZERO, A, 'refs/heads/ok'],
          [A, B, 'refs/heads/trunk'],
        ],
        'default branch (trunk)',
      ],
    ];
    for (const [commands, message] of refused) {
      const res = await git('acme/app/git-receive-pack', token, {
        method: 'POST',
        body: pushBody(commands),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain(message);
    }
    expect(seen.some((s) => s.url.endsWith('/git-receive-pack'))).toBe(false);
    expect(await auditFor(user.id)).toHaveLength(0);

    // `main` is an ordinary branch in this repo: a new one goes through. (A push to a branch
    // that already exists needs the user's OK: test/agent-approvals.test.ts.)
    const ok = await git('acme/app/git-receive-pack', token, {
      method: 'POST',
      body: pushBody([[ZERO, B, 'refs/heads/main']]),
    });
    expect(ok.status).toBe(200);
    const existing = await git('acme/app/git-receive-pack', token, {
      method: 'POST',
      body: pushBody([[A, B, 'refs/heads/feature']]),
    });
    expect(existing.status).toBe(403);
    expect(await existing.text()).toContain("needs your user's OK");
  });

  it('refuses a push when the default branch can’t be checked', async () => {
    fakeGithub({ defaultBranch: null });
    const { token } = await containerUser();
    const res = await git('acme/app/git-receive-pack', token, {
      method: 'POST',
      body: pushBody([[ZERO, A, 'refs/heads/feature']]),
    });
    expect(res.status).toBe(403);
    expect(seen.some((s) => s.url.endsWith('/git-receive-pack'))).toBe(false);
  });

  it('turns GitHub’s auth and not-found answers into messages, never a login prompt', async () => {
    const { token } = await containerUser();
    for (const [status, expected] of [
      [401, 403],
      [404, 404],
      [301, 404],
      [500, 502],
    ] as const) {
      fakeGithub({ status });
      const res = await git('acme/app/info/refs?service=git-upload-pack', token);
      expect(res.status).toBe(expected);
      expect(res.headers.get('www-authenticate')).toBeNull();
      expect(await res.text()).toContain('acme/app');
    }
  });
});

describe('push command parsing', () => {
  const stream = (parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(new TextEncoder().encode(p));
        c.close();
      },
    });

  it('reads commands split across chunks and replays the full body', async () => {
    const body = pushBody([
      [ZERO, A, 'refs/heads/one'],
      [A, B, 'refs/heads/two'],
    ]);
    const { commands, replay } = await readPushCommands(
      stream([body.slice(0, 7), body.slice(7, 90), body.slice(90)]),
    );
    expect(commands).toEqual([
      { oldId: ZERO, newId: A, ref: 'refs/heads/one' },
      { oldId: A, newId: B, ref: 'refs/heads/two' },
    ]);
    expect(await new Response(replay).text()).toBe(body);
  });

  it('skips shallow lines and refuses what it can’t check', async () => {
    const shallow = pkt(`shallow ${A}\n`) + pushBody([[ZERO, B, 'refs/heads/x']]);
    expect((await readPushCommands(stream([shallow]))).commands).toHaveLength(1);
    await expect(readPushCommands(stream([pkt('push-cert\0caps\n') + '0000']))).rejects.toThrow(
      GitGatewayError,
    );
    await expect(readPushCommands(stream(['zzzz']))).rejects.toThrow(GitGatewayError);
    await expect(readPushCommands(stream([pkt(`${ZERO} ${A} refs/heads/x\n`)]))).rejects.toThrow(
      GitGatewayError,
    );
    await expect(readPushCommands(null)).rejects.toThrow(GitGatewayError);
  });

  it('checkPush allows ordinary branch updates', () => {
    expect(() =>
      checkPush(
        [
          { oldId: ZERO, newId: A, ref: 'refs/heads/feature/x' },
          { oldId: A, newId: B, ref: 'refs/heads/main-2' },
        ],
        'main',
      ),
    ).not.toThrow();
  });
});
