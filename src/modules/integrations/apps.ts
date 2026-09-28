import { and, eq } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { db } from '../../shared/db/client.ts';
import { notFound, planLimit } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import type { PlanId } from '../auth/users.ts';
import { appAllowedOnPlan, appForToolkit, CATALOG, findApp, type CatalogApp } from './catalog.ts';
import { authConfigFor, composio } from './composio.ts';
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

/** Pending connections finish on the provider's page; refresh them from Composio when listing. */
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

export async function deleteUserConnections(userId: string): Promise<void> {
  const rows = await listConnections(userId);
  for (const r of rows)
    await composio()
      .deleteAccount(r.composioAccountId)
      .catch(() => {});
  await db().delete(connections).where(eq(connections.userId, userId));
}
