// Git gateway (HLD section 5.1): real git for the user's GitHub without a GitHub token in the
// container. The api forwards the three git smart-HTTP requests to github.com with the token of
// the user's active Composio GitHub connection. The token is never logged or stored.
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { activeConnections } from './apps.ts';
import { composio } from './composio.ts';
import { isFastForward, packCommits, PackError } from './git-pack.ts';
import { gitCreatedBranches } from './tables.ts';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

export interface GitRepo {
  owner: string;
  repo: string;
}

export interface PushCommand {
  oldId: string;
  newId: string;
  ref: string;
}

/** An error the git client should see: plain text, shown as `remote: <message>`. */
export class GitGatewayError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const GITHUB_URL = 'https://github.com';
const GITHUB_API_URL = 'https://api.github.com';
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const TOKEN_TTL_MS = 60_000;
const DEFAULT_BRANCH_TTL_MS = 5 * 60_000;
const UPSTREAM_TIMEOUT_MS = 15 * 60_000;
/** The command list of a push is tiny; anything bigger before the first flush is not a push. */
const MAX_COMMAND_BYTES = 1024 * 1024;
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'expires', 'pragma'];
const REQUEST_HEADERS = [
  'content-type',
  'accept',
  'content-encoding',
  'git-protocol',
  'user-agent',
];

/** The pack of a push to an existing branch is read whole to check it; a bigger one is asked about. */
const MAX_CHECKED_PACK_BYTES = 64 * 1024 * 1024;
const ZERO_ID = /^0+$/;

/** One branch a push updates that already exists, as the approver is asked about it. */
export interface PushUpdateCheck {
  owner: string;
  repo: string;
  branch: string;
  /** Not a fast-forward, or it could not be told. */
  force: boolean;
  /** The agent made this branch through the gateway. */
  createdByAgent: boolean;
}

export type PushApproval =
  { ok: true; release: () => Promise<void> } | { ok: false; message: string };

/**
 * Decides on the branches a push updates that already exist (wiring.ts: the orchestrator's
 * approvals). Until it is set, every such push is refused.
 */
let approvePushes: (
  userId: string,
  updates: PushUpdateCheck[],
) => Promise<PushApproval> = async () => ({
  ok: false,
  message:
    "A push to a branch that already exists needs your user's OK, and it can't be asked now.",
});

export function setPushApprover(fn: typeof approvePushes): void {
  approvePushes = fn;
}

let upstream: typeof fetch = (input, init) => fetch(input, init);
const tokens = new Map<string, { token: string; expires: number }>();
const defaultBranches = new Map<string, { branch: string; expires: number }>();

/** Tests: a fake github.com (also clears the caches). */
export function setGitUpstream(fake: typeof fetch | undefined): void {
  upstream = fake ?? ((input, init) => fetch(input, init));
  tokens.clear();
  defaultBranches.clear();
}

export function parseGitService(value: string | undefined): GitService | null {
  return value === 'git-upload-pack' || value === 'git-receive-pack' ? value : null;
}

export function parseRepo(owner: string, repo: string): GitRepo {
  const name = repo.endsWith('.git') ? repo.slice(0, -4) : repo;
  const ok = (v: string) => NAME.test(v) && v !== '.' && v !== '..';
  if (!ok(owner) || !ok(name)) throw new GitGatewayError(400, 'Not a GitHub repository path');
  return { owner, repo: name };
}

/** The user's GitHub OAuth token, from their active Composio connection (cached for a minute). */
export async function githubTokenFor(userId: string): Promise<string> {
  const hit = tokens.get(userId);
  if (hit && hit.expires > Date.now()) return hit.token;
  const github = (await activeConnections(userId)).find((c) => c.app === 'github');
  if (!github) {
    throw new GitGatewayError(
      403,
      'GitHub is not connected. Ask the user to connect GitHub first.',
    );
  }
  const token = await composio().accessToken(github.composioAccountId);
  if (!token) {
    throw new GitGatewayError(
      403,
      "The GitHub connection can't be used for git (its token is not available). " +
        'Use the GitHub app actions instead.',
    );
  }
  tokens.set(userId, { token, expires: Date.now() + TOKEN_TTL_MS });
  return token;
}

function basicAuth(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
}

async function defaultBranch(repo: GitRepo, token: string): Promise<string> {
  const key = `${repo.owner}/${repo.repo}`.toLowerCase();
  const hit = defaultBranches.get(key);
  if (hit && hit.expires > Date.now()) return hit.branch;
  const res = await upstream(`${GITHUB_API_URL}/repos/${repo.owner}/${repo.repo}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'personal-agent-git-gateway',
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = res.ok ? ((await res.json()) as { default_branch?: unknown }) : null;
  if (typeof body?.default_branch !== 'string' || !body.default_branch) {
    // Fail closed: without the default branch the push rules can't be checked.
    throw new GitGatewayError(403, `Could not check the default branch of ${key}; push refused.`);
  }
  defaultBranches.set(key, {
    branch: body.default_branch,
    expires: Date.now() + DEFAULT_BRANCH_TTL_MS,
  });
  return body.default_branch;
}

export interface PullRequestInfo {
  /** The pull request's current head commit. */
  headSha: string;
  open: boolean;
}

/**
 * A pull request as GitHub has it now, asked with the user's GitHub connection (pull-request
 * review, HLD 0.8). Null when GitHub has no such pull request for this account. Throws when
 * GitHub can't be asked (not connected, token not available, GitHub down).
 */
export async function getPullRequest(
  userId: string,
  repo: GitRepo,
  number: number,
): Promise<PullRequestInfo | null> {
  const token = await githubTokenFor(userId);
  const res = await upstream(`${GITHUB_API_URL}/repos/${repo.owner}/${repo.repo}/pulls/${number}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'personal-agent-git-gateway',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new GitGatewayError(502, `GitHub answered ${res.status} for the pull request.`);
  }
  const body = (await res.json()) as { state?: unknown; head?: { sha?: unknown } };
  const sha = body.head?.sha;
  if (typeof sha !== 'string' || !/^[0-9a-f]{40,64}$/.test(sha))
    throw new GitGatewayError(502, 'GitHub did not say which commit the pull request is at.');
  return { headSha: sha, open: body.state === 'open' };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/**
 * Reads the command list at the start of a git-receive-pack request (pkt-lines up to the first
 * flush) and returns it with a stream that replays the whole body for forwarding.
 */
export async function readPushCommands(body: ReadableStream<Uint8Array> | null): Promise<{
  commands: PushCommand[];
  replay: ReadableStream<Uint8Array>;
  /** Where the bytes after the command list start, in the replayed body. */
  bodyStart: number;
}> {
  if (!body) throw new GitGatewayError(400, 'Empty push request');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const commands: PushCommand[] = [];
  let buf: Uint8Array = new Uint8Array(0);
  let at = 0;
  let flushed = false;

  while (!flushed) {
    // Parse every complete pkt-line in the buffer.
    for (;;) {
      if (buf.length - at < 4) break;
      const len = Number.parseInt(decoder.decode(buf.subarray(at, at + 4)), 16);
      if (Number.isNaN(len) || (len > 0 && len < 4))
        throw new GitGatewayError(400, 'Bad push request');
      if (len === 0) {
        flushed = true;
        break;
      }
      if (buf.length - at < len) break;
      const line = decoder
        .decode(buf.subarray(at + 4, at + len))
        .split('\0')[0]!
        .replace(/\n$/, '');
      at += len;
      if (line.startsWith('shallow ')) continue;
      const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (\S+)$/.exec(line);
      // Anything else (e.g. a signed push certificate) can't be checked, so it is refused.
      if (!m) throw new GitGatewayError(400, 'This kind of push is not supported');
      commands.push({ oldId: m[1]!, newId: m[2]!, ref: m[3]! });
    }
    if (flushed) break;
    if (buf.length > MAX_COMMAND_BYTES) throw new GitGatewayError(400, 'Bad push request');
    const { done, value } = await reader.read();
    if (done) throw new GitGatewayError(400, 'Bad push request');
    chunks.push(value);
    buf = concat(chunks);
  }

  const head = concat(chunks);
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length) controller.enqueue(head);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { commands, replay, bodyStart: at + 4 };
}

/** Push rules: branches only, never the default branch, no deletes (HLD section 5.1). */
export function checkPush(commands: PushCommand[], defaultBranchName: string): void {
  for (const c of commands) {
    if (!c.ref.startsWith('refs/heads/')) {
      throw new GitGatewayError(403, `Only branches can be pushed (not ${c.ref}).`);
    }
    if (/^0+$/.test(c.newId)) {
      throw new GitGatewayError(403, `Deleting ${c.ref} is not allowed.`);
    }
    if (c.ref === `refs/heads/${defaultBranchName}`) {
      throw new GitGatewayError(
        403,
        `Pushing to the default branch (${defaultBranchName}) is not allowed. ` +
          'Push a new branch and open a pull request.',
      );
    }
  }
}

/** The pack in what follows a push's command list: push options (pkt-lines and a flush) may come first. */
export function packOf(rest: Buffer): Buffer {
  if (rest.length === 0 || rest.subarray(0, 4).toString('latin1') === 'PACK') return rest;
  let at = 0;
  for (;;) {
    if (rest.length - at < 4) throw new PackError('no pack');
    const len = Number.parseInt(rest.subarray(at, at + 4).toString('latin1'), 16);
    if (Number.isNaN(len) || (len > 0 && len < 4)) throw new PackError('no pack');
    if (len === 0) return rest.subarray(at + 4);
    at += len;
  }
}

async function readAll(stream: ReadableStream<Uint8Array>, max: number): Promise<Buffer | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** GitHub's compare API: is `ancestor` an ancestor of (or the same as) `commit`? */
async function isAncestorOnGitHub(
  repo: GitRepo,
  token: string,
  ancestor: string,
  commit: string,
): Promise<boolean> {
  const res = await upstream(
    `${GITHUB_API_URL}/repos/${repo.owner}/${repo.repo}/compare/${ancestor}...${commit}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'personal-agent-git-gateway',
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (res.status === 404) {
    await res.body?.cancel();
    return false;
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new PackError(`GitHub answered ${res.status} to the compare`);
  }
  const body = (await res.json()) as { status?: unknown };
  return body.status === 'ahead' || body.status === 'identical';
}

const repoKey = (repo: GitRepo) => ({
  owner: repo.owner.toLowerCase(),
  repo: repo.repo.toLowerCase(),
});

/** The branches of this repository the agent made through the gateway, of those named. */
async function createdByAgent(userId: string, repo: GitRepo): Promise<Set<string>> {
  const key = repoKey(repo);
  const rows = await db()
    .select({ branch: gitCreatedBranches.branch })
    .from(gitCreatedBranches)
    .where(
      and(
        eq(gitCreatedBranches.userId, userId),
        eq(gitCreatedBranches.owner, key.owner),
        eq(gitCreatedBranches.repo, key.repo),
      ),
    );
  return new Set(rows.map((r) => r.branch));
}

async function rememberCreated(userId: string, repo: GitRepo, branches: string[]): Promise<void> {
  if (!branches.length) return;
  const key = repoKey(repo);
  await db()
    .insert(gitCreatedBranches)
    .values(branches.map((branch) => ({ userId, ...key, branch })))
    .onConflictDoNothing();
}

/** Account deletion: the branches the user's agent made. */
export async function deleteUserGitBranches(userId: string): Promise<void> {
  await db().delete(gitCreatedBranches).where(eq(gitCreatedBranches.userId, userId));
}

const branchOf = (ref: string) => ref.slice('refs/heads/'.length);

function forwardHeaders(from: Headers, token: string): Headers {
  const out = new Headers({ authorization: basicAuth(token) });
  for (const name of REQUEST_HEADERS) {
    const v = from.get(name);
    if (v) out.set(name, v);
  }
  return out;
}

async function relay(userId: string, repo: GitRepo, res: Response): Promise<Response> {
  const name = `${repo.owner}/${repo.repo}`;
  if (res.status === 401 || res.status === 403) {
    tokens.delete(userId);
    await res.body?.cancel();
    throw new GitGatewayError(403, `GitHub refused access to ${name} for the connected account.`);
  }
  if (res.status === 404 || (res.status >= 300 && res.status < 400)) {
    await res.body?.cancel();
    throw new GitGatewayError(
      404,
      `Repository ${name} was not found (or the connected GitHub account can't see it).`,
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new GitGatewayError(502, `GitHub answered ${res.status} for ${name}.`);
  }
  const headers = new Headers();
  for (const h of RESPONSE_HEADERS) {
    const v = res.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

/** `GET info/refs?service=…`: the ref advertisement that starts every clone, fetch and push. */
export async function gitInfoRefs(input: {
  userId: string;
  repo: GitRepo;
  service: GitService;
  headers: Headers;
}): Promise<Response> {
  const token = await githubTokenFor(input.userId);
  const { owner, repo } = input.repo;
  const res = await upstream(
    `${GITHUB_URL}/${owner}/${repo}.git/info/refs?service=${input.service}`,
    {
      headers: forwardHeaders(input.headers, token),
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
  );
  return relay(input.userId, input.repo, res);
}

/**
 * `POST git-upload-pack` (clone/fetch) or `POST git-receive-pack` (push), streamed both ways.
 * A push is checked against the push rules first; `pushed` lists what it updates.
 */
export async function gitRpc(input: {
  userId: string;
  repo: GitRepo;
  service: GitService;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}): Promise<{ response: Response; pushed: PushCommand[] }> {
  const token = await githubTokenFor(input.userId);
  let body: ReadableStream<Uint8Array> | Buffer | null = input.body;
  let pushed: PushCommand[] = [];
  let release: () => Promise<void> = async () => {};
  if (input.service === 'git-receive-pack') {
    if (input.headers.get('content-encoding')) {
      throw new GitGatewayError(400, 'This kind of push is not supported');
    }
    const { commands, replay, bodyStart } = await readPushCommands(body);
    if (commands.length) checkPush(commands, await defaultBranch(input.repo, token));
    pushed = commands;
    body = replay;
    const updates = commands.filter((c) => !ZERO_ID.test(c.oldId));
    if (updates.length) {
      // A branch that already exists: is this a fast-forward, and may it go through?
      const whole = await readAll(replay, MAX_CHECKED_PACK_BYTES);
      let commits: Map<string, string[]> | null = null;
      try {
        commits = whole ? packCommits(packOf(whole.subarray(bodyStart))) : null;
      } catch (err) {
        if (!(err instanceof PackError)) throw err;
      }
      const made = await createdByAgent(input.userId, input.repo);
      const checks: PushUpdateCheck[] = [];
      for (const c of updates) {
        let ff = false;
        if (commits) {
          try {
            ff = await isFastForward(c.oldId, c.newId, commits, (a, b) =>
              isAncestorOnGitHub(input.repo, token, a, b),
            );
          } catch (err) {
            if (!(err instanceof PackError)) throw err;
          }
        }
        const branch = branchOf(c.ref);
        checks.push({
          owner: input.repo.owner,
          repo: input.repo.repo,
          branch,
          force: !ff,
          createdByAgent: made.has(branch),
        });
      }
      const decision = await approvePushes(input.userId, checks);
      if (!decision.ok) throw new GitGatewayError(403, decision.message);
      release = decision.release;
      if (!whole) {
        // Too big to check, but approved as a force push: it goes through as it is.
        await release();
        throw new GitGatewayError(
          413,
          'This push is too big for the gateway to check. Push fewer or smaller commits at a time.',
        );
      }
      body = whole;
    }
  }
  const { owner, repo } = input.repo;
  let response: Response;
  try {
    const res = await upstream(`${GITHUB_URL}/${owner}/${repo}.git/${input.service}`, {
      method: 'POST',
      headers: forwardHeaders(input.headers, token),
      body,
      ...(body instanceof Buffer ? {} : { duplex: 'half' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    } as RequestInit);
    response = await relay(input.userId, input.repo, res);
  } catch (err) {
    // GitHub did not take the push: an approval it used can be used again.
    await release();
    throw err;
  }
  const created = pushed.filter((c) => ZERO_ID.test(c.oldId)).map((c) => branchOf(c.ref));
  await rememberCreated(input.userId, input.repo, created);
  return { response, pushed };
}
