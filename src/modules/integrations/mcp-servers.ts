import { isIP } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret } from '../../shared/crypto.ts';
import { db } from '../../shared/db/client.ts';
import { badRequest, planLimit } from '../../shared/errors.ts';
import { newId } from '../../shared/ids.ts';
import type { PlanId } from '../auth/users.ts';
import { addJob } from '../events/queues.ts';
import { userMcpServers } from './tables.ts';

export type McpServerRow = typeof userMcpServers.$inferSelect;

export function toApiMcpServer(s: McpServerRow) {
  return {
    id: s.id,
    name: s.name,
    url: s.url,
    enabled: s.enabled,
    hasSecret: Boolean(s.authSecret),
    lastError: s.lastError,
    createdAt: s.createdAt.toISOString(),
  };
}

const BLOCKED_HOSTS =
  /^(localhost|.*\.local|.*\.internal|.*\.localhost|api|litellm|postgres|redis|vm-manager|egress-proxy|caddy)$/i;

/** A host name that can't be a public site: one of ours, a local one, or one with no dot. */
export function isInternalHostName(host: string): boolean {
  return BLOCKED_HOSTS.test(host) || !host.includes('.');
}

/** Only public https hosts; never our own services or private addresses. */
export function validateMcpUrl(raw: string): { url: string; domain: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw badRequest('Invalid URL');
  }
  if (u.protocol !== 'https:') throw badRequest('The MCP server URL must use https');
  const host = u.hostname.toLowerCase();
  if (isIP(host) || isInternalHostName(host)) throw badRequest('This host is not allowed');
  if (u.username || u.password) throw badRequest('Put credentials in the auth secret, not the URL');
  return { url: u.toString(), domain: host };
}

export async function listMcpServers(userId: string): Promise<McpServerRow[]> {
  return db().select().from(userMcpServers).where(eq(userMcpServers.userId, userId));
}

export function assertOwnMcpAllowed(plan: PlanId): void {
  if (plan !== 'max') throw planLimit('Your own MCP servers need the Max plan', { plan });
}

/** Egress allowlist + Hermes config changed → push to the vm-manager (system job). */
export async function queueAllowlistSync(userId: string): Promise<void> {
  await addJob(
    'system',
    'sync-allowlist',
    { userId },
    { jobId: `allowlist-${userId}-${Date.now()}` },
  );
}

export async function createMcpServer(
  userId: string,
  plan: PlanId,
  input: { name: string; url: string; authHeaderName?: string; authSecret?: string },
): Promise<McpServerRow> {
  assertOwnMcpAllowed(plan);
  const { url, domain } = validateMcpUrl(input.url);
  const [row] = await db()
    .insert(userMcpServers)
    .values({
      id: newId('mcp'),
      userId,
      name: input.name,
      url,
      domain,
      authHeaderName: input.authSecret ? (input.authHeaderName ?? 'Authorization') : null,
      authSecret: input.authSecret ? encryptSecret(input.authSecret) : null,
    })
    .returning();
  await queueAllowlistSync(userId);
  return row!;
}

export async function updateMcpServer(
  userId: string,
  id: string,
  patch: { name?: string; enabled?: boolean },
) {
  const [row] = await db()
    .update(userMcpServers)
    .set(patch)
    .where(and(eq(userMcpServers.userId, userId), eq(userMcpServers.id, id)))
    .returning();
  if (row && patch.enabled !== undefined) await queueAllowlistSync(userId);
  return row;
}

export async function deleteMcpServer(userId: string, id: string): Promise<boolean> {
  const rows = await db()
    .delete(userMcpServers)
    .where(and(eq(userMcpServers.userId, userId), eq(userMcpServers.id, id)))
    .returning({ id: userMcpServers.id });
  if (rows.length) await queueAllowlistSync(userId);
  return rows.length > 0;
}

/** What the container gets: enabled servers (secret decrypted just for the gRPC call) + domains. */
export async function sandboxMcpConfig(userId: string) {
  const rows = (await listMcpServers(userId)).filter((s) => s.enabled);
  return {
    domains: [...new Set(rows.map((r) => r.domain))],
    servers: rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      authHeaderName: r.authHeaderName ?? '',
      authSecret: r.authSecret ? decryptSecret(r.authSecret) : '',
    })),
  };
}

export async function deleteUserMcpServers(userId: string): Promise<void> {
  await db().delete(userMcpServers).where(eq(userMcpServers.userId, userId));
}
