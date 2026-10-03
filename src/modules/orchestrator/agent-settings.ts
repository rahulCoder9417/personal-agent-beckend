// Which agent runs for a user (Hermes or Claude Code) and what pays for its AI.
// We store only the choice and WHEN a Claude plan was connected: never a Claude credential.
import { Code, ConnectError } from '@connectrpc/connect';
import { eq } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { db, type Tx } from '../../shared/db/client.ts';
import { conflict } from '../../shared/errors.ts';
import { logger } from '../../shared/logger.ts';
import { audit } from '../admin/audit.ts';
import { hasByokKey, listByokKeys, type ByokProvider } from '../integrations/byok.ts';
import { agentSettings } from './schema.ts';
import { AgentRuntime, vm } from './vm.ts';

export type RuntimeName = (typeof agentSettings.$inferSelect)['runtime'];
export type AiPreference = (typeof agentSettings.$inferSelect)['aiPreference'];
export type AiAccess = 'claude_plan' | 'own_key' | 'platform' | 'none';
export type AiAccessMode = 'platform' | 'own_only';

export interface AgentSettingsView {
  /** What the user chose. */
  runtime: RuntimeName;
  /** What actually runs (null: no AI source, nothing runs). */
  effectiveRuntime: RuntimeName | null;
  aiAccess: AiAccess;
  /** `platform`: the user chose Textcrew AI over their own AI. Ignored when it isn't on offer. */
  aiPreference: AiPreference;
  /** Textcrew AI is on offer (`AI_ACCESS_MODE=platform`). */
  platformAvailable: boolean;
  claude: { connected: boolean; connectedAt: Date | null };
  ownKeyProviders: ByokProvider[];
}

/**
 * The rule, in order:
 * 0. `platform` mode + the user chose Textcrew AI → Hermes on platform credits, whatever else
 *    they have (HLD 7.1). In `own_only` mode that choice is ignored.
 * 1. a connected Claude plan + chose Claude Code → Claude Code, paid by the Claude plan
 * 2. an own API key → Hermes, paid by the key
 * 3. `platform` mode → Hermes on platform credits
 * 4. `own_only` mode with a connected Claude plan (but Hermes chosen and no key) → Claude Code,
 *    because the plan is the user's only AI source
 * 5. otherwise nothing runs (`none`)
 */
export function decideAccess(input: {
  runtime: RuntimeName;
  claudeConnected: boolean;
  hasOwnKey: boolean;
  mode: AiAccessMode;
  preferPlatform?: boolean;
}): { effectiveRuntime: RuntimeName | null; aiAccess: AiAccess } {
  if (input.mode === 'platform' && input.preferPlatform)
    return { effectiveRuntime: 'hermes', aiAccess: 'platform' };
  if (input.claudeConnected && input.runtime === 'claude_code')
    return { effectiveRuntime: 'claude_code', aiAccess: 'claude_plan' };
  if (input.hasOwnKey) return { effectiveRuntime: 'hermes', aiAccess: 'own_key' };
  if (input.mode === 'platform') return { effectiveRuntime: 'hermes', aiAccess: 'platform' };
  if (input.claudeConnected) return { effectiveRuntime: 'claude_code', aiAccess: 'claude_plan' };
  return { effectiveRuntime: null, aiAccess: 'none' };
}

async function settingsRow(userId: string) {
  const [row] = await db().select().from(agentSettings).where(eq(agentSettings.userId, userId));
  return row;
}

export async function getAgentSettings(userId: string): Promise<AgentSettingsView> {
  const [row, keys] = await Promise.all([settingsRow(userId), listByokKeys(userId)]);
  const ownKeyProviders = keys.filter((k) => k.set).map((k) => k.provider);
  const runtime = row?.runtime ?? 'hermes';
  const connectedAt = row?.claudeConnectedAt ?? null;
  const aiPreference = row?.aiPreference ?? 'auto';
  const mode = config().AI_ACCESS_MODE;
  return {
    runtime,
    ...decideAccess({
      runtime,
      claudeConnected: connectedAt !== null,
      hasOwnKey: ownKeyProviders.length > 0,
      mode,
      preferPlatform: aiPreference === 'platform',
    }),
    aiPreference,
    platformAvailable: mode === 'platform',
    claude: { connected: connectedAt !== null, connectedAt },
    ownKeyProviders,
  };
}

/**
 * Does the user's own API key pay for the AI? Billing asks this: with a key the AI isn't charged
 * in credits (HLD 7.1), unless the user chose Textcrew AI while it is on offer.
 */
export async function ownKeyPaysForAi(userId: string, tx: Tx = db()): Promise<boolean> {
  if (!(await hasByokKey(userId, tx))) return false;
  if (config().AI_ACCESS_MODE !== 'platform') return true;
  const [row] = await tx
    .select({ aiPreference: agentSettings.aiPreference })
    .from(agentSettings)
    .where(eq(agentSettings.userId, userId));
  return row?.aiPreference !== 'platform';
}

async function saveSettings(
  userId: string,
  values: { runtime?: RuntimeName; aiPreference?: AiPreference; claudeConnectedAt?: Date | null },
): Promise<void> {
  const set = { ...values, updatedAt: new Date() };
  await db()
    .insert(agentSettings)
    .values({ userId, ...set })
    .onConflictDoUpdate({ target: agentSettings.userId, set });
}

/** The vm-manager's runtime for what should run (nothing runs → Hermes; it isn't woken anyway). */
export function toVmRuntime(runtime: RuntimeName | null): AgentRuntime {
  return runtime === 'claude_code' ? AgentRuntime.CLAUDE_CODE : AgentRuntime.HERMES;
}

/** UNSPECIFIED means Hermes on the vm-manager side. */
export function sameVmRuntime(a: AgentRuntime | undefined, b: AgentRuntime): boolean {
  const norm = (r: AgentRuntime | undefined) =>
    r === AgentRuntime.CLAUDE_CODE ? AgentRuntime.CLAUDE_CODE : AgentRuntime.HERMES;
  return norm(a) === norm(b);
}

/** The runtime a new container is created with. */
export async function sandboxRuntime(userId: string): Promise<AgentRuntime> {
  return toVmRuntime((await getAgentSettings(userId)).effectiveRuntime);
}

/**
 * Tells the vm-manager which agent to run (applied on the next delivery). Best effort: no
 * container yet → it is created with the right runtime; vm-manager down → the next turn re-syncs
 * after WakeSandbox (see `syncRuntimeAfterWake`).
 */
export async function pushRuntime(userId: string, settings?: AgentSettingsView): Promise<void> {
  const s = settings ?? (await getAgentSettings(userId));
  try {
    await vm().setAgentRuntime({ userId, runtime: toVmRuntime(s.effectiveRuntime) });
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound) return;
    logger().warn({ userId, err: String(err) }, 'setAgentRuntime failed; next turn re-syncs');
  }
}

/** After WakeSandbox: if the container runs another agent than it should, switch it. */
export async function syncRuntimeAfterWake(
  userId: string,
  sandbox: { runtime?: AgentRuntime } | undefined,
): Promise<void> {
  if (!sandbox) return;
  const settings = await getAgentSettings(userId);
  if (sameVmRuntime(sandbox.runtime, toVmRuntime(settings.effectiveRuntime))) return;
  await pushRuntime(userId, settings);
}

/**
 * PATCH /v1/agent/settings: the runtime, the AI preference, or both. Claude Code needs a connected
 * Claude plan, and Textcrew AI can only be chosen while it is on offer (409 otherwise).
 */
export async function updateAgentSettings(
  userId: string,
  patch: { runtime?: RuntimeName; aiPreference?: AiPreference },
): Promise<AgentSettingsView> {
  const current = await getAgentSettings(userId);
  if (patch.runtime === 'claude_code' && !current.claude.connected)
    throw conflict('Connect your Claude plan first');
  if (patch.aiPreference === 'platform' && !current.platformAvailable)
    throw conflict("Textcrew AI isn't on offer here. Use your own API key or your Claude plan");
  const runtime = patch.runtime !== undefined && patch.runtime !== current.runtime;
  const preference =
    patch.aiPreference !== undefined && patch.aiPreference !== current.aiPreference;
  if (runtime || preference) {
    await saveSettings(userId, {
      ...(runtime ? { runtime: patch.runtime } : {}),
      ...(preference ? { aiPreference: patch.aiPreference } : {}),
    });
  }
  if (runtime) {
    await audit({
      userId,
      actor: 'user',
      action: 'agent_runtime_changed',
      summary: `Agent switched to ${patch.runtime === 'claude_code' ? 'Claude Code' : 'Hermes'}`,
    });
  }
  if (preference) {
    await audit({
      userId,
      actor: 'user',
      action: 'ai_preference_changed',
      summary:
        patch.aiPreference === 'platform'
          ? 'Chose Textcrew AI (paid in credits)'
          : 'Went back to their own AI',
    });
  }
  const settings = await getAgentSettings(userId);
  await pushRuntime(userId, settings);
  return settings;
}

/**
 * The in-container sign-in succeeded: Claude Code becomes the user's agent. They have just chosen
 * their Claude plan, so an earlier choice of Textcrew AI is dropped.
 */
export async function markClaudeConnected(userId: string): Promise<AgentSettingsView> {
  await saveSettings(userId, {
    runtime: 'claude_code',
    aiPreference: 'auto',
    claudeConnectedAt: new Date(),
  });
  const settings = await getAgentSettings(userId);
  await pushRuntime(userId, settings);
  return settings;
}

/** The Claude plan is gone (disconnected, or its sign-in stopped working): back to Hermes. */
export async function markClaudeDisconnected(userId: string): Promise<AgentSettingsView> {
  await saveSettings(userId, { runtime: 'hermes', claudeConnectedAt: null });
  const settings = await getAgentSettings(userId);
  await pushRuntime(userId, settings);
  return settings;
}

/**
 * After a failed turn: if this user runs Claude Code and the vm-manager now reports its sign-in
 * as gone (e.g. "Connect your Claude plan again"), forget the connection so the next turn runs
 * Hermes. Returns true when it switched.
 */
export async function fallBackIfClaudeSignedOut(userId: string): Promise<boolean> {
  const settings = await getAgentSettings(userId);
  if (settings.effectiveRuntime !== 'claude_code') return false;
  let connected: boolean;
  try {
    connected = (await vm().getSandbox({ userId })).claudeConnected;
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'getSandbox failed; Claude check skipped');
    return false;
  }
  if (connected) return false;
  await markClaudeDisconnected(userId);
  await audit({
    userId,
    actor: 'system',
    action: 'claude_disconnected',
    summary: 'Claude plan sign-in stopped working; switched back to Hermes',
  });
  return true;
}

/** Account deletion. */
export async function deleteAgentSettings(userId: string): Promise<void> {
  await db().delete(agentSettings).where(eq(agentSettings.userId, userId));
}
