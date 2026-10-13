// An app the user connected must become usable by the agent, and the agent must be told when it is
// not yet (2026-10-13: the founder connected Google Calendar in the web app, and Tex saw GitHub only).
// Three causes, each reproduced here:
//   1. One request to Composio listed the tools of every connected app with one limit (200) for all
//      of them, so an app with hundreds of actions (GitHub) left no room for the next one.
//   2. A finished connection stayed "pending" here until a check or the web app asked Composio; the
//      agent's own tools never asked, and left a pending app out without a word.
//   3. The check read the user's whole list of accounts at Composio, which comes in pages, so the
//      new account could be missing from it. It now asks Composio for that one account.
import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { devUser, UsageError } from '../scripts/dev-user.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { startConnect } from '../src/modules/integrations/apps.ts';
import { pickManagedSetup, type ComposioTool } from '../src/modules/integrations/composio.ts';
import { handleCheckConnection } from '../src/modules/integrations/jobs.ts';
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

const MINUTE = 60_000;

/** `n` tools of a toolkit, named like Composio's: GITHUB_ACTION_1, … */
function toolsOf(toolkit: string, n: number, name = (i: number) => `ACTION_${i}`): ComposioTool[] {
  return Array.from({ length: n }, (_, i) => ({
    slug: `${toolkit.toUpperCase()}_${name(i + 1)}`,
    toolkit,
    name: `Action ${i + 1}`,
    description: `Action number ${i + 1}`,
    inputParameters: {},
    tags: ['readOnlyHint'],
  }));
}

/** GitHub has hundreds of actions at Composio; Google Calendar a few dozen. */
function realisticTools() {
  composio.state.tools.set('github', toolsOf('github', 320));
  composio.state.tools.set('googlecalendar', [
    ...toolsOf('googlecalendar', 1, () => 'EVENTS_LIST'),
    ...toolsOf('googlecalendar', 1, () => 'FIND_FREE_SLOTS'),
    ...toolsOf('googlecalendar', 1, () => 'CREATE_EVENT'),
  ]);
}

/** A user with a container token for /mcp and the given connections. */
async function agentUser(
  conns: Array<{ app: string; status: string; minutesAgo?: number }>,
  plan: 'free' | 'pro' | 'max' = 'max',
) {
  const user = await chatUser({ plan });
  const rows: Array<typeof connections.$inferInsert & { id: string; composioAccountId: string }> =
    [];
  for (const c of conns) {
    const row = {
      id: newId('con'),
      userId: user.id,
      app: c.app,
      composioAccountId: `ca_${randomUUID()}`,
      status: c.status as (typeof connections.$inferSelect)['status'],
      createdAt: new Date(Date.now() - (c.minutesAgo ?? 1) * MINUTE),
    };
    await db().insert(connections).values(row);
    rows.push(row);
  }
  await ensureSandbox(user.id);
  const token = vm.tokens.get(user.id)!;
  const mcp = async (tool: string, args: Record<string, unknown> = {}) => {
    const r = await mcpCall(token, tool, args);
    return { ...r, json: r.isError ? null : JSON.parse(r.text) };
  };
  /** What Composio says about one of the rows. */
  const composioSays = (row: (typeof rows)[number], status: string) => {
    const list = composio.state.accounts.get(user.id) ?? [];
    composio.state.accounts.set(user.id, [
      ...list.filter((a) => a.id !== row.composioAccountId),
      { id: row.composioAccountId, toolkit: row.app, status, label: 'me@example.com' },
    ]);
  };
  return { user, rows, mcp, composioSays };
}

type Listing = {
  apps: Array<{ app: string; name: string; status: string; note?: string; actions?: number }>;
  actions: Array<{ action: string; app: string }>;
};

const statusOf = async (id: string) =>
  (await db().select().from(connections).where(eq(connections.id, id)))[0]!.status;

describe('list_app_actions: every connected app gets its share', () => {
  it('an app with a few actions is listed next to one with hundreds', async () => {
    realisticTools();
    const { mcp } = await agentUser([
      { app: 'github', status: 'active' },
      { app: 'googlecalendar', status: 'active' },
    ]);
    const res = (await mcp('list_app_actions')).json as Listing;
    const apps = new Set(res.actions.map((a) => a.app));
    expect(apps).toEqual(new Set(['github', 'googlecalendar']));
    expect(res.actions.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'GOOGLECALENDAR_EVENTS_LIST',
        'GOOGLECALENDAR_FIND_FREE_SLOTS',
        'GOOGLECALENDAR_CREATE_EVENT',
      ]),
    );
    // Composio is asked once per app, so one app's actions can't use up another's room.
    expect(composio.state.toolRequests).toEqual(
      expect.arrayContaining([['github'], ['googlecalendar']]),
    );
    expect(composio.state.toolRequests.every((r) => r.length === 1)).toBe(true);
    // At most 100 actions in all; GitHub gets the room Calendar does not need, and is told to narrow.
    expect(res.actions.length).toBeLessThanOrEqual(100);
    expect(res.actions.filter((a) => a.app === 'github')).toHaveLength(97);
    // Composio answers at most 200 tools for one request (our limit), so GitHub shows 200.
    const github = res.apps.find((a) => a.app === 'github')!;
    expect(github).toMatchObject({ status: 'connected', actions: 200 });
    expect(github.note).toMatch(/97 of its 200 actions/);
    expect(github.note).toMatch(/app "github"/);
    expect(res.apps.find((a) => a.app === 'googlecalendar')).toMatchObject({
      name: 'Google Calendar',
      status: 'connected',
      actions: 3,
    });
  });

  it('the app filter and the search word still narrow it, to one app', async () => {
    realisticTools();
    const { mcp } = await agentUser([
      { app: 'github', status: 'active' },
      { app: 'googlecalendar', status: 'active' },
    ]);
    const cal = (await mcp('list_app_actions', { app: 'googlecalendar' })).json as Listing;
    expect(cal.actions.map((a) => a.action)).toEqual([
      'GOOGLECALENDAR_EVENTS_LIST',
      'GOOGLECALENDAR_FIND_FREE_SLOTS',
      'GOOGLECALENDAR_CREATE_EVENT',
    ]);
    expect(cal.apps.map((a) => a.app)).toEqual(['googlecalendar']);
    const found = (await mcp('list_app_actions', { search: 'free_slots' })).json as Listing;
    expect(found.actions.map((a) => a.action)).toEqual(['GOOGLECALENDAR_FIND_FREE_SLOTS']);
    // A big app alone still gets the whole 100.
    const gh = (await mcp('list_app_actions', { app: 'github' })).json as Listing;
    expect(gh.actions).toHaveLength(100);
  });

  it('one app Composio cannot list right now does not hide the others', async () => {
    realisticTools();
    composio.state.toolsError.set('github', new Error('composio is slow'));
    const { mcp } = await agentUser([
      { app: 'github', status: 'active' },
      { app: 'googlecalendar', status: 'active' },
    ]);
    const res = (await mcp('list_app_actions')).json as Listing;
    expect(res.actions.map((a) => a.app)).toEqual([
      'googlecalendar',
      'googlecalendar',
      'googlecalendar',
    ]);
    expect(res.apps.find((a) => a.app === 'github')!.note).toMatch(/could not be listed right now/);
  });
});

describe('list_app_actions and get_profile: a connection that is not ready', () => {
  it('finished at Composio but still pending here: the agent asks, and it is usable at once', async () => {
    realisticTools();
    const { user, rows, mcp, composioSays } = await agentUser([
      { app: 'github', status: 'active' },
      { app: 'googlecalendar', status: 'pending' },
    ]);
    composioSays(rows[1]!, 'ACTIVE');
    const res = (await mcp('list_app_actions')).json as Listing;
    expect(res.actions.map((a) => a.action)).toContain('GOOGLECALENDAR_EVENTS_LIST');
    expect(await statusOf(rows[1]!.id)).toBe('active');
    const profile = (await mcp('get_profile')).json as {
      connected_apps: Array<{ app: string }>;
    };
    expect(profile.connected_apps.map((a) => a.app).sort()).toEqual(['github', 'googlecalendar']);
    // And run_app_action runs it.
    const ran = await mcp('run_app_action', { action: 'GOOGLECALENDAR_EVENTS_LIST' });
    expect(ran.isError).toBe(false);
    expect(composio.executed.at(-1)).toMatchObject({
      slug: 'GOOGLECALENDAR_EVENTS_LIST',
      userId: user.id,
      connectedAccountId: rows[1]!.composioAccountId,
    });
  });

  it('get_profile asks Composio too, and run_app_action does when the app is not active yet', async () => {
    const a = await agentUser([{ app: 'googlecalendar', status: 'pending' }]);
    a.composioSays(a.rows[0]!, 'ACTIVE');
    const profile = (await a.mcp('get_profile')).json as { connected_apps: Array<{ app: string }> };
    expect(profile.connected_apps.map((x) => x.app)).toEqual(['googlecalendar']);

    const b = await agentUser([{ app: 'googlecalendar', status: 'pending' }]);
    b.composioSays(b.rows[0]!, 'ACTIVE');
    const ran = await b.mcp('run_app_action', { action: 'GOOGLECALENDAR_LIST_EMAILS' });
    expect(ran.isError).toBe(false);
  });

  it('still connecting: list_app_actions says so instead of leaving it out', async () => {
    realisticTools();
    const { rows, mcp, composioSays } = await agentUser([
      { app: 'github', status: 'active' },
      { app: 'googlecalendar', status: 'pending', minutesAgo: 2 },
    ]);
    composioSays(rows[1]!, 'INITIATED');
    const res = (await mcp('list_app_actions')).json as Listing;
    expect(res.actions.some((a) => a.app === 'googlecalendar')).toBe(false);
    const cal = res.apps.find((a) => a.app === 'googlecalendar')!;
    expect(cal.status).toBe('connecting');
    expect(cal.note).toMatch(/^Google Calendar is still connecting/);
    expect(cal.note).toContain('http://web.test/apps');
    // Asked for that app alone: no actions, and the same answer.
    const only = (await mcp('list_app_actions', { app: 'googlecalendar' })).json as Listing;
    expect(only.actions).toEqual([]);
    expect(only.apps).toEqual([cal]);
    // get_profile says it too.
    const profile = (await mcp('get_profile')).json as {
      connected_apps: Array<{ app: string }>;
      apps_not_ready: Array<{ app: string; status: string; note: string }>;
    };
    expect(profile.connected_apps.map((a) => a.app)).toEqual(['github']);
    expect(profile.apps_not_ready).toEqual([
      { app: 'googlecalendar', name: 'Google Calendar', status: 'connecting', note: cal.note },
    ]);
    // run_app_action explains rather than "not connected".
    const ran = await mcp('run_app_action', { action: 'GOOGLECALENDAR_EVENTS_LIST' });
    expect(ran.isError).toBe(true);
    expect(ran.text).toMatch(/Google Calendar is still connecting/);
  });

  it('a sign-in started long ago and never finished: connect it again on the Apps page', async () => {
    const { mcp } = await agentUser([{ app: 'googlecalendar', status: 'pending', minutesAgo: 90 }]);
    const res = (await mcp('list_app_actions')).json as Listing;
    expect(res.apps).toEqual([
      {
        app: 'googlecalendar',
        name: 'Google Calendar',
        status: 'not_finished',
        note: expect.stringMatching(
          /^Google Calendar did not finish connecting.*connect it again on the Apps page \(http:\/\/web\.test\/apps\)/,
        ),
      },
    ]);
  });

  it('expired or failed: it needs connecting again; an active one of the same app wins', async () => {
    const a = await agentUser([{ app: 'gmail', status: 'expired' }]);
    const res = (await a.mcp('list_app_actions')).json as Listing;
    expect(res.apps).toEqual([
      {
        app: 'gmail',
        name: 'Gmail',
        status: 'needs_reconnecting',
        note: expect.stringMatching(/^Gmail needs to be connected again.*http:\/\/web\.test\/apps/),
      },
    ]);
    const b = await agentUser([
      { app: 'gmail', status: 'error' },
      { app: 'gmail', status: 'pending', minutesAgo: 600 },
      { app: 'gmail', status: 'active' },
    ]);
    const res2 = (await b.mcp('list_app_actions')).json as Listing;
    expect(res2.apps).toEqual([{ app: 'gmail', name: 'Gmail', status: 'connected', actions: 2 }]);
    const profile = (await b.mcp('get_profile')).json as { apps_not_ready: unknown[] };
    expect(profile.apps_not_ready).toEqual([]);
  });

  it('a connected app that is not on the plan says so', async () => {
    const { mcp } = await agentUser(
      [
        { app: 'gmail', status: 'active' },
        { app: 'notion', status: 'active' },
        { app: 'linear', status: 'active' },
      ],
      'free',
    );
    const res = (await mcp('list_app_actions')).json as Listing;
    expect(new Set(res.actions.map((a) => a.app))).toEqual(new Set(['gmail', 'notion']));
    expect(res.apps.find((a) => a.app === 'linear')).toEqual({
      app: 'linear',
      name: 'Linear',
      status: 'not_on_plan',
      note: expect.stringMatching(/^Linear is connected, but it is not on your user's Free plan/),
    });
  });

  it('nothing connected: the answer says where apps are connected', async () => {
    const { mcp } = await agentUser([]);
    const res = (await mcp('list_app_actions')).json as Listing & { note: string };
    expect(res.apps).toEqual([]);
    expect(res.actions).toEqual([]);
    expect(res.note).toMatch(/No app is connected.*Apps page \(http:\/\/web\.test\/apps\)/);
  });
});

describe('the check asks Composio about the connection itself', () => {
  it('finds the new account when the user has more accounts than one page of the list', async () => {
    const user = await chatUser();
    // 30 older accounts at Composio (other apps, old attempts), then the new connect.
    composio.state.accounts.set(
      user.id,
      Array.from({ length: 30 }, (_, i) => ({
        id: `ca_old_${user.id}_${i}`,
        toolkit: 'github',
        status: 'EXPIRED',
        label: null,
      })),
    );
    composio.state.accountsPage = 20;
    await startConnect(user.id, 'max', 'googlecalendar');
    const [row] = await db().select().from(connections).where(eq(connections.userId, user.id));
    composio.state.accounts.get(user.id)!.push({
      id: row!.composioAccountId,
      toolkit: 'googlecalendar',
      status: 'ACTIVE',
      label: 'me@example.com',
    });
    const job = { data: { userId: user.id, connectionId: row!.id, run: 1, attempt: 0 } } as Job;
    expect(await handleCheckConnection(job)).toEqual({ status: 'active' });
    expect(composio.state.accountGets).toEqual([row!.composioAccountId]);
  });

  it('an account Composio does not know stays pending; a failure is left for the next check', async () => {
    const { rows } = await agentUser([{ app: 'googlecalendar', status: 'pending' }]);
    const job = {
      data: { userId: rows[0]!.userId, connectionId: rows[0]!.id, run: 2, attempt: 0 },
    } as Job;
    expect(await handleCheckConnection(job)).toEqual({ status: 'pending', nextCheck: true });
    composio.state.accountsError = new Error('down');
    expect(await handleCheckConnection(job)).toEqual({ status: 'pending', nextCheck: true });
    expect(await statusOf(rows[0]!.id)).toBe('pending');
  });
});

describe("the server's own setup for an app", () => {
  const setup = (id: string, toolkit: string | undefined, status = 'ENABLED') => ({
    id,
    status,
    toolkit,
  });

  it('reuses an enabled shared setup of the same app only', () => {
    expect(
      pickManagedSetup(
        [setup('ac_gh', 'github'), setup('ac_cal_off', 'googlecalendar', 'DISABLED')],
        'googlecalendar',
      ),
    ).toBeUndefined();
    expect(
      pickManagedSetup(
        [setup('ac_gh', 'github'), setup('ac_cal', 'googlecalendar')],
        'googlecalendar',
      ),
    ).toBe('ac_cal');
    expect(pickManagedSetup([setup('ac_cal', 'GoogleCalendar')], 'googlecalendar')).toBe('ac_cal');
    // Composio left the app out: not taken, a new one is made.
    expect(pickManagedSetup([setup('ac_x', undefined)], 'googlecalendar')).toBeUndefined();
  });
});

describe('dev-user: apps, to check a user on the server', () => {
  it('shows each connection with our status, its Composio account, its setup and what the agent sees', async () => {
    const userId = (await devUser(['create', '--email', 'Founder@Example.com']))[0]!.split(' ')[1]!;
    await devUser(['connect-app', '--user', userId, '--app', 'github']);
    await devUser(['connect-app', '--email', 'founder@example.com', '--app', 'googlecalendar']);
    const rows = await db().select().from(connections).where(eq(connections.userId, userId));
    const gh = rows.find((r) => r.app === 'github')!;
    const cal = rows.find((r) => r.app === 'googlecalendar')!;
    composio.state.accounts.set(userId, [
      {
        id: gh.composioAccountId,
        toolkit: 'github',
        status: 'ACTIVE',
        label: 'me@example.com',
        authConfigId: 'ac_github',
      },
      {
        id: cal.composioAccountId,
        toolkit: 'googlecalendar',
        status: 'INITIATED',
        label: null,
        authConfigId: 'ac_made_cal',
      },
      { id: 'ca_stray', toolkit: 'gmail', status: 'ACTIVE', label: null },
    ]);
    const out = await devUser(['apps', '--email', 'FOUNDER@example.com']);
    expect(out[0]).toBe(`user ${userId} (Founder@Example.com, plan free)`);
    const text = out.join('\n');
    expect(text).toMatch(
      new RegExp(
        `connection ${gh.id} github: active since \\S+, account ${gh.composioAccountId} ` +
          '\\(me@example\\.com\\); Composio: ACTIVE \\(app github, setup ac_github, me@example\\.com\\)',
      ),
    );
    expect(text).toContain(
      `connection ${cal.id} googlecalendar: pending since ${cal.createdAt.toISOString()}, ` +
        `account ${cal.composioAccountId}; Composio: INITIATED (app googlecalendar, setup ac_made_cal)`,
    );
    expect(out).toContain('setup github ac_github (COMPOSIO_AUTH_CONFIGS)');
    expect(text).toMatch(/setup googlecalendar ac_made_googlecalendar_\d+ \(made by the server\)/);
    expect(out).toContain('composio also has ca_stray (gmail, ACTIVE) with no connection here');
    expect(out).toContain('agent sees github: connected, 2 actions');
    expect(text).toMatch(
      /agent sees googlecalendar: connecting \(Google Calendar is still connecting/,
    );
    // Newest first.
    expect(out.findIndex((l) => l.includes(cal.id))).toBeLessThan(
      out.findIndex((l) => l.includes(gh.id)),
    );

    // Composio finishes it: the next look shows it active, for us and for the agent.
    composio.state.accounts.get(userId)![1]!.status = 'ACTIVE';
    const after = await devUser(['apps', '--user', userId]);
    expect(after).toContain('agent sees googlecalendar: connected, 2 actions');
    expect(after.join('\n')).toContain(`connection ${cal.id} googlecalendar: active since`);
  });

  it('--email finds the user; an unknown one, or neither flag, is a usage error', async () => {
    await expect(devUser(['apps', '--email', 'nobody@example.com'])).rejects.toBeInstanceOf(
      UsageError,
    );
    await expect(devUser(['apps'])).rejects.toThrow('--user (or --email) is required');
    const userId = (await devUser(['create', '--email', 'solo@example.com']))[0]!.split(' ')[1]!;
    expect((await devUser(['status', '--email', 'solo@example.com']))[0]).toContain(userId);
    expect(await devUser(['apps', '--user', userId])).toEqual([
      `user ${userId} (solo@example.com, plan free)`,
      'connections none',
      'agent sees: No app is connected. Your user connects apps on the Apps page (http://web.test/apps).',
    ]);
  });
});
