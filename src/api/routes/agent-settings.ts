// Agent settings + connecting the user's own Claude plan (openapi tag `agent`).
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  crewDefaultsFor,
  getAgentSettings,
  updateAgentSettings,
  type AgentSettingsView,
} from '../../modules/orchestrator/agent-settings.ts';
import {
  completeClaudeLogin,
  disconnectClaude,
  startClaudeLogin,
} from '../../modules/orchestrator/claude-login.ts';
import { iso } from '../presenters.ts';
import { route } from '../router.ts';
import type { Schemas } from '../types.ts';

function toAgentSettings(s: AgentSettingsView): Schemas['AgentSettings'] {
  return {
    runtime: s.runtime,
    effectiveRuntime: s.effectiveRuntime,
    aiAccess: s.aiAccess,
    aiPreference: s.aiPreference,
    platformAvailable: s.platformAvailable,
    claude: { connected: s.claude.connected, connectedAt: iso(s.claude.connectedAt) },
    ownKeyProviders: s.ownKeyProviders,
    claudeModel: s.claudeModel,
    claudeEffort: s.claudeEffort,
    claudeCrew: s.claudeCrew,
    claudeChoices: {
      models: CLAUDE_MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        group: m.group,
        efforts: [...m.efforts],
        ...(m.note ? { note: m.note } : {}),
      })),
      efforts: [...CLAUDE_EFFORTS],
      crewDefaults: crewDefaultsFor(s),
    },
  };
}

export const agentSettingsRoutes = [
  route('getAgentSettings', async (c) => {
    return c.json(toAgentSettings(await getAgentSettings(c.get('user').id)), 200);
  }),

  route('updateAgentSettings', async (c, { body }) => {
    const userId = c.get('user').id;
    // What pays for the AI may have changed: billing re-routes it (wired in src/wiring.ts).
    const settings = await updateAgentSettings(userId, body);
    return c.json(toAgentSettings(settings), 200);
  }),

  route('startClaudeLogin', async (c) => {
    const s = await startClaudeLogin(c.get('user').id);
    return c.json(
      { loginId: s.loginId, authorizeUrl: s.authorizeUrl, expiresAt: s.expiresAt.toISOString() },
      201,
    );
  }),

  // The body's `code` goes straight to the container's sign-in; never log or keep it.
  route('completeClaudeLogin', async (c, { params, body }) => {
    const s = await completeClaudeLogin(c.get('user').id, params.loginId, body.code);
    return c.json(toAgentSettings(s), 200);
  }),

  route('disconnectClaude', async (c) => {
    await disconnectClaude(c.get('user').id);
    return c.body(null, 204);
  }),
];
