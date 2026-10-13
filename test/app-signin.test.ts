// Connecting an app (docs/backend-report.md, "Apps through Composio"; docs/composio.md):
// - an app set up with our own sign-in app goes straight to the provider's page (`initiate()`
//   with the long redirect URL); Composio's shared sign-in keeps the Connect Link;
// - the catalog says who signs the user in and what Tex can do with each app.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeQueues } from '../src/modules/events/queues.ts';
import { connectReturnUrl, signInPath, startConnect } from '../src/modules/integrations/apps.ts';
import { CATALOG, findApp } from '../src/modules/integrations/catalog.ts';
import { connections } from '../src/modules/integrations/tables.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm } from './fakes.ts';
import { call, chatUser, expectContract } from './helpers.ts';

type Fake = Awaited<ReturnType<typeof installFakeComposio>>;
let composio: Fake;

function settings(env: { configs?: Record<string, string> }) {
  process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify(env.configs ?? {});
  resetConfig();
}

beforeAll(() => wireModules());
afterAll(async () => {
  delete process.env.COMPOSIO_AUTH_CONFIGS;
  resetConfig();
  await closeQueues();
});
beforeEach(async () => {
  installFakeVm();
  composio = await installFakeComposio();
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
        callbackUrl: 'http://web.test/apps?connected=github',
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
    expect(connectReturnUrl('gmail')).toBe('http://web.test/apps?connected=gmail');
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
      expect(connectReturnUrl('gmail', elsewhere)).toBe('http://web.test/apps?connected=gmail');
  });

  it('a return page of another site is not passed on to Composio', async () => {
    const user = await chatUser();
    await call('/v1/apps/gmail/connect', {
      method: 'POST',
      token: user.token,
      body: { returnUrl: 'http://web.test.evil.example/x' },
    });
    expect(composio.state.signIns[0]!.callbackUrl).toBe('http://web.test/apps?connected=gmail');
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
