// GitHub's answers, slimmed before the size cut (app-results.ts, slimGithub). On 17 October 2026 a
// list of the founder's 28 public repositories was 151,620 characters as GitHub sends it (about
// 5,400 each, mostly links to GitHub's own API); the cut to 30,000 left 5, and the day before his
// pending-PR automation checked only those 5 repositories. One pull request was 18,134 characters,
// and two of them came back as 30,000 characters of broken JSON. The objects below have GitHub's
// real keys (read from github.com's API that day), with made-up values.
import { describe, expect, it } from 'vitest';
import {
  fitResult,
  MAX_RESULT_CHARS,
  shapeResult,
  slimGithub,
} from '../src/modules/integrations/app-results.ts';

const API = 'https://api.github.com';
const WEB = 'https://github.com';

/** A GitHub account as GitHub sends it inside another item. */
function account(login: string) {
  const u = `${API}/users/${login}`;
  return {
    login,
    id: 1000,
    node_id: 'MDQ6VXNlcjE=',
    avatar_url: 'https://avatars.githubusercontent.com/u/1000?v=4',
    gravatar_id: '',
    url: u,
    html_url: `${WEB}/${login}`,
    followers_url: `${u}/followers`,
    following_url: `${u}/following{/other_user}`,
    gists_url: `${u}/gists{/gist_id}`,
    starred_url: `${u}/starred{/owner}{/repo}`,
    subscriptions_url: `${u}/subscriptions`,
    organizations_url: `${u}/orgs`,
    repos_url: `${u}/repos`,
    events_url: `${u}/events{/privacy}`,
    received_events_url: `${u}/received_events`,
    type: 'User',
    user_view_type: 'public',
    site_admin: false,
  };
}

const REPO_LINKS = [
  'forks',
  'keys',
  'collaborators',
  'teams',
  'hooks',
  'issue_events',
  'events',
  'assignees',
  'branches',
  'tags',
  'blobs',
  'git_tags',
  'git_refs',
  'trees',
  'statuses',
  'languages',
  'stargazers',
  'contributors',
  'subscribers',
  'subscription',
  'commits',
  'git_commits',
  'comments',
  'issue_comment',
  'contents',
  'compare',
  'merges',
  'archive',
  'downloads',
  'issues',
  'pulls',
  'milestones',
  'notifications',
  'labels',
  'releases',
  'deployments',
];

/** A repository as GitHub lists it. */
function repository(owner: string, name: string, i = 0) {
  const full = `${owner}/${name}`;
  const api = `${API}/repos/${full}`;
  return {
    id: 5000 + i,
    node_id: 'R_kgDOabc',
    name,
    full_name: full,
    private: i % 3 === 0,
    owner: account(owner),
    html_url: `${WEB}/${full}`,
    description: `Project number ${i}`,
    fork: false,
    url: api,
    ...Object.fromEntries(REPO_LINKS.map((l) => [`${l}_url`, `${api}/${l}{/sha}`])),
    created_at: '2026-01-14T07:54:26Z',
    updated_at: '2026-10-16T05:20:08Z',
    pushed_at: '2026-10-16T05:19:44Z',
    git_url: `git://github.com/${full}.git`,
    ssh_url: `git@github.com:${full}.git`,
    clone_url: `${WEB}/${full}.git`,
    svn_url: `${WEB}/${full}`,
    homepage: null,
    size: 263,
    stargazers_count: 2,
    watchers_count: 2,
    language: 'TypeScript',
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: 1,
    license: {
      key: 'mit',
      name: 'MIT License',
      spdx_id: 'MIT',
      url: `${API}/licenses/mit`,
      node_id: 'x',
    },
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    has_pull_requests: true,
    pull_request_creation_policy: 'all',
    topics: [],
    visibility: i % 3 === 0 ? 'private' : 'public',
    forks: 0,
    open_issues: 1,
    watchers: 2,
    default_branch: 'main',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

/** A pull request as GitHub lists it: both its repositories in full, its people, its links. */
function pullRequest(full: string, number: number) {
  const [owner, name] = full.split('/') as [string, string];
  const api = `${API}/repos/${full}`;
  const side = (ref: string) => ({
    label: `${owner}:${ref}`,
    ref,
    sha: '9236a1b73d90149c4832d87e9a2245265bd4076d',
    user: account(owner),
    repo: repository(owner, name),
  });
  return {
    url: `${api}/pulls/${number}`,
    id: 4883875159,
    node_id: 'PR_kwDO',
    html_url: `${WEB}/${full}/pull/${number}`,
    diff_url: `${WEB}/${full}/pull/${number}.diff`,
    patch_url: `${WEB}/${full}/pull/${number}.patch`,
    issue_url: `${api}/issues/${number}`,
    number,
    state: 'open',
    locked: false,
    title: `Fix number ${number}`,
    user: account('priya-dev'),
    body: 'Replaces the hard-coded colour with the design token. '.repeat(20),
    created_at: '2026-10-16T05:19:45Z',
    updated_at: '2026-10-16T05:20:08Z',
    closed_at: null,
    merged_at: null,
    merge_commit_sha: 'bc5934f66e8186f8d7c360e2c5ecd44fffb6a30a',
    assignees: [account('rahul-dev')],
    requested_reviewers: [account('rahul-dev'), account('sam-dev')],
    requested_teams: [],
    labels: [
      {
        id: 1,
        node_id: 'LA_',
        url: `${api}/labels/bug`,
        name: 'bug',
        color: 'd73a4a',
        default: true,
        description: null,
      },
    ],
    milestone: null,
    draft: false,
    commits_url: `${api}/pulls/${number}/commits`,
    review_comments_url: `${api}/pulls/${number}/comments`,
    review_comment_url: `${api}/pulls/comments{/number}`,
    comments_url: `${api}/issues/${number}/comments`,
    statuses_url: `${api}/statuses/9236a1b`,
    head: side('crew/e880511j'),
    base: side('main'),
    _links: {
      self: { href: `${api}/pulls/${number}` },
      html: { href: `${WEB}/${full}/pull/${number}` },
      issue: { href: `${api}/issues/${number}` },
    },
    author_association: 'CONTRIBUTOR',
    auto_merge: null,
    assignee: account('rahul-dev'),
    active_lock_reason: null,
  };
}

const repos28 = () =>
  Array.from({ length: 28 }, (_, i) => repository('rahul-dev', `project-${i}`, i));
const LIST_REPOS = 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER';

describe("GitHub's answers", () => {
  it('a list of 28 repositories reaches the agent whole: before, 5 of them did', () => {
    const data = { repositories: repos28() };
    // As it was: the cut kept 5 repositories and a marker.
    const before = fitResult(data) as { repositories: unknown[] };
    expect(before.repositories.length).toBeLessThanOrEqual(6);
    expect(before.repositories.at(-1)).toBe('… [cut: 28 items in all]');

    const { data: shaped, note } = shapeResult(LIST_REPOS, { per_page: 100 }, data);
    expect(note).toBeUndefined();
    const list = (shaped as { repositories: Array<Record<string, unknown>> }).repositories;
    expect(list).toHaveLength(28);
    expect(JSON.stringify(shaped).length).toBeLessThan(MAX_RESULT_CHARS / 1.5);
    expect(list[0]).toEqual({
      id: 5000,
      name: 'project-0',
      full_name: 'rahul-dev/project-0',
      private: true,
      owner: 'rahul-dev',
      html_url: 'https://github.com/rahul-dev/project-0',
      description: 'Project number 0',
      fork: false,
      created_at: '2026-01-14T07:54:26Z',
      updated_at: '2026-10-16T05:20:08Z',
      pushed_at: '2026-10-16T05:19:44Z',
      homepage: null,
      size: 263,
      stargazers_count: 2,
      language: 'TypeScript',
      forks_count: 0,
      archived: false,
      open_issues_count: 1,
      license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
      topics: [],
      visibility: 'private',
      default_branch: 'main',
      permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    });
  });

  it('two pull requests of one repository are both there, with what a person asks about', () => {
    const data = {
      pull_requests: [
        pullRequest('rahul-dev/code-smith', 1),
        pullRequest('rahul-dev/code-smith', 2),
      ],
    };
    // As it was: one long text, cut in the middle of the first pull request.
    expect(typeof fitResult(data)).toBe('string');

    const { data: shaped, note } = shapeResult('GITHUB_LIST_PULL_REQUESTS', {}, data);
    expect(note).toBeUndefined();
    const prs = (shaped as { pull_requests: Array<Record<string, unknown>> }).pull_requests;
    expect(prs.map((p) => p.number)).toEqual([1, 2]);
    expect(prs[0]).toMatchObject({
      number: 1,
      title: 'Fix number 1',
      state: 'open',
      draft: false,
      user: 'priya-dev',
      html_url: 'https://github.com/rahul-dev/code-smith/pull/1',
      diff_url: 'https://github.com/rahul-dev/code-smith/pull/1.diff',
      assignee: 'rahul-dev',
      assignees: ['rahul-dev'],
      requested_reviewers: ['rahul-dev', 'sam-dev'],
      labels: [{ id: 1, name: 'bug', color: 'd73a4a', default: true, description: null }],
      head: { ref: 'crew/e880511j', user: 'rahul-dev', repo: 'rahul-dev/code-smith' },
      base: { ref: 'main', repo: 'rahul-dev/code-smith' },
      created_at: '2026-10-16T05:19:45Z',
    });
    expect(prs[0]!.body).toMatch(/^Replaces the hard-coded colour/);
    for (const gone of ['url', 'node_id', '_links', 'issue_url', 'commits_url', 'statuses_url'])
      expect(prs[0]).not.toHaveProperty(gone);
  });

  it('a notification keeps the link to its pull request; an issue says its repository', () => {
    const notification = {
      id: '1',
      repository: repository('acme', 'api'),
      subject: {
        title: 'Add rate limits',
        url: `${API}/repos/acme/api/pulls/12`,
        latest_comment_url: `${API}/repos/acme/api/issues/comments/9`,
        type: 'PullRequest',
      },
      reason: 'review_requested',
      unread: true,
      updated_at: '2026-10-17T05:00:00Z',
      url: `${API}/notifications/threads/1`,
      subscription_url: `${API}/notifications/threads/1/subscription`,
    };
    expect(slimGithub([notification])).toEqual([
      {
        id: '1',
        repository: 'acme/api',
        subject: {
          title: 'Add rate limits',
          url: `${API}/repos/acme/api/pulls/12`,
          type: 'PullRequest',
        },
        reason: 'review_requested',
        unread: true,
        updated_at: '2026-10-17T05:00:00Z',
      },
    ]);
    expect(
      slimGithub({
        number: 3,
        repository_url: `${API}/repos/acme/api`,
        html_url: `${WEB}/acme/api/issues/3`,
      }),
    ).toEqual({ number: 3, repository: 'acme/api', html_url: `${WEB}/acme/api/issues/3` });
  });

  it('the user themselves stays whole, and a commit keeps its git author', () => {
    const me = { ...account('rahul-dev'), name: 'Rahul', public_repos: 28, total_private_repos: 6 };
    const slim = slimGithub(me) as Record<string, unknown>;
    expect(slim).toMatchObject({
      login: 'rahul-dev',
      name: 'Rahul',
      public_repos: 28,
      total_private_repos: 6,
      html_url: `${WEB}/rahul-dev`,
    });
    for (const gone of ['avatar_url', 'url', 'repos_url', 'gravatar_id'])
      expect(slim).not.toHaveProperty(gone);

    const commit = {
      sha: '5dea06d',
      node_id: 'C_',
      commit: {
        author: { name: 'Rahul', email: 'rahul@example.com', date: '2026-10-14T07:54:26Z' },
        message: 'fixed notification',
        tree: { sha: '987d9b6', url: `${API}/repos/acme/api/git/trees/987d9b6` },
        url: `${API}/repos/acme/api/git/commits/5dea06d`,
        verification: {
          verified: false,
          reason: 'unsigned',
          signature: 'x'.repeat(800),
          payload: 'y'.repeat(300),
          verified_at: null,
        },
      },
      html_url: `${WEB}/acme/api/commit/5dea06d`,
      author: account('rahul-dev'),
      parents: [
        {
          sha: 'fc9589e',
          url: `${API}/repos/acme/api/commits/fc9589e`,
          html_url: `${WEB}/acme/api/commit/fc9589e`,
        },
      ],
    };
    expect(slimGithub(commit)).toEqual({
      sha: '5dea06d',
      commit: {
        author: { name: 'Rahul', email: 'rahul@example.com', date: '2026-10-14T07:54:26Z' },
        message: 'fixed notification',
        tree: { sha: '987d9b6' },
        verification: { verified: false, reason: 'unsigned' },
      },
      html_url: `${WEB}/acme/api/commit/5dea06d`,
      author: 'rahul-dev',
      parents: [{ sha: 'fc9589e', html_url: `${WEB}/acme/api/commit/fc9589e` }],
    });
  });

  it('a file keeps its content and its links to read it', () => {
    const file = {
      name: 'Header.tsx',
      path: 'src/Header.tsx',
      sha: 'abc',
      size: 12,
      url: `${API}/repos/acme/api/contents/src/Header.tsx`,
      html_url: `${WEB}/acme/api/blob/main/src/Header.tsx`,
      git_url: `${API}/repos/acme/api/git/blobs/abc`,
      download_url: 'https://raw.githubusercontent.com/acme/api/main/src/Header.tsx',
      type: 'file',
      content: 'ZXhwb3J0',
      encoding: 'base64',
      _links: { self: 'x' },
    };
    expect(slimGithub(file)).toEqual({
      name: 'Header.tsx',
      path: 'src/Header.tsx',
      sha: 'abc',
      size: 12,
      html_url: `${WEB}/acme/api/blob/main/src/Header.tsx`,
      download_url: 'https://raw.githubusercontent.com/acme/api/main/src/Header.tsx',
      type: 'file',
      content: 'ZXhwb3J0',
      encoding: 'base64',
    });
  });

  it('a list still too long is cut, with how to page through it', () => {
    const many = {
      repositories: Array.from({ length: 150 }, (_, i) => repository('acme', `r-${i}`, i)),
    };
    const { data, note } = shapeResult(LIST_REPOS, { per_page: 100 }, many);
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect((data as { repositories: unknown[] }).repositories.length).toBeGreaterThanOrEqual(20);
    expect(note).toMatch(/fewer per page \(per_page\) and then the next page \(page\)/);
  });

  it("another app's answer is not touched", () => {
    const data = { labels: [{ id: 'INBOX', url: `${API}/x`, node_id: 'n', owner: account('x') }] };
    expect(shapeResult('GMAIL_LIST_LABELS', {}, data).data).toEqual(data);
  });
});
