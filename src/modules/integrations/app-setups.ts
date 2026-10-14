// Which apps of the catalog this server can connect, and with which Composio setup, for the
// admins' settings page. The same order as `appCatalogFor` in apps.ts: COMPOSIO_AUTH_CONFIGS, then
// a setup the server made itself, then one it may make on the first connect. Never a setup id.
import { db } from '../../shared/db/client.ts';
import { serverMaySetUp } from './apps.ts';
import { CATALOG } from './catalog.ts';
import { authConfigFor } from './composio.ts';
import { composioAuthConfigs } from './tables.ts';

export type AppSetup = 'settings' | 'made_by_server' | 'server_may_make' | 'none';

export interface AppSetupRow {
  slug: string;
  name: string;
  connectable: boolean;
  setup: AppSetup;
}

export async function appSetups(): Promise<AppSetupRow[]> {
  const made = new Set(
    (await db().select({ app: composioAuthConfigs.app }).from(composioAuthConfigs)).map(
      (r) => r.app,
    ),
  );
  return CATALOG.map((app) => {
    const setup: AppSetup = authConfigFor(app.slug)
      ? 'settings'
      : made.has(app.slug)
        ? 'made_by_server'
        : serverMaySetUp(app)
          ? 'server_may_make'
          : 'none';
    return { slug: app.slug, name: app.name, connectable: setup !== 'none', setup };
  });
}
