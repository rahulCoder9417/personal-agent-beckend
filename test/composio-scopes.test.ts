// The scope check (docs/composio.md, section 9): `dev-user.ts scopes --app <slug>` says what an
// app's sign-in asks the provider for, and what each Google scope means at Google, so the scopes
// of our own Google sign-in app can be chosen and justified. It only reads, and prints no secret.
// Composio is a fake here: the command is never run against the live key in tests.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { devUser, UsageError } from '../scripts/dev-user.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { requiredScopesFrom, scopesFromCredentials } from '../src/modules/integrations/composio.ts';
import {
  fullGoogleScope,
  googleScopeClass,
  googleScopeNeeds,
} from '../src/modules/integrations/google-scopes.ts';
import { composioAuthConfigs } from '../src/modules/integrations/tables.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm } from './fakes.ts';
import { chatUser } from './helpers.ts';

type Fake = Awaited<ReturnType<typeof installFakeComposio>>;
let composio: Fake;
const G = 'https://www.googleapis.com/auth/';

const SETTINGS = [
  'COMPOSIO_AUTH_CONFIGS',
  'COMPOSIO_MANAGED_APPS',
  'COMPOSIO_TRIAL_AUTH_CONFIGS',
  'COMPOSIO_TRIAL_USERS',
] as const;

function settings(env: {
  configs?: Record<string, string>;
  managed?: string;
  trial?: Record<string, string>;
  users?: string;
}) {
  process.env.COMPOSIO_AUTH_CONFIGS = JSON.stringify(env.configs ?? {});
  process.env.COMPOSIO_MANAGED_APPS = env.managed ?? '';
  process.env.COMPOSIO_TRIAL_AUTH_CONFIGS = env.trial ? JSON.stringify(env.trial) : '';
  process.env.COMPOSIO_TRIAL_USERS = env.users ?? '';
  resetConfig();
}

beforeAll(() => wireModules());
afterAll(async () => {
  for (const name of SETTINGS) delete process.env[name];
  resetConfig();
  await closeQueues();
});
beforeEach(async () => {
  installFakeVm();
  composio = await installFakeComposio();
  await db().delete(composioAuthConfigs);
  settings({ configs: { gmail: 'ac_gmail', github: 'ac_github' } });
});

describe("reading a setup's scopes, and nothing else of it", () => {
  it('takes the scope fields only: never the client id or secret beside them', () => {
    const credentials = {
      client_id: 'id-1234.apps.googleusercontent.com',
      client_secret: 'GOCSPX-very-secret',
      oauth_redirect_uri: 'https://api.textcrew.in/oauth/callback',
      scopes: `${G}calendar.events, ${G}userinfo.email`,
    };
    const scopes = scopesFromCredentials(credentials);
    expect(scopes).toEqual([`${G}calendar.events`, `${G}userinfo.email`]);
    expect(JSON.stringify(scopes)).not.toMatch(/GOCSPX|very-secret|googleusercontent|callback/);
  });

  it('a list, a string with spaces or commas, user scopes too; none is null', () => {
    expect(scopesFromCredentials({ scopes: ['repo', 'read:org', 'repo', 7] })).toEqual([
      'repo',
      'read:org',
    ]);
    expect(scopesFromCredentials({ scopes: 'a b,c', user_scopes: 'c,d' })).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(scopesFromCredentials({ scopes: ' , ' })).toBeNull();
    expect(scopesFromCredentials({ client_secret: 'x' })).toBeNull();
    expect(scopesFromCredentials(undefined)).toBeNull();
    expect(scopesFromCredentials('scopes')).toBeNull();
  });

  it("the scopes an app's OAuth sign-in always asks for", () => {
    expect(
      requiredScopesFrom([
        { mode: 'API_KEY', requiredScopes: ['nope'] },
        { mode: 'OAUTH2', requiredScopes: [`${G}gmail.modify`, `${G}gmail.modify`] },
      ]),
    ).toEqual([`${G}gmail.modify`]);
    expect(requiredScopesFrom([{ mode: 'OAUTH2' }])).toEqual([]);
    expect(requiredScopesFrom(undefined)).toEqual([]);
  });
});

describe("Google's class for a scope", () => {
  it('Gmail reading is restricted; sending alone is sensitive', () => {
    expect(googleScopeClass(`${G}gmail.modify`)).toBe('restricted');
    expect(googleScopeClass('gmail.readonly')).toBe('restricted');
    expect(googleScopeClass('https://mail.google.com/')).toBe('restricted');
    expect(googleScopeClass('gmail.send')).toBe('sensitive');
    expect(googleScopeClass('gmail.labels')).toBe('non-sensitive');
  });

  it('Calendar, Docs and Sheets are sensitive; Drive is restricted except drive.file', () => {
    expect(googleScopeClass('calendar.events')).toBe('sensitive');
    expect(googleScopeClass(`${G}calendar`)).toBe('sensitive');
    expect(googleScopeClass('documents')).toBe('sensitive');
    expect(googleScopeClass('spreadsheets')).toBe('sensitive');
    expect(googleScopeClass('drive')).toBe('restricted');
    expect(googleScopeClass('drive.readonly')).toBe('restricted');
    expect(googleScopeClass('drive.file')).toBe('non-sensitive');
  });

  it('basic sign-in scopes; anything else is not guessed', () => {
    expect(googleScopeClass('openid')).toBe('basic');
    expect(googleScopeClass(`${G}userinfo.email`)).toBe('basic');
    expect(googleScopeClass('calendar.acls')).toBeNull();
    expect(googleScopeNeeds(null)).toMatch(/look it up at Google/);
    expect(googleScopeNeeds('restricted')).toMatch(/CASA/);
    expect(fullGoogleScope(' calendar.events ')).toBe(`${G}calendar.events`);
    expect(fullGoogleScope('email')).toBe('email');
  });
});

describe('dev-user scopes', () => {
  it("our own Google Calendar app, for a trial user: its scopes, Composio's, and Google's classes", async () => {
    const founder = await chatUser();
    settings({ trial: { googlecalendar: 'ac_own_cal' }, users: founder.email });
    composio.state.authConfigs.set('ac_own_cal', { composioManaged: false, authScheme: 'OAUTH2' });
    composio.state.setupScopes.set('ac_own_cal', [`${G}calendar.events`]);
    composio.state.toolkitScopes.set('googlecalendar', {
      required: [`${G}userinfo.email`],
      leastPrivilege: [`${G}calendar.events`, `${G}calendar.readonly`],
      fewest: [`${G}calendar`],
    });

    const out = await devUser(['scopes', '--app', 'googlecalendar', '--email', founder.email]);
    expect(out).toEqual([
      'app googlecalendar (Google Calendar, signs in at Google; Composio toolkit googlecalendar)',
      `for user ${founder.id} (${founder.email}), a trial user`,
      'setup ac_own_cal (COMPOSIO_TRIAL_AUTH_CONFIGS): our own sign-in app',
      `setup asks for ${G}calendar.events`,
      `composio always asks for ${G}userinfo.email`,
      `composio's narrowest set for every action of the app: ${G}calendar.events ${G}calendar.readonly`,
      `composio's smallest set for every action of the app: ${G}calendar`,
      `scope ${G}calendar.events: sensitive (Google's review, no security assessment)`,
      `scope ${G}userinfo.email: basic (no review beyond the brand check)`,
      `scope ${G}calendar.readonly: sensitive (Google's review, no security assessment)`,
      `scope ${G}calendar: sensitive (Google's review, no security assessment)`,
      "google: the hardest of these is sensitive: Google's review, no security assessment",
    ]);
    // Only questions: nothing made, nothing connected.
    expect(composio.state.scopeQuestions).toEqual([
      { setup: 'ac_own_cal' },
      { toolkit: 'googlecalendar', tools: [] },
    ]);
    expect(composio.state.managedSetups).toEqual([]);
    expect(composio.state.signIns).toEqual([]);
  });

  it("Gmail on Composio's shared sign-in: the default set, and restricted at Google", async () => {
    composio.state.toolkitScopes.set('gmail', {
      required: [`${G}gmail.modify`, `${G}userinfo.email`],
      leastPrivilege: null,
      fewest: null,
    });
    const out = await devUser(['scopes', '--app', 'gmail']);
    expect(out).toContain("setup ac_gmail (COMPOSIO_AUTH_CONFIGS): Composio's shared sign-in");
    expect(out).toContain("setup asks for Composio's default set (it names no scopes of its own)");
    expect(out).toContain("composio's recommendation for every action of the app: not available");
    expect(out.at(-1)).toBe(
      "google: the hardest of these is restricted: Google's review and a yearly security assessment (CASA)",
    );
    expect(out.join('\n')).not.toMatch(/for user/);
  });

  it('asks about just the actions named, in capitals', async () => {
    await devUser(['scopes', '--app', 'gmail', '--tools', 'gmail_send_email, GMAIL_FETCH_EMAILS']);
    expect(composio.state.scopeQuestions.at(-1)).toEqual({
      toolkit: 'gmail',
      tools: ['GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS'],
    });
  });

  it('an app with no setup yet: says what would happen, and makes none', async () => {
    settings({ managed: 'googledrive' });
    const out = await devUser(['scopes', '--app', 'googledrive']);
    expect(out).toContain(
      "setup none yet: the server makes one with Composio's shared sign-in on the first connect",
    );
    expect(composio.state.managedSetups).toEqual([]);
    settings({});
    expect(await devUser(['scopes', '--app', 'googledrive'])).toContain(
      "setup none: the app can't be connected on this server",
    );
  });

  it("Composio unreachable: says so, and doesn't fail", async () => {
    composio.state.scopesError = new Error('composio is down');
    const out = await devUser(['scopes', '--app', 'gmail']);
    expect(out).toContain('setup scopes: could not ask Composio (composio is down)');
    expect(out).toContain('composio always asks for no scope it names');
  });

  it("an app that isn't Google gets no Google classes", async () => {
    composio.state.toolkitScopes.set('github', {
      required: ['repo'],
      leastPrivilege: null,
      fewest: null,
    });
    const out = await devUser(['scopes', '--app', 'github']);
    expect(out).toContain('composio always asks for repo');
    expect(out.some((l) => l.startsWith('scope ') || l.startsWith('google:'))).toBe(false);
  });

  it('needs a known app', async () => {
    await expect(devUser(['scopes'])).rejects.toBeInstanceOf(UsageError);
    await expect(devUser(['scopes', '--app', 'myspace'])).rejects.toThrow(/unknown app myspace/);
  });
});
