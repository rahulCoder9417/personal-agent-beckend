import { Code, ConnectError } from '@connectrpc/connect';
import { eq } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { sha256Hex } from '../../shared/crypto.ts';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { getActiveUser } from '../auth/users.ts';
import { sandboxRuntime } from './agent-settings.ts';
import { browserWanted } from './browser.ts';
import { sandboxTokens } from './schema.ts';
import { planPriority, SandboxState, vm } from './vm.ts';

/** Supplies what a new container needs from other modules (LiteLLM key, MCP servers, allowlist). */
export interface SandboxConfigProvider {
  litellmKey(userId: string): Promise<string>;
  mcpServers(
    userId: string,
  ): Promise<
    Array<{ id: string; name: string; url: string; authHeaderName: string; authSecret: string }>
  >;
  allowlist(userId: string): Promise<string[]>;
}

let provider: SandboxConfigProvider = {
  litellmKey: async () => '',
  mcpServers: async () => [],
  allowlist: async () => [],
};

export function setSandboxConfigProvider(p: Partial<SandboxConfigProvider>): void {
  provider = { ...provider, ...p };
}

export function sandboxConfig(): SandboxConfigProvider {
  return provider;
}

/** Whether the user's container was created (its record is here). Only reads. */
export async function hasSandbox(userId: string): Promise<boolean> {
  const [existing] = await db()
    .select({ userId: sandboxTokens.userId })
    .from(sandboxTokens)
    .where(eq(sandboxTokens.userId, userId));
  return Boolean(existing);
}

/**
 * Creates the user's container once (vm-manager's CreateSandbox is idempotent per user).
 * `exists`: the caller read `hasSandbox` already and it said yes, so nothing is read again.
 */
export async function ensureSandbox(userId: string, exists = false): Promise<void> {
  if (exists || (await hasSandbox(userId))) return;
  const user = await getActiveUser(userId);
  if (!user) throw new Error(`user ${userId} not found`);
  const res = await vm().createSandbox({
    userId,
    litellmKey: await provider.litellmKey(userId),
    priority: planPriority(user.plan),
    allowlist: await provider.allowlist(userId),
    mcpServers: await provider.mcpServers(userId),
    timezone: user.timezone,
    runtime: await sandboxRuntime(userId),
    // Scout's browser: on for a Max user while the deployed image has it (HLD 11.3).
    browserEnabled: browserWanted(user.plan),
  });
  await db()
    .insert(sandboxTokens)
    .values({ userId, mcpTokenHash: res.mcpTokenHash })
    .onConflictDoUpdate({ target: sandboxTokens.userId, set: { mcpTokenHash: res.mcpTokenHash } });
}

/**
 * Which user a container token belongs to is kept in Redis for 10 minutes (keyed by the token's
 * hash, never the token), so the agent's tool calls don't each wait for the database. It changes
 * only when the user's container record is removed, which drops it.
 */
const TOKEN_OWNER_SECONDS = 600;
const tokenOwnerKey = (hash: string) => `mcp-token:${hash}`;

/** Platform MCP auth: bearer token → user id. The container can't choose or fake it. */
export async function userIdForMcpToken(token: string): Promise<string | null> {
  const hash = sha256Hex(token);
  const known = await redis()
    .get(tokenOwnerKey(hash))
    .catch(() => null);
  if (known) return known;
  const [row] = await db().select().from(sandboxTokens).where(eq(sandboxTokens.mcpTokenHash, hash));
  if (!row) return null;
  await redis()
    .set(tokenOwnerKey(hash), row.userId, 'EX', TOKEN_OWNER_SECONDS)
    .catch(() => {});
  return row.userId;
}

export async function deleteSandboxRecord(userId: string): Promise<void> {
  const gone = await db()
    .delete(sandboxTokens)
    .where(eq(sandboxTokens.userId, userId))
    .returning({ hash: sandboxTokens.mcpTokenHash });
  // Its token stops working at once, not when the copy runs out.
  for (const { hash } of gone)
    await redis()
      .del(tokenOwnerKey(hash))
      .catch((err: unknown) =>
        logger().error({ userId, err: String(err) }, 'container token owner not dropped'),
      );
}

export type AgentState = 'none' | 'stopped' | 'waking' | 'awake' | 'busy' | 'broken';

const STATE_NAMES: Record<SandboxState, AgentState> = {
  [SandboxState.UNSPECIFIED]: 'none',
  [SandboxState.STOPPED]: 'stopped',
  [SandboxState.WAKING]: 'waking',
  [SandboxState.AWAKE]: 'awake',
  [SandboxState.BUSY]: 'busy',
  [SandboxState.BROKEN]: 'broken',
};

/** The vm-manager's state in the api's words. */
export function agentStateOf(state: SandboxState): AgentState {
  return STATE_NAMES[state] ?? 'none';
}

export async function getAgentStatus(
  userId: string,
): Promise<{ state: AgentState; lastActiveAt: Date | null }> {
  try {
    const s = await vm().getSandbox({ userId });
    return {
      state: agentStateOf(s.state),
      lastActiveAt: s.lastActiveAtUnixMs ? new Date(Number(s.lastActiveAtUnixMs)) : null,
    };
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound)
      return { state: 'none', lastActiveAt: null };
    throw err;
  }
}

/**
 * Admin overview: containers waking, awake or busy right now, as the vm-manager counts them. Null
 * when it can't be asked: the overview still shows the rest.
 */
export async function countAwakeContainers(): Promise<number | null> {
  try {
    const { sandboxes } = await vm().listSandboxes({
      states: [SandboxState.WAKING, SandboxState.AWAKE, SandboxState.BUSY],
    });
    return sandboxes.length;
  } catch (err) {
    logger().warn({ err: String(err) }, 'awake containers not counted');
    return null;
  }
}

/** The container's state for the admin's user page; null when the vm-manager can't be asked. */
export async function agentStatusOrNull(
  userId: string,
): Promise<Awaited<ReturnType<typeof getAgentStatus>> | null> {
  try {
    return await getAgentStatus(userId);
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'container state not read');
    return null;
  }
}

/** Activity = every delivered message and every Platform MCP call (HLD 0.6). Best effort. */
export function touch(userId: string): void {
  vm()
    .touch({ userId })
    .catch((err: unknown) => logger().debug({ userId, err: String(err) }, 'touch failed'));
}

/**
 * Asks the vm-manager to stop the user's container now, politely (Hermes saves to the user's
 * folder first), instead of after the 3 idle minutes: after a crew job, whose work is over. The
 * vm-manager refuses a polite stop while a turn runs, a delivery is in flight or a Claude sign-in
 * waits for its code; then the idle stop does it later. Never fails: false when it didn't stop.
 */
export async function sleepNow(userId: string, reason: string): Promise<boolean> {
  try {
    await vm().stopSandbox({ userId, force: false, reason });
    return true;
  } catch (err) {
    logger().info({ userId, reason, err: String(err) }, 'container left to the idle stop');
    return false;
  }
}

/**
 * Asks the vm-manager to stop the user's container now, politely: an admin suspended the account.
 * `none`: the user has no container. `refused`: the vm-manager said no (a turn runs, a delivery is
 * in flight, a Claude sign-in waits) or could not be reached; the idle stop then does it later,
 * and nothing wakes the container while the account is suspended. Never fails.
 */
export async function stopPolitely(
  userId: string,
  reason: string,
): Promise<'stopped' | 'none' | 'refused'> {
  try {
    await vm().stopSandbox({ userId, force: false, reason });
    return 'stopped';
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound) return 'none';
    logger().info({ userId, reason, err: String(err) }, 'container left to the idle stop');
    return 'refused';
  }
}
