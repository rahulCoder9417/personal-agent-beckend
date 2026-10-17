// 17 October 2026: the founder asked Tex "tell me about open pr". Tex searched GitHub's actions
// about 30 times ("pull request", "list pull requests", "pulls", "search issues", ...), found no way
// to list pull requests, told him GitHub had none, and sent Scout to read github.com page by page
// (his public repos only). GitHub has about 900 actions at Composio, listed in alphabetical order,
// and the api asked for 200: the list stopped in the Cs (create, close, check), and a search only
// looked in those 200. The search also had to find the words exactly as typed: "list pull requests"
// is not in "Lists pull requests for a GitHub repository". Both are fixed and checked here: the
// whole list is asked for (up to 1,000), and each word of a search is matched, best first.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeQueues } from '../src/modules/events/queues.ts';
import { matchActions, searchWords } from '../src/modules/integrations/agent-apps.ts';
import type { ComposioTool } from '../src/modules/integrations/composio.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm, mcpCall } from './fakes.ts';
import { chatUser } from './helpers.ts';

process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({ gmail: 'ac_gmail', github: 'ac_github' });
process.env.COMPOSIO_MANAGED_APPS = 'all';
resetConfig();

let vm: ReturnType<typeof installFakeVm>;
let composio: Awaited<ReturnType<typeof installFakeComposio>>;

beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(async () => {
  vm = installFakeVm();
  composio = await installFakeComposio();
});

const gh = (slug: string, name: string, description: string): ComposioTool => ({
  slug: `GITHUB_${slug}`,
  toolkit: 'github',
  name,
  description,
  inputParameters: {},
  tags: [],
});

/** Real GitHub actions at Composio, with the start of their real descriptions (17 Oct 2026). */
const REAL = [
  gh(
    'API_ROOT',
    'Get GitHub API root',
    'Retrieves a map of all top-level GitHub REST API resource URLs and their templates.',
  ),
  gh(
    'CHECK_IF_PULL_REQUEST_HAS_BEEN_MERGED',
    'Check if pull request merged',
    'Checks if a specified GitHub pull request has been merged, indicated by a 204 HTTP status (merged) or 404 (not merged/found).',
  ),
  gh(
    'CLOSE_PULL_REQUEST',
    'Close a pull request',
    'Closes an open pull request without merging it. The pull request state is set to "closed" and it can be reopened later if needed.',
  ),
  gh(
    'CREATE_A_PULL_REQUEST',
    'Create a pull request',
    'Creates a pull request in a GitHub repository, requiring existing `base` and `head` branches; `title` or `issue` must be provided.',
  ),
  gh(
    'CREATE_A_REVIEW_FOR_A_PULL_REQUEST',
    'Create a review for a pull request',
    'Creates a pull request review, allowing approval, change requests, or comments.',
  ),
  gh(
    'CREATE_AN_ISSUE',
    'Create an issue',
    'Creates a new issue in a GitHub repository, requiring the repository to exist and have issues enabled.',
  ),
  gh(
    'FIND_PULL_REQUESTS',
    'Find Pull Requests',
    'Primary tool to find and search pull requests. Supports filtering by repository, author, state, labels, and merge status.',
  ),
  gh(
    'GET_A_PULL_REQUEST',
    'Get a pull request',
    'Retrieves a specific pull request from a GitHub repository using its owner, repository name, and pull request number.',
  ),
  gh(
    'GET_PULL_REQUESTS',
    'Get Pull Requests',
    'Retrieves a list of pull requests from a repository with flexible filtering options. Use this action when you need to list all pull requests in a repository, optionally filtered by state (open, closed, all).',
  ),
  gh(
    'GET_THE_AUTHENTICATED_USER',
    'Get the authenticated user',
    'Gets the profile information for the currently authenticated GitHub user, including potentially private details based on user settings.',
  ),
  gh(
    'LIST_ISSUES_ASSIGNED_TO_THE_AUTHENTICATED_USER',
    'List issues for user',
    'Lists GitHub issues for the authenticated user across visible repositories.',
  ),
  gh(
    'LIST_PULL_REQUESTS',
    'List pull requests',
    "Lists pull requests for a GitHub repository. REQUIRES 'owner' AND 'repo' parameters.",
  ),
  gh(
    'LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
    'List repositories for the authenticated user',
    'Lists repositories for the authenticated user.',
  ),
  gh(
    'MERGE_A_PULL_REQUEST',
    'Merge a pull request',
    'Merges an open and mergeable pull request in a repository.',
  ),
  gh(
    'SEARCH_ISSUES_AND_PULL_REQUESTS',
    'Search issues and pull requests',
    'Searches GitHub for issues and pull requests. Supports keywords, qualifiers (repo:, org:, user:, state:, label:, author:, assignee:, mentions:, etc.).',
  ),
  gh(
    'SEARCH_REPOSITORIES',
    'Search repositories',
    'Searches GitHub repositories using a flexible query (keywords, qualifiers) with sorting, ordering, and pagination.',
  ),
];

const fillers = (verb: string, n: number) =>
  Array.from({ length: n }, (_, i) => {
    const k = String(i + 1).padStart(3, '0');
    return gh(`${verb}_THING_${k}`, `${verb.toLowerCase()} thing ${k}`, `Does thing ${k}.`);
  });

/**
 * About 900 actions in Composio's order (alphabetical): the first 200 hold the create, close and
 * check actions of a pull request, and none that lists, finds, gets or searches.
 */
function githubAtComposio(): ComposioTool[] {
  return [
    ...fillers('ADD', 150),
    ...REAL,
    ...fillers('DELETE', 300),
    ...fillers('UPDATE', 899 - 450 - REAL.length),
  ].sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

async function agentUser(apps: string[]) {
  const user = await chatUser({ plan: 'max' });
  for (const app of apps)
    await db()
      .insert(connections)
      .values({
        id: newId('con'),
        userId: user.id,
        app,
        composioAccountId: `ca_${randomUUID()}`,
        status: 'active',
      });
  await ensureSandbox(user.id);
  const token = vm.tokens.get(user.id)!;
  return async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await mcpCall(token, tool, args);
    return { ...r, json: r.isError ? null : JSON.parse(r.text) };
  };
}

type Listing = {
  apps: Array<{ app: string; status: string; note?: string; actions?: number }>;
  actions: Array<{ action: string; app: string; description: string }>;
};

const PR_LISTS = [
  'GITHUB_FIND_PULL_REQUESTS',
  'GITHUB_GET_PULL_REQUESTS',
  'GITHUB_LIST_PULL_REQUESTS',
  'GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS',
];

describe('list_app_actions finds every action of a big app (17 Oct: GitHub pull requests)', () => {
  it('reproduces 17 October: with the list cut at 200, "pull request" found only create, close and check', async () => {
    composio.state.tools.set('github', githubAtComposio());
    composio.state.toolsLimit = 200; // what the api asked Composio for until 17 October
    const mcp = await agentUser(['github']);
    const res = (await mcp('list_app_actions', { app: 'github', search: 'pull request' }))
      .json as Listing;
    expect(res.actions.map((a) => a.action)).toEqual([
      'GITHUB_CHECK_IF_PULL_REQUEST_HAS_BEEN_MERGED',
      'GITHUB_CLOSE_PULL_REQUEST',
      'GITHUB_CREATE_A_PULL_REQUEST',
      'GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST',
    ]);
  });

  it("every search Tex tried on 17 October now finds the way to list pull requests or the user's repos", async () => {
    composio.state.tools.set('github', githubAtComposio());
    const mcp = await agentUser(['github']);
    const search = async (words: string) =>
      (
        (await mcp('list_app_actions', { app: 'github', search: words })).json as Listing
      ).actions.map((a) => a.action);

    expect(await search('pull request')).toEqual(expect.arrayContaining(PR_LISTS));
    for (const words of ['list pull requests', 'list pulls', 'pulls', 'PULL'])
      expect(await search(words), words).toContain('GITHUB_LIST_PULL_REQUESTS');
    // "open" is only in some descriptions here: the ones that have it, a list among them.
    expect(await search('open PRs')).toContain('GITHUB_GET_PULL_REQUESTS');
    expect((await search('list pull requests'))[0]).toBe('GITHUB_LIST_PULL_REQUESTS');
    expect(await search('search issues')).toContain('GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS');
    for (const words of [
      'list repositories',
      'repos for authenticated user',
      'list user repositories',
    ])
      expect(await search(words), words).toContain(
        'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
      );
    expect((await search('get authenticated user'))[0]).toBe('GITHUB_GET_THE_AUTHENTICATED_USER');
    expect((await search('get authenticated user profile'))[0]).toBe(
      'GITHUB_GET_THE_AUTHENTICATED_USER',
    );
  });

  it('the found action is described from the same listing, without asking Composio by name', async () => {
    composio.state.tools.set('github', githubAtComposio());
    const mcp = await agentUser(['github']);
    await mcp('list_app_actions', { app: 'github', search: 'pull request' });
    const described = await mcp('describe_app_action', { action: 'GITHUB_FIND_PULL_REQUESTS' });
    expect(described.isError).toBe(false);
    expect(described.json).toMatchObject({ action: 'GITHUB_FIND_PULL_REQUESTS', costs_credits: 0 });
    expect(composio.state.toolLookups).toEqual([]);
  });

  it('a search that finds nothing, or only some of its words, says so', async () => {
    composio.state.tools.set('github', githubAtComposio());
    const mcp = await agentUser(['github']);
    const none = (await mcp('list_app_actions', { app: 'github', search: 'calendar invite' }))
      .json as Listing;
    expect(none.actions).toEqual([]);
    expect(none.apps[0]!.note).toMatch(/No GitHub action matches "calendar invite"/);
    const some = (
      await mcp('list_app_actions', { app: 'github', search: 'list pull requests banana' })
    ).json as Listing;
    expect(some.actions[0]!.action).toBe('GITHUB_LIST_PULL_REQUESTS');
    expect(some.apps[0]!.note).toMatch(/No GitHub action has every word/);
  });

  it('across apps, an app with only some of the words stays out of the way', async () => {
    composio.state.tools.set('github', githubAtComposio());
    const mcp = await agentUser(['github', 'gmail']);
    // Gmail's fake actions are GMAIL_SEND_EMAIL and GMAIL_LIST_EMAILS: "list" but no pull request.
    const res = (await mcp('list_app_actions', { search: 'list pull requests' })).json as Listing;
    expect(new Set(res.actions.map((a) => a.app))).toEqual(new Set(['github']));
    expect(res.actions[0]!.action).toBe('GITHUB_LIST_PULL_REQUESTS');
    expect(res.apps.find((a) => a.app === 'gmail')).toMatchObject({ actions: 0 });
    expect(res.apps.find((a) => a.app === 'gmail')!.note).toBeUndefined();
  });
});

describe('matchActions', () => {
  it('reads the words of a search: no small words, PR spelled out, no plural endings', () => {
    expect(searchWords('open PRs for my repos')).toEqual(['open', 'pull', 'request', 'repo']);
    expect(searchWords('GITHUB_LIST_REPOSITORIES')).toEqual(['github', 'list', 'repository']);
    expect(searchWords('  the  ')).toEqual([]);
  });

  it('puts the words in the name before the words only in the description', () => {
    const found = matchActions(githubAtComposio(), 'list pull requests').tools.map((t) => t.slug);
    // All three words in the name, then "list" only in the description.
    expect(found.slice(0, 2)).toEqual(['GITHUB_LIST_PULL_REQUESTS', 'GITHUB_GET_PULL_REQUESTS']);
  });

  it('with no words that narrow, keeps every action', () => {
    const all = githubAtComposio();
    expect(matchActions(all, 'the').tools).toHaveLength(all.length);
  });
});
