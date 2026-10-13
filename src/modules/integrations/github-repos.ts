// The repositories of the user's connected GitHub account, for the crew job form's repo picker
// (docs/backend-report.md, "The crew"). Asked through Composio's GitHub action with the user's own
// GitHub connection, so no GitHub token is handled here. Kept for a minute per user.
import { logger } from '../../shared/logger.ts';
import { connectionForToolkit } from './apps.ts';
import { composio } from './composio.ts';

/** Composio's GitHub action for `GET /user/repos`. */
export const LIST_REPOS_ACTION = 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER';
export const REPO_CACHE_MS = 60_000;
/** One page, the most recently pushed first: what a picker needs. A repo can always be typed. */
const PER_PAGE = 100;

export interface GithubRepo {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
}

/** GitHub is not connected (the api answers 409). */
export class GithubNotConnected extends Error {}
/** GitHub or Composio could not be asked (the api answers 503). */
export class GithubUnavailable extends Error {}

const cache = new Map<string, { repos: GithubRepo[]; expires: number }>();

/** Tests: forget what was kept. */
export function clearRepoCache(): void {
  cache.clear();
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** The list in Composio's answer, wherever it puts it (the bare list, or under one of its keys). */
function listIn(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const d = obj(data);
  for (const key of ['repositories', 'details', 'items', 'data', 'response_data']) {
    const v = d[key];
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const inner = listIn(v);
      if (inner.length) return inner;
    }
  }
  return [];
}

/** One repo as GitHub describes it. Null for anything that isn't a plain owner/name repo. */
export function readRepo(raw: unknown): GithubRepo | null {
  const r = obj(raw);
  const full = str(r.full_name) ?? str(r.fullName);
  const [fromFullOwner, fromFullName] = full?.split('/') ?? [];
  const owner = str(obj(r.owner).login) ?? fromFullOwner ?? null;
  const name = str(r.name) ?? fromFullName ?? null;
  if (!owner || !name || !NAME.test(owner) || !NAME.test(name)) return null;
  const pushed = str(r.pushed_at) ?? str(r.updated_at);
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    private: r.private === true,
    defaultBranch: str(r.default_branch),
    pushedAt: pushed && !Number.isNaN(Date.parse(pushed)) ? new Date(pushed).toISOString() : null,
  };
}

/**
 * The account's repositories, pushed to most recently first. Throws GithubNotConnected or
 * GithubUnavailable. Reading is free: nothing is charged.
 */
export async function listGithubRepos(userId: string): Promise<GithubRepo[]> {
  const hit = cache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.repos;
  const conn = await connectionForToolkit(userId, 'github');
  if (!conn) throw new GithubNotConnected('Connect GitHub first');
  let res: Awaited<ReturnType<ReturnType<typeof composio>['execute']>>;
  try {
    res = await composio().execute(LIST_REPOS_ACTION, {
      userId,
      connectedAccountId: conn.composioAccountId,
      arguments: { per_page: PER_PAGE, page: 1, sort: 'pushed', direction: 'desc' },
    });
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'github repos: composio failed');
    throw new GithubUnavailable("GitHub can't be asked right now");
  }
  if (!res.successful) {
    logger().warn({ userId, err: res.error }, 'github repos: the action failed');
    throw new GithubUnavailable("GitHub can't be asked right now");
  }
  const seen = new Set<string>();
  const repos: GithubRepo[] = [];
  for (const raw of listIn(res.data)) {
    const repo = readRepo(raw);
    if (!repo || seen.has(repo.fullName.toLowerCase())) continue;
    seen.add(repo.fullName.toLowerCase());
    repos.push(repo);
  }
  repos.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
  cache.set(userId, { repos, expires: Date.now() + REPO_CACHE_MS });
  return repos;
}
