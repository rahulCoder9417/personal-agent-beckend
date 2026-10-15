// When a user connects an app again with the same account, the older connection to that account is
// replaced (docs/composio.md, section 9, "Switching an app that people already use"). That is how a
// user moves from Composio's shared sign-in app to our own, and how a connection that expired is
// cleaned up after Reconnect. The system job `settle-connection` runs it when a connection becomes
// active:
//   1. the new connection must still be active;
//   2. the user's older connections of the same app to the same account are found: the same account
//      label (the email Composio gives for the account), in any letter case. A label we don't have
//      is asked of Composio first. With no label on either side nothing is replaced: a second
//      account of the same app ("Add account") must never be removed;
//   3. for each: the user's app-event automations move to the new connection (the automations
//      module), then the old connection is removed at Composio, then here.
// Safe to re-run: a connection already gone is skipped, and moving automations is safe to repeat.
// One run per user at a time (a short lock of its own, not the turn lock).
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { moveAppTriggers } from '../automations/automations.ts';
import { getConnection, listConnections, type Connection } from './apps.ts';
import { findApp } from './catalog.ts';
import { composio } from './composio.ts';
import { connections } from './tables.ts';

export interface SettleResult {
  /** Our ids of the older connections removed. */
  replaced: string[];
  /** App-event automations moved to the new connection. */
  automationsMoved: number;
}

const LOCK_MS = 2 * 60_000;
const lockKey = (userId: string) => `lock:settle-connection:${userId}`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

const sameAccount = (a: string | null, b: string | null) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const olderThan = (a: Connection, b: Connection) =>
  a.createdAt.getTime() < b.createdAt.getTime() ||
  (a.createdAt.getTime() === b.createdAt.getTime() && a.id < b.id);

/** The connection's account label: ours, or asked of Composio and kept. Null when nobody knows. */
async function labelOf(row: Connection): Promise<string | null> {
  if (row.accountLabel) return row.accountLabel;
  const acc = await composio().account(row.composioAccountId);
  if (!acc?.label) return null;
  await db()
    .update(connections)
    .set({ accountLabel: acc.label })
    .where(and(eq(connections.userId, row.userId), eq(connections.id, row.id)));
  return acc.label;
}

/** Removes a connected account at Composio. One Composio no longer has counts as removed. */
async function removeAtComposio(accountId: string): Promise<void> {
  try {
    await composio().deleteAccount(accountId);
  } catch (err) {
    const e = err as { status?: number; code?: string };
    if (e.status === 404 || e.code === 'CONNECTED_ACCOUNT_NOT_FOUND') return;
    throw err;
  }
}

async function settle(userId: string, connectionId: string): Promise<SettleResult | null> {
  const conn = await getConnection(userId, connectionId);
  // Disconnected meanwhile, or not active (any more): nothing to settle.
  if (!conn || conn.status !== 'active') return null;
  const app = findApp(conn.app);
  if (!app) return null;
  const result: SettleResult = { replaced: [], automationsMoved: 0 };
  const label = await labelOf(conn);
  if (!label) {
    logger().info({ userId, app: conn.app }, 'no account label: older connections are kept');
    return result;
  }
  const older = (await listConnections(userId)).filter(
    (c) => c.app === conn.app && c.id !== conn.id && c.status !== 'pending' && olderThan(c, conn),
  );
  for (const old of older) {
    if (!sameAccount(await labelOf(old), label)) continue;
    result.automationsMoved += await moveAppTriggers({
      userId,
      toolkit: app.toolkit,
      from: old.composioAccountId,
      to: conn.composioAccountId,
    });
    await removeAtComposio(old.composioAccountId);
    await db()
      .delete(connections)
      .where(and(eq(connections.userId, userId), eq(connections.id, old.id)));
    result.replaced.push(old.id);
  }
  if (result.replaced.length)
    logger().info(
      { userId, app: conn.app, connectionId, ...result },
      'older connection to the same account replaced',
    );
  return result;
}

/**
 * Replaces the user's older connections of this connection's app to the same account (see the top
 * of this file). Null: the connection is gone or not active. Throws when another run for the same
 * user holds the lock, or when Composio fails, so the job is tried again.
 */
export async function settleConnection(
  userId: string,
  connectionId: string,
): Promise<SettleResult | null> {
  const token = randomUUID();
  if ((await redis().set(lockKey(userId), token, 'PX', LOCK_MS, 'NX')) !== 'OK')
    throw new Error('another connection of this user is being settled; tried again shortly');
  try {
    return await settle(userId, connectionId);
  } finally {
    await redis().eval(RELEASE, 1, lockKey(userId), token);
  }
}
