// Tex knows who the user is in a connected app, so it never asks (17 October 2026: asked about his
// repositories, Tex asked the founder for his GitHub username, and asked again in the next chat).
// Every connection's account label was empty: Composio's record of an account does not say who it
// is. The app is now asked once with its own "who am I" action, the answer is kept on the
// connection, and get_profile and list_app_actions show it as `account`.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeQueues } from '../src/modules/events/queues.ts';
import {
  identityFrom,
  IDENTITY_RETRY_MS,
  resetIdentityLookups,
  withAccountLabels,
} from '../src/modules/integrations/account-identity.ts';
import { appCatalogFor, listConnections } from '../src/modules/integrations/apps.ts';
import { setComposioApi, type ComposioTool } from '../src/modules/integrations/composio.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { ensureSandbox } from '../src/modules/orchestrator/sandbox.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { newId } from '../src/shared/ids.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm, mcpCall } from './fakes.ts';
import { chatUser } from './helpers.ts';

process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify({ gmail: 'ac_gmail', github: 'ac_github' });
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
  resetIdentityLookups();
});

/** GitHub's actions for "my repositories": none of them needs a username. */
const GITHUB_TOOLS: ComposioTool[] = [
  {
    slug: 'GITHUB_GET_THE_AUTHENTICATED_USER',
    toolkit: 'github',
    name: 'Get the authenticated user',
    description: 'Gets the profile information for the currently authenticated GitHub user.',
    inputParameters: { type: 'object', properties: {} },
    tags: ['readOnlyHint'],
  },
  {
    slug: 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
    toolkit: 'github',
    name: 'List repositories for the authenticated user',
    description: 'Lists repositories the authenticated user can access.',
    inputParameters: {
      type: 'object',
      properties: { visibility: { type: 'string' }, per_page: { type: 'integer' } },
    },
    tags: ['readOnlyHint'],
  },
];

/** A user with a container token for /mcp and these active connections. */
async function agentUser(apps: string[]) {
  const user = await chatUser({ plan: 'max' });
  const rows: Array<{ id: string; app: string; composioAccountId: string }> = [];
  for (const app of apps) {
    const row = { id: newId('con'), app, composioAccountId: `ca_${randomUUID()}` };
    await db()
      .insert(connections)
      .values({ ...row, userId: user.id, status: 'active' });
    rows.push(row);
  }
  await ensureSandbox(user.id);
  const token = vm.tokens.get(user.id)!;
  const mcp = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await mcpCall(token, tool, args);
    return { ...r, json: r.isError ? null : JSON.parse(r.text) };
  };
  return { user, rows, mcp };
}

const labelOf = async (id: string) =>
  (await db().select().from(connections).where(eq(connections.id, id)))[0]!.accountLabel;

type Listing = {
  apps: Array<{ app: string; status: string; account?: string | null }>;
  actions: Array<{ action: string }>;
};
type Profile = { connected_apps: Array<{ app: string; account: string | null }> };

describe('the account a connection is signed in as', () => {
  it('reads the field at the top of the result, or inside a wrapper, or in JSON text', () => {
    expect(identityFrom({ login: 'rahulCoder9417', id: 1 }, 'login')).toBe('rahulCoder9417');
    expect(identityFrom({ data: { emailAddress: 'me@acme.com' } }, 'emailAddress')).toBe(
      'me@acme.com',
    );
    expect(identityFrom({ response_data: { login: ' octo ' } }, 'login')).toBe('octo');
    expect(identityFrom('{"login":"from-text"}', 'login')).toBe('from-text');
    // The nearest wins over one deeper down.
    expect(identityFrom({ login: 'me', owner: { login: 'other' } }, 'login')).toBe('me');
    for (const nothing of [null, undefined, {}, { login: '' }, { login: 42 }, [{ login: 'x' }]])
      expect(identityFrom(nothing, 'login')).toBeNull();
  });

  it('list_app_actions says who GitHub is connected as, asked of GitHub once and kept', async () => {
    composio.state.tools.set('github', GITHUB_TOOLS);
    const { user, rows, mcp } = await agentUser(['github']);
    composio.state.identities.set(rows[0]!.composioAccountId, {
      login: 'rahulCoder9417',
      id: 1,
      type: 'User',
    });

    const res = (await mcp('list_app_actions', { app: 'github' })).json as Listing;
    expect(res.apps).toEqual([
      expect.objectContaining({ app: 'github', status: 'connected', account: 'rahulCoder9417' }),
    ]);
    // Asked with GitHub's own action, for this user's own connection; Tex's actions are untouched.
    expect(composio.state.whoAmICalls).toEqual([
      {
        slug: 'GITHUB_GET_THE_AUTHENTICATED_USER',
        userId: user.id,
        connectedAccountId: rows[0]!.composioAccountId,
      },
    ]);
    expect(composio.executed).toEqual([]);
    expect(await labelOf(rows[0]!.id)).toBe('rahulCoder9417');

    // Kept: later calls, and the profile in another chat, do not ask again.
    const again = (await mcp('list_app_actions')).json as Listing;
    expect(again.apps[0]!.account).toBe('rahulCoder9417');
    const profile = (await mcp('get_profile')).json as Profile;
    expect(profile.connected_apps).toEqual([
      { app: 'github', name: 'GitHub', account: 'rahulCoder9417' },
    ]);
    expect(composio.state.whoAmICalls).toHaveLength(1);
    // The Integrations page shows it too.
    const catalog = await appCatalogFor(user.id, 'max');
    expect(catalog.find((a) => a.slug === 'github')!.connections).toEqual([
      { id: rows[0]!.id, accountLabel: 'rahulCoder9417', status: 'active' },
    ]);
  });

  it('"my repositories" needs no username: the list action runs on the connection with no inputs', async () => {
    composio.state.tools.set('github', GITHUB_TOOLS);
    const { user, rows, mcp } = await agentUser(['github']);
    const described = (
      await mcp('describe_app_action', {
        action: 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
      })
    ).json as { input_schema: { properties: Record<string, unknown>; required?: string[] } };
    expect(Object.keys(described.input_schema.properties)).not.toContain('username');
    expect(described.input_schema.required ?? []).toEqual([]);
    const ran = await mcp('run_app_action', {
      action: 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
    });
    expect(ran.isError).toBe(false);
    expect(composio.executed.at(-1)).toMatchObject({
      slug: 'GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
      userId: user.id,
      connectedAccountId: rows[0]!.composioAccountId,
    });
  });

  it('get_profile asks too, Gmail with its own action; an app without one is not asked', async () => {
    const { rows, mcp } = await agentUser(['gmail', 'googlecalendar']);
    composio.state.identities.set(rows[0]!.composioAccountId, {
      data: { emailAddress: 'me@acme.com', messagesTotal: 10 },
    });
    const profile = (await mcp('get_profile')).json as Profile;
    expect(profile.connected_apps).toEqual(
      expect.arrayContaining([
        { app: 'gmail', name: 'Gmail', account: 'me@acme.com' },
        { app: 'googlecalendar', name: 'Google Calendar', account: null },
      ]),
    );
    expect(composio.state.whoAmICalls.map((c) => c.slug)).toEqual(['GMAIL_GET_PROFILE']);
    // An app that can't say has null: Tex's instructions say to ask the user once and save it.
    const res = (await mcp('list_app_actions')).json as Listing;
    expect(res.apps.find((a) => a.app === 'googlecalendar')!.account).toBeNull();
  });

  it('a failed lookup leaves no label, the tool still answers, and it is tried again later', async () => {
    const { user, rows, mcp } = await agentUser(['github']);
    composio.state.whoAmIFailure = new Error('composio down');
    const res = (await mcp('list_app_actions')).json as Listing;
    expect(res.apps[0]).toMatchObject({ app: 'github', status: 'connected', account: null });
    expect(await labelOf(rows[0]!.id)).toBeNull();

    // Not asked again at once (each call would wait for it), but after IDENTITY_RETRY_MS.
    await mcp('get_profile');
    expect(composio.state.whoAmICalls).toHaveLength(1);
    composio.state.identities.set(rows[0]!.composioAccountId, { login: 'octo' });
    const later = await withAccountLabels(
      await listConnections(user.id),
      Date.now() + IDENTITY_RETRY_MS,
    );
    expect(later[0]!.accountLabel).toBe('octo');
    expect(composio.state.whoAmICalls).toHaveLength(2);
    expect(await labelOf(rows[0]!.id)).toBe('octo');
  });

  it('a slow app does not hold up the answer; its label is kept when it comes', async () => {
    const { user, rows } = await agentUser(['github']);
    let answer!: () => void;
    const fake = (await import('../src/modules/integrations/composio.ts')).composio();
    setComposioApi({
      ...fake,
      whoAmI: () =>
        new Promise((resolve) => {
          answer = () => resolve({ successful: true, data: { login: 'slowpoke' }, error: null });
        }),
    });
    const began = Date.now();
    const now = await withAccountLabels(await listConnections(user.id), Date.now(), 50);
    expect(Date.now() - began).toBeLessThan(2_000);
    expect(now[0]!.accountLabel).toBeNull();
    answer();
    await expect.poll(() => labelOf(rows[0]!.id)).toBe('slowpoke');
  });

  it('a label already known is never asked for, nor overwritten', async () => {
    const { rows, mcp } = await agentUser(['github']);
    await db()
      .update(connections)
      .set({ accountLabel: 'known-login' })
      .where(eq(connections.id, rows[0]!.id));
    composio.state.identities.set(rows[0]!.composioAccountId, { login: 'other' });
    const res = (await mcp('list_app_actions')).json as Listing;
    expect(res.apps[0]!.account).toBe('known-login');
    expect(composio.state.whoAmICalls).toEqual([]);
  });
});
