import { and, eq } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { db } from '../../shared/db/client.ts';
import { notFound, planLimit, unavailable } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import type { PlanId } from '../auth/users.ts';
import { addJob } from '../events/queues.ts';
import {
  actionChangesSomething,
  actionKindByName,
  appAllowedOnPlan,
  appForToolkit,
  CATALOG,
  findApp,
  type CatalogApp,
} from './catalog.ts';
import {
  authConfigFor,
  authConfigInfo,
  composio,
  rememberAuthConfig,
  toolTags,
  type AuthConfigInfo,
} from './composio.ts';
import { composioAuthConfigs, connections } from './tables.ts';

export type Connection = typeof connections.$inferSelect;

export async function listConnections(userId: string): Promise<Connection[]> {
  return db().select().from(connections).where(eq(connections.userId, userId));
}

export async function activeConnections(
  userId: string,
): Promise<Array<Connection & { catalog: CatalogApp }>> {
  const rows = await listConnections(userId);
  return rows
    .filter((c) => c.status === 'active')
    .map((c) => ({ ...c, catalog: findApp(c.app)! }))
    .filter((c) => c.catalog);
}

export async function getConnection(
  userId: string,
  connectionId: string,
): Promise<Connection | undefined> {
  const [row] = await db()
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.id, connectionId)));
  return row;
}

/**
 * Waits before each check of a pending connection (HLD 5.2 check-connection): 15 s after the
 * connect link is made, then 30 s, 1, 2, 4 and 8 minutes after the check before. Six checks in
 * about 16 minutes; signing in on the provider's page rarely takes longer.
 */
export const CONNECTION_CHECK_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 240_000, 480_000];

/**
 * Queues check number `attempt` of one connect attempt (`run`). The job id makes it safe to add
 * twice. Returns false when the checks are used up.
 */
export async function scheduleConnectionCheck(input: {
  userId: string;
  connectionId: string;
  run: number;
  attempt: number;
}): Promise<boolean> {
  const delay = CONNECTION_CHECK_DELAYS_MS[input.attempt];
  if (delay === undefined) return false;
  await addJob('system', 'check-connection', input, {
    jobId: `conn-check-${input.connectionId}-${input.run}-${input.attempt}`,
    delay,
  });
  return true;
}

/** Our status for an account Composio describes, or null while it is not finished there. */
export function statusFromComposio(composioStatus: string): Connection['status'] | null {
  if (composioStatus === 'ACTIVE') return 'active';
  if (composioStatus === 'EXPIRED') return 'expired';
  if (composioStatus === 'FAILED') return 'error';
  return null;
}

/** At most this many pending connections of a user are asked about at once: the newest ones. */
export const REFRESH_AT_MOST = 10;

/**
 * Pending connections finish on the provider's page; this copies their status from Composio.
 * Used when the apps are listed (by the web app or by the agent's tools) and by the
 * check-connection job. Safe to repeat.
 *
 * Composio is asked about each pending connection's own account, by its id. Not the user's whole
 * list of accounts: Composio answers that in pages, so a user with many accounts (other apps, old
 * attempts) could have the new one on a later page, and it would stay pending for good.
 */
export async function refreshPendingConnections(userId: string): Promise<void> {
  const pending = (await listConnections(userId))
    .filter((r) => r.status === 'pending')
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, REFRESH_AT_MOST);
  await Promise.all(
    pending.map(async (row) => {
      try {
        const acc = await composio().account(row.composioAccountId);
        const status = acc ? statusFromComposio(acc.status) : null;
        if (!acc || !status) return;
        await db()
          .update(connections)
          .set({ status, accountLabel: acc.label ?? row.accountLabel })
          .where(
            and(
              eq(connections.userId, userId),
              eq(connections.id, row.id),
              eq(connections.status, 'pending'),
            ),
          );
      } catch (err) {
        logger().warn(
          { userId, connectionId: row.id, err: String(err) },
          'composio refresh failed',
        );
      }
    }),
  );
}

/** The web app's Apps page, where the user connects apps. */
export function appsPageUrl(): string {
  return `${config().WEB_APP_URL.replace(/\/+$/, '')}/apps`;
}

// --- Which apps can be connected here, and with which Composio setup ---------------------------
//
// An app's setup (Composio's "auth config") is, in this order:
//   1. the one named for it in COMPOSIO_AUTH_CONFIGS (for example our own GitHub sign-in app);
//   2. one the server made itself earlier, kept in `composio_auth_configs`;
//   3. one the server makes now, on the first connect, with Composio's shared sign-in, when the
//      app is named in COMPOSIO_MANAGED_APPS (or that setting is `all`) and Composio has a shared
//      sign-in for it.
// No setup and none allowed: the app is listed but can't be connected ("Not available yet").

/** May the server make this app's setup itself (COMPOSIO_MANAGED_APPS)? */
export function serverMaySetUp(app: CatalogApp): boolean {
  if (!app.managedAuth) return false;
  const allowed = config().COMPOSIO_MANAGED_APPS;
  return allowed === 'all' || allowed.includes(app.slug);
}

/**
 * The setup an app connects with today, without making one: from COMPOSIO_AUTH_CONFIGS, or one
 * the server made itself. For the dev-user script's `apps` command.
 */
export async function currentSetupFor(
  appSlug: string,
): Promise<{ id: string; source: 'COMPOSIO_AUTH_CONFIGS' | 'made by the server' } | null> {
  const named = authConfigFor(appSlug);
  if (named) return { id: named, source: 'COMPOSIO_AUTH_CONFIGS' };
  const stored = (await storedAuthConfigs()).get(appSlug);
  return stored ? { id: stored, source: 'made by the server' } : null;
}

/** Setups the server made itself, by app slug. */
async function storedAuthConfigs(): Promise<Map<string, string>> {
  const rows = await db().select().from(composioAuthConfigs);
  return new Map(rows.map((r) => [r.app, r.authConfigId]));
}

/** The name of a setup the server makes. It shows only in Composio's dashboard. */
const setupName = (app: CatalogApp) => `Textcrew ${app.name}`;

/**
 * The setup to connect an app with (the order above). Makes it when the server may.
 * Undefined: the app can't be connected on this server.
 */
async function authConfigToConnect(app: CatalogApp): Promise<string | undefined> {
  const named = authConfigFor(app.slug);
  if (named) return named;
  const [row] = await db()
    .select()
    .from(composioAuthConfigs)
    .where(eq(composioAuthConfigs.app, app.slug));
  if (row) return row.authConfigId;
  if (!serverMaySetUp(app)) return undefined;

  let made: { id: string };
  try {
    made = await composio().setUpManagedAuthConfig(app.toolkit, setupName(app));
  } catch (err) {
    logger().warn({ app: app.slug, err: String(err) }, 'composio setup failed');
    throw unavailable(`${app.name} can't be connected right now. Try again in a few minutes.`);
  }
  rememberAuthConfig(made.id, { composioManaged: true, authScheme: null });
  // Two first connects at the same moment can each make one. The first one saved is used by
  // everyone; the other stays unused at Composio, with no connections on it.
  await db()
    .insert(composioAuthConfigs)
    .values({ app: app.slug, authConfigId: made.id })
    .onConflictDoNothing({ target: composioAuthConfigs.app });
  const [saved] = await db()
    .select()
    .from(composioAuthConfigs)
    .where(eq(composioAuthConfigs.app, app.slug));
  return saved?.authConfigId ?? made.id;
}

/**
 * How the sign-in starts for a setup:
 * - `direct`: our own sign-in app at the provider (a custom setup, OAuth). The link is the
 *   provider's own page: no Composio page, no Composio address on the way out.
 * - `link`: a Composio Connect Link. Composio's page comes first (its logo and name can be ours,
 *   in Composio's dashboard), then the provider's. The only way for Composio's shared sign-in,
 *   and for a setup that asks for an API key. Also used when Composio can't say which kind it is.
 */
export function signInPath(
  info: AuthConfigInfo | null,
): { kind: 'direct'; authScheme: 'OAUTH2' | 'OAUTH1' } | { kind: 'link' } {
  if (!info || info.composioManaged) return { kind: 'link' };
  if (info.authScheme === 'OAUTH2' || info.authScheme === 'OAUTH1')
    return { kind: 'direct', authScheme: info.authScheme };
  return { kind: 'link' };
}

/**
 * The page to come back to after the sign-in. Only a page of our own web app: anything else
 * (another site, or one whose address only starts the same way) gets the Apps page.
 */
export function connectReturnUrl(appSlug: string, returnUrl?: string): string {
  const web = config().WEB_APP_URL;
  const fallback = `${appsPageUrl()}?connected=${encodeURIComponent(appSlug)}`;
  if (!returnUrl) return fallback;
  try {
    return new URL(returnUrl).origin === new URL(web).origin ? returnUrl : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The catalog for one user. `connectable`: this server can connect the app (it has a setup for
 * it, or may make one: see above). Without that the app is listed but `startConnect` answers 404
 * for it, so the web app shows "Not available yet" instead of a Connect button.
 */
export async function appCatalogFor(userId: string, plan: PlanId) {
  await refreshPendingConnections(userId);
  const [rows, stored] = await Promise.all([listConnections(userId), storedAuthConfigs()]);
  return CATALOG.map((app) => ({
    slug: app.slug,
    name: app.name,
    provider: app.provider,
    description: app.description,
    iconUrl: null,
    category: app.category,
    availableOnPlan: appAllowedOnPlan(app, plan),
    connectable: Boolean(authConfigFor(app.slug) ?? stored.get(app.slug)) || serverMaySetUp(app),
    connections: rows
      .filter((r) => r.app === app.slug && r.status !== 'pending')
      .map((r) => ({
        id: r.id,
        accountLabel: r.accountLabel,
        status: r.status as 'active' | 'expired' | 'error',
      })),
  }));
}

/** Asks Composio for the sign-in link, the direct way when the setup allows it. */
async function openSignIn(
  app: CatalogApp,
  userId: string,
  authConfigId: string,
  callbackUrl: string,
): Promise<{ accountId: string; redirectUrl: string; direct: boolean }> {
  const path = signInPath(await authConfigInfo(authConfigId));
  if (path.kind === 'direct') {
    try {
      const r = await composio().connectDirect(userId, authConfigId, path.authScheme, callbackUrl);
      if (r.redirectUrl) return { ...r, direct: true };
    } catch (err) {
      // A Connect Link works for every setup, so the user can still connect.
      logger().warn({ app: app.slug, err: String(err) }, 'composio direct connect failed');
    }
  }
  try {
    const r = await composio().connectLink(userId, authConfigId, callbackUrl);
    if (r.redirectUrl) return { ...r, direct: false };
    logger().warn({ app: app.slug }, 'composio gave no connect link');
  } catch (err) {
    logger().warn({ app: app.slug, err: String(err) }, 'composio connect link failed');
  }
  throw unavailable(`${app.name} can't be connected right now. Try again in a few minutes.`);
}

/**
 * Starts connecting an app; returns the sign-in page to send the browser to, and whether it is
 * the provider's own page (`direct`) or Composio's connect page first. Plan limits apply.
 */
export async function startConnect(
  userId: string,
  plan: PlanId,
  appSlug: string,
  returnUrl?: string,
): Promise<{ redirectUrl: string; direct: boolean }> {
  const app = findApp(appSlug);
  if (!app) throw notFound('Unknown app');
  if (!appAllowedOnPlan(app, plan))
    throw planLimit(`${app.name} isn't available on the ${plan} plan`, { app: app.slug, plan });
  const authConfigId = await authConfigToConnect(app);
  if (!authConfigId) throw notFound(`${app.name} isn't configured yet`);
  const callback = connectReturnUrl(app.slug, returnUrl);
  const { accountId, redirectUrl, direct } = await openSignIn(app, userId, authConfigId, callback);
  await db()
    .insert(connections)
    .values({
      id: newId('con'),
      userId,
      app: app.slug,
      composioAccountId: accountId,
      status: 'pending',
    })
    .onConflictDoNothing({ target: connections.composioAccountId });
  // The server finishes the job itself: without this, a connection made with no webhook and no
  // web app listing the apps would stay pending forever.
  const [row] = await db()
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.composioAccountId, accountId)));
  if (row) {
    await scheduleConnectionCheck({
      userId,
      connectionId: row.id,
      run: Date.now(),
      attempt: 0,
    }).catch((err: unknown) =>
      // The link is already made; the webhook or the app list can still finish the connection.
      logger().warn({ userId, err: String(err) }, 'could not queue the connection check'),
    );
  }
  return { redirectUrl, direct };
}

export async function disconnect(userId: string, connectionId: string): Promise<boolean> {
  const [row] = await db()
    .select()
    .from(connections)
    .where(and(eq(connections.userId, userId), eq(connections.id, connectionId)));
  if (!row) return false;
  await composio()
    .deleteAccount(row.composioAccountId)
    .catch((err: unknown) => logger().warn({ err: String(err) }, 'composio delete failed'));
  await db().delete(connections).where(eq(connections.id, row.id));
  return true;
}

/** Composio webhook: connection status changed. */
export async function setConnectionStatus(
  accountId: string,
  status: Connection['status'],
): Promise<void> {
  await db()
    .update(connections)
    .set({ status })
    .where(eq(connections.composioAccountId, accountId));
}

/** The user's active connection for a toolkit, if any. */
export async function connectionForToolkit(
  userId: string,
  toolkit: string,
): Promise<Connection | undefined> {
  const app = appForToolkit(toolkit);
  if (!app) return undefined;
  const [row] = await db()
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.userId, userId),
        eq(connections.app, app.slug),
        eq(connections.status, 'active'),
      ),
    );
  return row;
}

/**
 * Does running this action change something (HLD 7.2: 1 credit if so, reading is free)?
 * The name decides. Composio is only asked for its tags when the name says nothing; if it can't
 * be asked, the action counts as changing something.
 */
export async function appActionChangesSomething(actionSlug: string): Promise<boolean> {
  if (actionKindByName(actionSlug) !== 'unknown') return actionChangesSomething(actionSlug);
  return actionChangesSomething(actionSlug, (await toolTags(actionSlug)) ?? []);
}

export async function deleteUserConnections(userId: string): Promise<void> {
  const rows = await listConnections(userId);
  for (const r of rows)
    await composio()
      .deleteAccount(r.composioAccountId)
      .catch(() => {});
  await db().delete(connections).where(eq(connections.userId, userId));
}
