// Which agent runs for a user (Hermes or Claude Code) and what pays for its AI.
// We store only the choice and WHEN a Claude plan was connected: never a Claude credential.
import { Code, ConnectError } from '@connectrpc/connect';
import { eq } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { db, type Tx } from '../../shared/db/client.ts';
import { badRequest, conflict } from '../../shared/errors.ts';
import { logger } from '../../shared/logger.ts';
import { audit } from '../admin/audit.ts';
import { hasByokKey, listByokKeys, type ByokProvider } from '../integrations/byok.ts';
import { agentSettings, CLAUDE_EFFORTS } from './schema.ts';
import { AgentRuntime, vm } from './vm.ts';

export type RuntimeName = (typeof agentSettings.$inferSelect)['runtime'];
export type AiPreference = (typeof agentSettings.$inferSelect)['aiPreference'];
export type AiAccess = 'claude_plan' | 'own_key' | 'platform' | 'none';
export type AiAccessMode = 'platform' | 'own_only';
export type ClaudeEffort = (typeof CLAUDE_EFFORTS)[number];
export { CLAUDE_EFFORTS };

export type ClaudeModelGroup = 'current' | 'older';

export interface ClaudeModel {
  /** The full model name Claude Code's `--model` flag takes. */
  id: string;
  label: string;
  /** `current`: Claude's newest models. `older`: earlier models Claude still offers. */
  group: ClaudeModelGroup;
  /** The effort levels the model takes, lowest first. Empty: no effort setting at all. */
  efforts: readonly ClaudeEffort[];
  /** A short word worth showing next to the model. */
  note?: string;
}

const ALL_EFFORTS = CLAUDE_EFFORTS;
/** Opus 4.6 and Sonnet 4.6: no `xhigh` (it came with Opus 4.7). */
const NO_XHIGH = ['low', 'medium', 'high', 'max'] as const satisfies readonly ClaudeEffort[];
const FABLE_NOTE =
  'Pro: paid with usage credits. Max: up to half your weekly limit, then usage credits.';

/**
 * Every Claude model a user may choose for Claude Code, in display order: the current models,
 * then the older ones Claude still offers; in each, the newest version first, and within one
 * version Fable, Opus, Sonnet, Haiku. Claude has no way to list a plan's models at run time, so
 * this list is kept by hand, here only. Checked on 2026-10-13 against Anthropic's models overview, Claude Code's model page
 * (code.claude.com/docs/en/model-config) and the model table inside Claude Code 2.1.296, the
 * version the agent image pins: every id is one it knows, with these effort levels. Whether the
 * user's own Claude plan allows a model is Anthropic's call: a refusal ends the turn with the
 * CLI's message.
 */
export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', group: 'current', efforts: ALL_EFFORTS },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', group: 'current', efforts: ALL_EFFORTS },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', group: 'current', efforts: ALL_EFFORTS },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    group: 'current',
    efforts: ALL_EFFORTS,
    note: FABLE_NOTE,
  },
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    group: 'older',
    efforts: ALL_EFFORTS,
    note: FABLE_NOTE,
  },
  { id: 'claude-opus-5', label: 'Opus 5', group: 'older', efforts: ALL_EFFORTS },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', group: 'older', efforts: ALL_EFFORTS },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', group: 'older', efforts: ALL_EFFORTS },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', group: 'older', efforts: ALL_EFFORTS },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', group: 'older', efforts: NO_XHIGH },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', group: 'older', efforts: NO_XHIGH },
  { id: 'claude-opus-4-5', label: 'Opus 4.5', group: 'older', efforts: [] },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', group: 'older', efforts: [] },
];

const isClaudeModel = (id: string | null | undefined): id is string =>
  CLAUDE_MODELS.some((m) => m.id === id);
const isClaudeEffort = (e: string | null | undefined): e is ClaudeEffort =>
  (CLAUDE_EFFORTS as readonly string[]).includes(e ?? '');

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
  /** Claude Code's model and effort (null: its own default). Used only on Claude Code turns. */
  claudeModel: string | null;
  claudeEffort: ClaudeEffort | null;
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
    ...claudeChoiceOf(row),
  };
}

/** The stored choice, if it is still on the list (an id taken off the list means the default). */
function claudeChoiceOf(
  row: { claudeModel: string | null; claudeEffort: string | null } | undefined,
) {
  return {
    claudeModel: isClaudeModel(row?.claudeModel) ? row.claudeModel : null,
    claudeEffort: isClaudeEffort(row?.claudeEffort) ? row.claudeEffort : null,
  };
}

/**
 * What a Claude Code turn is told about the model and the effort (the delivery's `claude` field).
 * A value left out means Claude Code's own default.
 */
export async function claudeTurnOptions(
  userId: string,
): Promise<{ model?: string; effort?: ClaudeEffort }> {
  return claudeOptionsOf(claudeChoiceOf(await settingsRow(userId)));
}

/** The same, from settings the turn has already read (no second read of the row). */
export function claudeOptionsOf(
  settings: Pick<AgentSettingsView, 'claudeModel' | 'claudeEffort'>,
): { model?: string; effort?: ClaudeEffort } {
  return {
    ...(settings.claudeModel ? { model: settings.claudeModel } : {}),
    ...(settings.claudeEffort ? { effort: settings.claudeEffort } : {}),
  };
}

/**
 * Should the user's own API key pay for the AI? True exactly when the rule above picks `own_key`:
 * not when they chose Textcrew AI while it is on offer, and not while a Claude plan is in charge.
 * Billing then points their LiteLLM key at the own key (HLD 7.1).
 */
export async function ownKeyPaysForAi(userId: string, tx: Tx = db()): Promise<boolean> {
  if (!(await hasByokKey(userId, tx))) return false;
  const [row] = await tx.select().from(agentSettings).where(eq(agentSettings.userId, userId));
  const mode = config().AI_ACCESS_MODE;
  return (
    decideAccess({
      runtime: row?.runtime ?? 'hermes',
      claudeConnected: Boolean(row?.claudeConnectedAt),
      hasOwnKey: true,
      mode,
      preferPlatform: row?.aiPreference === 'platform',
    }).aiAccess === 'own_key'
  );
}

/** Listeners for "what pays for this user's AI may have changed" (billing re-routes the AI). */
type AiSourceListener = (userId: string) => Promise<void>;
const aiSourceListeners: AiSourceListener[] = [];

export function onAiSourceChanged(fn: AiSourceListener): void {
  aiSourceListeners.push(fn);
}

async function aiSourceChanged(userId: string): Promise<void> {
  for (const fn of aiSourceListeners) {
    try {
      await fn(userId);
    } catch (err) {
      logger().warn({ userId, err: (err as Error).message }, 'AI source listener failed');
    }
  }
}

async function saveSettings(
  userId: string,
  values: {
    runtime?: RuntimeName;
    aiPreference?: AiPreference;
    claudeConnectedAt?: Date | null;
    claudeModel?: string | null;
    claudeEffort?: ClaudeEffort | null;
  },
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
 * after WakeSandbox (see `syncRuntimeAfterWake`). True: the vm-manager took it.
 */
export async function pushRuntime(userId: string, settings?: AgentSettingsView): Promise<boolean> {
  const s = settings ?? (await getAgentSettings(userId));
  try {
    await vm().setAgentRuntime({ userId, runtime: toVmRuntime(s.effectiveRuntime) });
    return true;
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.NotFound) return false;
    logger().warn({ userId, err: String(err) }, 'setAgentRuntime failed; next turn re-syncs');
    return false;
  }
}

/**
 * After WakeSandbox: if the container runs another agent than it should, switch it. Returns the
 * engine this turn runs on: the one the settings say, or, if the switch didn't go through, the
 * one the container still has.
 */
export async function syncRuntimeAfterWake(
  userId: string,
  sandbox: { runtime?: AgentRuntime } | undefined,
  /** The user's settings when the caller has just read them. */
  read?: AgentSettingsView,
): Promise<RuntimeName> {
  const settings = read ?? (await getAgentSettings(userId));
  const wanted: RuntimeName = settings.effectiveRuntime ?? 'hermes';
  if (!sandbox || sameVmRuntime(sandbox.runtime, toVmRuntime(wanted))) return wanted;
  if (await pushRuntime(userId, settings)) return wanted;
  return sandbox.runtime === AgentRuntime.CLAUDE_CODE ? 'claude_code' : 'hermes';
}

/**
 * PATCH /v1/agent/settings: the runtime, the AI preference, Claude Code's model and effort, or
 * any of them together. Claude Code needs a connected Claude plan, and Textcrew AI can only be
 * chosen while it is on offer (409 otherwise). A model that isn't on the list is 400. The model
 * and the effort can be set whatever the engine is: they apply to Claude Code turns.
 */
export async function updateAgentSettings(
  userId: string,
  patch: {
    runtime?: RuntimeName;
    aiPreference?: AiPreference;
    claudeModel?: string | null;
    claudeEffort?: ClaudeEffort | null;
  },
): Promise<AgentSettingsView> {
  if (patch.claudeModel != null && !isClaudeModel(patch.claudeModel))
    throw badRequest('Unknown Claude model', { claudeModel: patch.claudeModel });
  if (patch.claudeEffort != null && !isClaudeEffort(patch.claudeEffort))
    throw badRequest('Unknown thinking effort', { claudeEffort: patch.claudeEffort });
  const current = await getAgentSettings(userId);
  if (patch.runtime === 'claude_code' && !current.claude.connected)
    throw conflict('Connect your Claude plan first');
  if (patch.aiPreference === 'platform' && !current.platformAvailable)
    throw conflict("Textcrew AI isn't on offer here. Use your own API key or your Claude plan");
  const runtime = patch.runtime !== undefined && patch.runtime !== current.runtime;
  const preference =
    patch.aiPreference !== undefined && patch.aiPreference !== current.aiPreference;
  const model = patch.claudeModel !== undefined && patch.claudeModel !== current.claudeModel;
  const effort = patch.claudeEffort !== undefined && patch.claudeEffort !== current.claudeEffort;
  if (runtime || preference || model || effort) {
    await saveSettings(userId, {
      ...(runtime ? { runtime: patch.runtime } : {}),
      ...(preference ? { aiPreference: patch.aiPreference } : {}),
      ...(model ? { claudeModel: patch.claudeModel } : {}),
      ...(effort ? { claudeEffort: patch.claudeEffort } : {}),
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
  if (runtime || preference) await aiSourceChanged(userId);
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
  await aiSourceChanged(userId);
  return settings;
}

/** The Claude plan is gone (disconnected, or its sign-in stopped working): back to Hermes. */
export async function markClaudeDisconnected(userId: string): Promise<AgentSettingsView> {
  await saveSettings(userId, { runtime: 'hermes', claudeConnectedAt: null });
  const settings = await getAgentSettings(userId);
  await pushRuntime(userId, settings);
  await aiSourceChanged(userId);
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
