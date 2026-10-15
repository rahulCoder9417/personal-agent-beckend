// The trial switch (docs/composio.md, section 9): a second Composio setup per app, used only by the
// users named in COMPOSIO_TRIAL_USERS. That lets the founder and a few test users connect through
// our own Google sign-in app while Google reviews it, while everyone else keeps the usual setup.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeQueues } from '../src/modules/events/queues.ts';
import {
  appCatalogFor,
  currentSetupFor,
  isTrialUser,
  startConnect,
} from '../src/modules/integrations/apps.ts';
import { composioAuthConfigs } from '../src/modules/integrations/tables.ts';
import { loadConfig, resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm } from './fakes.ts';
import { call, chatUser, expectContract } from './helpers.ts';

type Fake = Awaited<ReturnType<typeof installFakeComposio>>;
let composio: Fake;

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
  // Our own Google sign-in app, at Composio: a custom OAuth setup.
  composio.state.authConfigs.set('ac_own_google_cal', {
    composioManaged: false,
    authScheme: 'OAUTH2',
  });
});

describe('the settings', () => {
  const base = () => ({ ...process.env });

  it('COMPOSIO_TRIAL_AUTH_CONFIGS: a JSON map of app → setup id; empty is none', () => {
    const read = (v: string | undefined) =>
      loadConfig({ ...base(), COMPOSIO_TRIAL_AUTH_CONFIGS: v }).COMPOSIO_TRIAL_AUTH_CONFIGS;
    expect(read(undefined)).toEqual({});
    expect(read('')).toEqual({});
    expect(read('  ')).toEqual({});
    expect(read('{}')).toEqual({});
    expect(read('{"googlecalendar":"ac_abc123","gmail":"ac_X-y_9"}')).toEqual({
      googlecalendar: 'ac_abc123',
      gmail: 'ac_X-y_9',
    });
  });

  it('a damaged COMPOSIO_TRIAL_AUTH_CONFIGS stops the start, and says why', () => {
    const read = (v: string) => loadConfig({ ...base(), COMPOSIO_TRIAL_AUTH_CONFIGS: v });
    expect(() => read('{"googlecalendar":"ac_1"')).toThrow(/not JSON/);
    expect(() => read('["ac_1"]')).toThrow(/must be a JSON object/);
    expect(() => read('"ac_1"')).toThrow(/must be a JSON object/);
    expect(() => read('{"Google Calendar":"ac_1"}')).toThrow(/not an app name/);
    expect(() => read('{"googlecalendar":"cal_1"}')).toThrow(/starts with ac_/);
    expect(() => read('{"googlecalendar":42}')).toThrow(/starts with ac_/);
  });

  it('COMPOSIO_TRIAL_USERS: user ids and emails, emails in lower case, no repeats', () => {
    const read = (v: string | undefined) =>
      loadConfig({ ...base(), COMPOSIO_TRIAL_USERS: v }).COMPOSIO_TRIAL_USERS;
    expect(read(undefined)).toEqual([]);
    expect(read('')).toEqual([]);
    expect(read(' usr_01k7abcdefghjkmnpqrstv , Founder@Example.com,founder@example.com ,')).toEqual(
      ['usr_01k7abcdefghjkmnpqrstv', 'founder@example.com'],
    );
    expect(() => read('founder')).toThrow(/not a user id or an email: founder/);
    expect(() => read('usr_x')).toThrow(/not a user id or an email/);
  });
});

describe('who gets the trial setup', () => {
  it('a user named by verified email or by id; nobody else', async () => {
    const byEmail = await chatUser();
    const byId = await chatUser();
    const unverified = await chatUser({ emailVerified: false });
    const other = await chatUser();
    settings({
      trial: { googlecalendar: 'ac_own_google_cal' },
      users: `${byEmail.email.toUpperCase()}, ${byId.id}, ${unverified.email}`,
    });
    expect(await isTrialUser(byEmail.id)).toBe(true);
    expect(await isTrialUser(byId.id)).toBe(true);
    // An email anyone could type at sign-up counts only once it is verified.
    expect(await isTrialUser(unverified.id)).toBe(false);
    expect(await isTrialUser(other.id)).toBe(false);
  });

  it('with no trial users, nobody is one', async () => {
    const user = await chatUser();
    settings({ trial: { googlecalendar: 'ac_own_google_cal' } });
    expect(await isTrialUser(user.id)).toBe(false);
  });
});

describe('connecting with the trial setup', () => {
  it('a trial user connects through our own sign-in app; everyone else keeps the usual setup', async () => {
    const founder = await chatUser();
    const other = await chatUser();
    settings({
      managed: 'googlecalendar',
      trial: { googlecalendar: 'ac_own_google_cal' },
      users: founder.email,
    });

    const mine = await expectContract<{ redirectUrl: string }>(
      'connectApp',
      await call('/v1/apps/googlecalendar/connect', {
        method: 'POST',
        token: founder.token,
        body: {},
      }),
      200,
    );
    // Straight to Google's page, with our own app: no Composio page.
    expect(mine.redirectUrl).toBe('https://provider.test/oauth/authorize?config=ac_own_google_cal');

    const theirs = await startConnect(other.id, other.plan, 'googlecalendar');
    // The usual way: the server makes the shared setup, and Composio's page comes first.
    const made = composio.state.managedSetups[0]!.id;
    expect(theirs).toEqual({ redirectUrl: `https://composio.test/connect/${made}`, direct: false });

    expect(composio.state.signIns.map((s) => [s.userId, s.authConfigId, s.kind])).toEqual([
      [founder.id, 'ac_own_google_cal', 'direct'],
      [other.id, made, 'link'],
    ]);
  });

  it('for a trial user it wins over COMPOSIO_AUTH_CONFIGS; other apps are untouched', async () => {
    const founder = await chatUser();
    settings({
      configs: { googlecalendar: 'ac_shared_cal', gmail: 'ac_gmail' },
      trial: { googlecalendar: 'ac_own_google_cal' },
      users: founder.id,
    });
    await startConnect(founder.id, founder.plan, 'googlecalendar');
    await startConnect(founder.id, founder.plan, 'gmail');
    expect(composio.state.signIns.map((s) => s.authConfigId)).toEqual([
      'ac_own_google_cal',
      'ac_gmail',
    ]);
    expect(await currentSetupFor('googlecalendar', founder.id)).toEqual({
      id: 'ac_own_google_cal',
      source: 'COMPOSIO_TRIAL_AUTH_CONFIGS',
    });
    // Asked without a user (or for anyone else), the usual setup.
    expect(await currentSetupFor('googlecalendar')).toEqual({
      id: 'ac_shared_cal',
      source: 'COMPOSIO_AUTH_CONFIGS',
    });
  });

  it('an app with only a trial setup can be connected by trial users only', async () => {
    const founder = await chatUser();
    const other = await chatUser();
    settings({ trial: { googlecalendar: 'ac_own_google_cal' }, users: founder.email });

    const connectable = async (userId: string, plan: typeof founder.plan) =>
      (await appCatalogFor(userId, plan)).find((a) => a.slug === 'googlecalendar')!.connectable;
    expect(await connectable(founder.id, founder.plan)).toBe(true);
    expect(await connectable(other.id, other.plan)).toBe(false);

    await expect(startConnect(other.id, other.plan, 'googlecalendar')).rejects.toMatchObject({
      status: 404,
    });
    expect((await startConnect(founder.id, founder.plan, 'googlecalendar')).direct).toBe(true);
    // Nothing was made at Composio for anyone.
    expect(composio.state.managedSetups).toEqual([]);
  });

  it('plan limits still come first for a trial user', async () => {
    const founder = await chatUser(); // Free: Outlook is not on the Free list
    settings({ trial: { outlook: 'ac_own_outlook' }, users: founder.email });
    const res = await expectContract<{ error: { code: string } }>(
      'connectApp',
      await call('/v1/apps/outlook/connect', { method: 'POST', token: founder.token }),
      403,
    );
    expect(res.error.code).toBe('plan_limit');
    expect(composio.state.signIns).toEqual([]);
  });
});
