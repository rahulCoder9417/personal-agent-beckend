import { and, eq } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { db } from '../../shared/db/client.ts';
import { notFound, planLimit } from '../../shared/errors.ts';
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
import { authConfigFor, composio, toolTags } from './composio.ts';
import { connections } from './tables.ts';

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

/**
 * Pending connections finish on the provider's page; this copies their status from Composio.
 * Used when the apps are listed and by the check-connection job. Safe to repeat.
 */
export async function refreshPendingConnections(userId: string): Promise<void> {
  const rows = await listConnections(userId);
  if (!rows.some((r) => r.status === 'pending')) return;
  try {
    const accounts = await composio().listAccounts(userId);
    for (const acc of accounts) {
      const status =
        acc.status === 'ACTIVE'
          ? 'active'
          : acc.status === 'EXPIRED'
            ? 'expired'
            : acc.status === 'FAILED'
              ? 'error'
              : null;
      if (!status) continue;
      await db()
        .update(connections)
        .set({ status, accountLabel: acc.label })
        .where(and(eq(connections.userId, userId), eq(connections.composioAccountId, acc.id)));
    }
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'composio refresh failed');
  }
}

export async function appCatalogFor(userId: string, plan: PlanId) {
  await refreshPendingConnections(userId);
  const rows = await listConnections(userId);
  return CATALOG.map((app) => ({
    slug: app.slug,
    name: app.name,
    iconUrl: null,
    category: app.category,
    availableOnPlan: appAllowedOnPlan(app, plan),
    connections: rows
      .filter((r) => r.app === app.slug && r.status !== 'pending')
      .map((r) => ({
        id: r.id,
        accountLabel: r.accountLabel,
        status: r.status as 'active' | 'expired' | 'error',
      })),
  }));
}

/** Starts connecting an app; returns the provider login URL. Plan limits apply. */
export async function startConnect(
  userId: string,
  plan: PlanId,
  appSlug: string,
  returnUrl?: string,
): Promise<string> {
  const app = findApp(appSlug);
  if (!app) throw notFound('Unknown app');
  if (!appAllowedOnPlan(app, plan))
    throw planLimit(`${app.name} isn't available on the ${plan} plan`, { app: app.slug, plan });
  const authConfigId = authConfigFor(app.slug);
  if (!authConfigId) throw notFound(`${app.name} isn't configured yet`);
  const web = config().WEB_APP_URL;
  const callback =
    returnUrl && returnUrl.startsWith(web) ? returnUrl : `${web}/apps?connected=${app.slug}`;
  const { accountId, redirectUrl } = await composio().connectLink(userId, authConfigId, callback);
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
  return redirectUrl;
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
