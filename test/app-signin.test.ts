// Connecting an app (docs/backend-report.md, "Apps through Composio"; docs/composio.md):
// - the catalog says who signs the user in and what Tex can do with each app.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeQueues } from '../src/modules/events/queues.ts';
import { CATALOG, findApp } from '../src/modules/integrations/catalog.ts';
import { resetConfig } from '../src/shared/config.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakeComposio, installFakeVm } from './fakes.ts';
import { call, chatUser, expectContract } from './helpers.ts';

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
  await installFakeComposio();
  settings({ configs: { gmail: 'ac_gmail', github: 'ac_own_github' } });
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
