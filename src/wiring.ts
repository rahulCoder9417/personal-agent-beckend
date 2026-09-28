// Composition root: connects modules through their exported hooks. Imported by api and worker.
import { markBlocked } from './modules/auth/links.ts';
import { setBlockedHandler } from './modules/channels/outbound.ts';
import { parseSessionKey } from './modules/channels/types.ts';
import { deleteUserConnections } from './modules/integrations/apps.ts';
import { deleteUserMcpServers, sandboxMcpConfig } from './modules/integrations/mcp-servers.ts';
import { handleApprovalReply } from './modules/orchestrator/approvals.ts';
import { setLifecycleHooks } from './modules/orchestrator/lifecycle.ts';
import { setInboundHooks } from './modules/orchestrator/process-message.ts';
import { setSandboxConfigProvider } from './modules/orchestrator/sandbox.ts';

let wired = false;

export function wireModules(): void {
  if (wired) return;
  wired = true;

  // A blocked chat is marked; the agent is told to use the web app instead.
  setBlockedHandler(async (userId, sessionKey) => {
    const s = parseSessionKey(sessionKey);
    if (s && s.channel !== 'web' && s.externalChatId)
      await markBlocked(userId, s.channel, s.externalChatId);
  });

  // ✅ / ❌ buttons and yes/no replies answer approvals.
  setInboundHooks({ handleButton: handleApprovalReply });

  // New containers get the user's own MCP servers + allowlist.
  setSandboxConfigProvider({
    mcpServers: async (userId) => (await sandboxMcpConfig(userId)).servers,
    allowlist: async (userId) => (await sandboxMcpConfig(userId)).domains,
  });

  setLifecycleHooks({
    offboard: async (userId) => {
      await deleteUserConnections(userId);
      await deleteUserMcpServers(userId);
    },
  });
}
