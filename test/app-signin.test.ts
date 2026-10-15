// Connecting an app (docs/backend-report.md, "Apps through Composio"; docs/composio.md):
// - an app set up with our own sign-in app goes straight to the provider's page (`initiate()`
//   with the long redirect URL); Composio's shared sign-in keeps the Connect Link;
// - the server may make an app's Composio setup itself (COMPOSIO_MANAGED_APPS);
// - /oauth/callback sends the provider's way back on to Composio from our own address;
// - the catalog says who signs the user in and what Tex can do with each app.
import { Writable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeQueues } from '../src/modules/events/queues.ts';
import {
  appCatalogFor,
  connectReturnUrl,
  serverMaySetUp,
  signInPath,
  startConnect,
} from '../src/modules/integrations/apps.ts';
import { CATALOG, findApp } from '../src/modules/integrations/catalog.ts';
import { composioAuthConfigs, connections } from '../src/modules/integrations/tables.ts';
import { loadConfig, resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { buildLogger, setLogger } from '../src/shared/logger.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm } from './fakes.ts';
import { call, chatUser, expectContract } from './helpers.ts';

type Fake = Awaited<ReturnType<typeof installFakeComposio>>;
let composio: Fake;

function settings(env: { configs?: Record<string, string>; managed?: string }) {
  process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify(env.configs ?? {});
  process.env.COMPOSIO_MANAGED_APPS = env.managed ?? '';
  resetConfig();
}

beforeAll(() => wireModules());
afterAll(async () => {
  delete process.env.COMPOSIO_MANAGED_APPS;
  delete process.env.COMPOSIO_AUTH_CONFIGS;
  resetConfig();
  await closeQueues();
});
beforeEach(async () => {
  installFakeVm();
  composio = await installFakeComposio();
  await db().delete(composioAuthConfigs);
  settings({ configs: { gmail: 'ac_gmail', github: 'ac_own_github' } });
  // Our own GitHub sign-in app; Gmail stays on Composio's shared sign-in (the fake's default).
  composio.state.authConfigs.set('ac_own_github', { composioManaged: false, authScheme: 'OAUTH2' });
});

const connectionsOf = (userId: string) =>
  db().select().from(connections).where(eq(connections.userId, userId));

describe('which way the sign-in starts', () => {
  it('our own OAuth app goes straight to the provider; anything else gets a Connect Link', () => {
    expect(signInPath({ composioManaged: false, authScheme: 'OAUTH2' })).toEqual({
      kind: 'direct',
      authScheme: 'OAUTH2',
    });
    expect(signInPath({ composioManaged: false, authScheme: 'OAUTH1' })).toEqual({
      kind: 'direct',
      authScheme: 'OAUTH1',
    });
    // Composio's shared sign-in: initiate() was retired for it, the link is the only way.
    expect(signInPath({ composioManaged: true, authScheme: 'OAUTH2' })).toEqual({ kind: 'link' });
    // An API key is asked for on Composio's page.
    expect(signInPath({ composioManaged: false, authScheme: 'API_KEY' })).toEqual({
      kind: 'link',
    });
    // Composio couldn't be asked, or didn't say: the link works for every setup.
    expect(signInPath({ composioManaged: false, authScheme: null })).toEqual({ kind: 'link' });
    expect(signInPath(null)).toEqual({ kind: 'link' });
  });

  it("our own GitHub app: the link is GitHub's page, and the connection is saved as pending", async () => {
    const user = await chatUser();
    const res = await expectContract<{ redirectUrl: string }>(
      'connectApp',
      await call('/v1/apps/github/connect', { method: 'POST', token: user.token, body: {} }),
      200,
    );
    expect(res.redirectUrl).toBe('https://provider.test/oauth/authorize?config=ac_own_github');
    expect(composio.state.signIns).toEqual([
      {
        kind: 'direct',
        userId: user.id,
        authConfigId: 'ac_own_github',
        authScheme: 'OAUTH2',
        callbackUrl: 'http://web.test/integrations/apps?connected=github',
      },
    ]);
    expect(await connectionsOf(user.id)).toMatchObject([{ app: 'github', status: 'pending' }]);
  });

  it("Composio's shared sign-in (Gmail): a Connect Link, as before", async () => {
    const user = await chatUser();
    const started = await startConnect(user.id, user.plan, 'gmail');
    expect(started).toEqual({
      redirectUrl: 'https://composio.test/connect/ac_gmail',
      direct: false,
    });
    expect(composio.state.signIns.map((s) => s.kind)).toEqual(['link']);
  });

  it('asks Composio which kind a setup is once, then remembers it', async () => {
    const user = await chatUser();
    await startConnect(user.id, user.plan, 'github');
    await startConnect(user.id, user.plan, 'github');
    await startConnect(user.id, user.plan, 'gmail');
    await startConnect(user.id, user.plan, 'gmail');
    expect(composio.state.authConfigLookups).toEqual(['ac_own_github', 'ac_gmail']);
    expect(composio.state.signIns.map((s) => s.kind)).toEqual(['direct', 'direct', 'link', 'link']);
  });

  it("when Composio can't say, it uses a link and asks again next time", async () => {
    const user = await chatUser();
    composio.state.authConfigError = new Error('composio is down');
    expect((await startConnect(user.id, user.plan, 'github')).direct).toBe(false);
    expect((await startConnect(user.id, user.plan, 'github')).direct).toBe(true);
    expect(composio.state.authConfigLookups).toEqual(['ac_own_github', 'ac_own_github']);
  });

  it('a direct start that fails falls back to a Connect Link', async () => {
    const user = await chatUser();
    composio.state.directError = new Error('ComposioLegacyConnectedAccountsEndpointRetiredError');
    const started = await startConnect(user.id, user.plan, 'github');
    expect(started).toEqual({
      redirectUrl: 'https://composio.test/connect/ac_own_github',
      direct: false,
    });
    expect(await connectionsOf(user.id)).toHaveLength(1);
  });

  it('Composio refusing both ways is a 503, and nothing is saved', async () => {
    const user = await chatUser();
    composio.state.linkError = new Error('composio is down');
    const res = await expectContract<{ error: { code: string; message: string } }>(
      'connectApp',
      await call('/v1/apps/gmail/connect', { method: 'POST', token: user.token }),
      503,
    );
    expect(res.error).toMatchObject({
      code: 'unavailable',
      message: "Gmail can't be connected right now. Try again in a few minutes.",
    });
    expect(await connectionsOf(user.id)).toEqual([]);
  });

  it('comes back only to a page of our own web app', () => {
    expect(connectReturnUrl('gmail')).toBe('http://web.test/integrations/apps?connected=gmail');
    expect(connectReturnUrl('gmail', 'http://web.test/connected?app=gmail')).toBe(
      'http://web.test/connected?app=gmail',
    );
    for (const elsewhere of [
      'http://web.test.evil.example/connected', // starts the same way, another site
      'http://web.test@evil.example/connected',
      'https://web.test/connected', // another scheme is another origin
      'https://evil.example/',
      'not a url',
    ])
      expect(connectReturnUrl('gmail', elsewhere)).toBe(
        'http://web.test/integrations/apps?connected=gmail',
      );
  });

  it('a return page of another site is not passed on to Composio', async () => {
    const user = await chatUser();
    await call('/v1/apps/gmail/connect', {
      method: 'POST',
      token: user.token,
      body: { returnUrl: 'http://web.test.evil.example/x' },
    });
    expect(composio.state.signIns[0]!.callbackUrl).toBe(
      'http://web.test/integrations/apps?connected=gmail',
    );
  });
});

describe('the server makes an app setup itself (COMPOSIO_MANAGED_APPS)', () => {
  it('reads the setting: all, a list, or nothing', () => {
    const base = { ...process.env };
    const read = (v: string) =>
      loadConfig({ ...base, COMPOSIO_MANAGED_APPS: v }).COMPOSIO_MANAGED_APPS;
    expect(read('all')).toBe('all');
    expect(read(' ALL ')).toBe('all');
    expect(read(' Notion , slack,notion ')).toEqual(['notion', 'slack']);
    expect(read('')).toEqual([]);
    expect(loadConfig({ ...base, COMPOSIO_MANAGED_APPS: undefined }).COMPOSIO_MANAGED_APPS).toEqual(
      [],
    );
    expect(() => read('all,gmail')).toThrow(/stands alone/);
    expect(() => read('google calendar')).toThrow(/not an app name/);
  });

  it('with nothing set, only the apps named in COMPOSIO_AUTH_CONFIGS can be connected', async () => {
    const user = await chatUser({ plan: 'pro' });
    const apps = await appCatalogFor(user.id, user.plan);
    expect(apps.filter((a) => a.connectable).map((a) => a.slug)).toEqual(['gmail', 'github']);
    await expect(startConnect(user.id, user.plan, 'notion')).rejects.toMatchObject({
      status: 404,
      message: "Notion isn't configured yet",
    });
    expect(composio.state.managedSetups).toEqual([]);
  });

  it('`all`: every app with a shared sign-in at Composio can be connected; Exa still needs its own', async () => {
    settings({ configs: { gmail: 'ac_gmail' }, managed: 'all' });
    const user = await chatUser({ plan: 'pro' });
    const res = await expectContract<{ items: Array<{ slug: string; connectable: boolean }> }>(
      'listApps',
      await call('/v1/apps', { token: user.token }),
      200,
    );
    const off = res.items.filter((a) => !a.connectable).map((a) => a.slug);
    expect(off).toEqual(['exa']);
    expect(serverMaySetUp(findApp('exa')!)).toBe(false);
    await expect(startConnect(user.id, user.plan, 'exa')).rejects.toMatchObject({ status: 404 });
  });

  it('a list: just those apps', async () => {
    settings({ configs: { gmail: 'ac_gmail' }, managed: 'notion,slack,nonsense' });
    const user = await chatUser({ plan: 'pro' });
    const apps = await appCatalogFor(user.id, user.plan);
    expect(apps.filter((a) => a.connectable).map((a) => a.slug)).toEqual([
      'gmail',
      'notion',
      'slack',
    ]);
  });

  it('the first connect makes the setup and keeps it; later connects use the same one', async () => {
    settings({ managed: 'googlecalendar' });
    const a = await chatUser();
    const b = await chatUser();
    const first = await startConnect(a.id, a.plan, 'googlecalendar');
    expect(composio.state.managedSetups).toEqual([
      { toolkit: 'googlecalendar', name: 'Textcrew Google Calendar', id: expect.any(String) },
    ]);
    const made = composio.state.managedSetups[0]!.id;
    expect(first).toEqual({ redirectUrl: `https://composio.test/connect/${made}`, direct: false });
    expect(await db().select().from(composioAuthConfigs)).toMatchObject([
      { app: 'googlecalendar', authConfigId: made },
    ]);
    // Made with the shared sign-in, so the server knows its kind without asking.
    expect(composio.state.authConfigLookups).toEqual([]);

    await startConnect(b.id, b.plan, 'googlecalendar');
    expect(composio.state.managedSetups).toHaveLength(1);
    expect(composio.state.signIns.map((s) => s.authConfigId)).toEqual([made, made]);

    // Kept even when the app is later taken off the setting: its users' connections live on it.
    settings({ managed: '' });
    const apps = await appCatalogFor(a.id, a.plan);
    expect(apps.find((x) => x.slug === 'googlecalendar')!.connectable).toBe(true);
  });

  it('two first connects at once end on one saved setup', async () => {
    settings({ managed: 'notion' });
    const [a, b] = await Promise.all([chatUser(), chatUser()]);
    await Promise.all([startConnect(a.id, a.plan, 'notion'), startConnect(b.id, b.plan, 'notion')]);
    const saved = await db().select().from(composioAuthConfigs);
    expect(saved).toHaveLength(1);
    // Whichever was made first or second, everyone is sent to the saved one from now on.
    const c = await chatUser();
    await startConnect(c.id, c.plan, 'notion');
    expect(composio.state.signIns.at(-1)!.authConfigId).toBe(saved[0]!.authConfigId);
  });

  it("a setup Composio won't make is a 503; nothing is kept and the next try asks again", async () => {
    settings({ managed: 'all' });
    const user = await chatUser();
    composio.state.setupError = new Error('key may not create auth configs');
    const res = await expectContract<{ error: { code: string } }>(
      'connectApp',
      await call('/v1/apps/notion/connect', { method: 'POST', token: user.token }),
      503,
    );
    expect(res.error.code).toBe('unavailable');
    expect(await db().select().from(composioAuthConfigs)).toEqual([]);
    expect(await connectionsOf(user.id)).toEqual([]);
    await startConnect(user.id, user.plan, 'notion');
    expect(composio.state.managedSetups).toHaveLength(1);
  });

  it('COMPOSIO_AUTH_CONFIGS wins over a setup the server made', async () => {
    settings({ managed: 'github' });
    const user = await chatUser();
    await startConnect(user.id, user.plan, 'github');
    const made = composio.state.managedSetups[0]!.id;
    // Later, our own GitHub app is named in the settings: new connects use it, straight to GitHub.
    settings({ configs: { github: 'ac_own_github' }, managed: 'github' });
    const started = await startConnect(user.id, user.plan, 'github');
    expect(started.direct).toBe(true);
    expect(composio.state.signIns.map((s) => s.authConfigId)).toEqual([made, 'ac_own_github']);
  });

  it('plan limits come first: nothing is made for an app the plan does not include', async () => {
    settings({ managed: 'all' });
    const user = await chatUser(); // Free
    const res = await expectContract<{ error: { code: string } }>(
      'connectApp',
      await call('/v1/apps/outlook/connect', { method: 'POST', token: user.token }),
      403,
    );
    expect(res.error.code).toBe('plan_limit');
    expect(composio.state.managedSetups).toEqual([]);
  });
});

describe('/oauth/callback: the way back through our own address', () => {
  afterEach(() => setLogger(undefined));

  it('sends the browser on to Composio with the same query, and logs no part of it', async () => {
    const lines: string[] = [];
    setLogger(
      buildLogger(
        new Writable({
          write(chunk, _enc, cb) {
            lines.push(String(chunk));
            cb();
          },
        }),
        'trace',
      ),
    );
    const query = 'code=4%2F0secret-one-time-code&state=st_abc&scope=repo%20read%3Auser';
    const res = await call(`/oauth/callback?${query}`); // no session: the provider sends it
    await expectContract('oauthCallback', res, 302);
    expect(res.headers.get('location')).toBe(
      `https://backend.composio.dev/api/v3/toolkits/auth/callback?${query}`,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const logged = lines.join('');
    expect(logged).toContain('"route":"/oauth/callback"'); // the capture works
    expect(logged).not.toMatch(/secret-one-time-code|st_abc/);
  });

  it('follows COMPOSIO_API_URL, and passes an empty query as it is', async () => {
    process.env.COMPOSIO_API_URL = 'https://composio.example/';
    resetConfig();
    try {
      const res = await call('/oauth/callback');
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(
        'https://composio.example/api/v3/toolkits/auth/callback',
      );
    } finally {
      delete process.env.COMPOSIO_API_URL;
      resetConfig();
    }
  });
});

describe('the catalog, for the connect screen', () => {
  it('every app names who signs the user in and what Tex can do with it, in one sentence', () => {
    for (const app of CATALOG) {
      expect(app.provider, app.slug).toMatch(/^[A-Z][A-Za-z]+$/);
      expect(app.description, app.slug).toMatch(/^[A-Z][^.]{10,90}\.$/);
    }
    expect(findApp('gmail')).toMatchObject({ provider: 'Google' });
    expect(findApp('jira')).toMatchObject({ provider: 'Atlassian' });
    expect(CATALOG.filter((a) => !a.managedAuth).map((a) => a.slug)).toEqual(['exa']);
  });

  it('the app list carries both', async () => {
    const user = await chatUser();
    const res = await expectContract<{
      items: Array<{ slug: string; provider: string; description: string }>;
    }>('listApps', await call('/v1/apps', { token: user.token }), 200);
    expect(res.items.find((a) => a.slug === 'googlesheets')).toMatchObject({
      provider: 'Google',
      description: 'Read your spreadsheets, and add or update rows.',
    });
  });
});
