// Composition root: connects modules through their exported hooks. Imported by api and worker.
import { toBalance } from './api/billing-presenters.ts';
import { markBlocked } from './modules/auth/links.ts';
import {
  deleteUserAutomations,
  pauseAllForCredits,
  resumeAfterCredits,
  setAutomationLimit,
} from './modules/automations/automations.ts';
import {
  getBalance,
  getLiteLLMKey,
  hasCredits,
  listBalanceGrants,
  offboardBilling,
  onBalanceDepleted,
  onboardBilling,
  onCreditsAdded,
  planLimits,
  redeemFromChat,
  reverseTurn,
  syncUsageForUser,
} from './modules/billing/index.ts';
import { queueOutbound } from './modules/channels/outbound.ts';
import { setBlockedHandler } from './modules/channels/outbound.ts';
import { wireChannels } from './modules/channels/register.ts';
import { publish } from './modules/channels/stream.ts';
import { parseSessionKey } from './modules/channels/types.ts';
import { activeConnections, deleteUserConnections } from './modules/integrations/apps.ts';
import { deleteUserMcpServers, sandboxMcpConfig } from './modules/integrations/mcp-servers.ts';
import { handleApprovalReply } from './modules/orchestrator/approvals.ts';
import { setLifecycleHooks } from './modules/orchestrator/lifecycle.ts';
import { setInboundHooks } from './modules/orchestrator/process-message.ts';
import {
  setRoutingAppsProvider,
  setRoutingKeyProvider,
  wireRouting,
} from './modules/orchestrator/routing.ts';
import { setSandboxConfigProvider } from './modules/orchestrator/sandbox.ts';
import { setTurnHooks } from './modules/orchestrator/turn.ts';
import { logger } from './shared/logger.ts';

let wired = false;

/** Live balance for the web app (SSE `credits.updated`). */
async function publishCredits(userId: string): Promise<void> {
  const now = new Date();
  const [balance, grants] = await Promise.all([
    getBalance(userId, now),
    listBalanceGrants(userId, now),
  ]);
  await publish(userId, 'credits.updated', toBalance(balance, grants));
}

export function wireModules(): void {
  if (wired) return;
  wired = true;

  wireChannels(); // WhatsApp + Sendblue adapters, parsers, receipts, media download
  wireRouting(); // Jev: simple / task / spam before waking a container
  // Jev picks from the user's connected apps; quick replies use the user's own LiteLLM key.
  setRoutingAppsProvider(async (userId) =>
    (await activeConnections(userId)).map((c) => ({ slug: c.catalog.slug, name: c.catalog.name })),
  );
  setRoutingKeyProvider(async (userId) => getLiteLLMKey(userId).catch(() => null));

  // Credits (HLD 7.4, 7.5): check before a turn, quick sync after it, never charge our failures.
  setTurnHooks({
    hasCredits,
    afterTurn: async (userId) => {
      await syncUsageForUser(userId).catch((err: unknown) =>
        logger().warn({ userId, err: String(err) }, 'after-turn sync failed'),
      );
      await publishCredits(userId).catch(() => {});
    },
    onPlatformFault: async (userId, turn) => {
      await reverseTurn(userId, turn);
    },
  });

  // At zero: pause automations. Credits added: un-pause the ones paused for credits.
  onBalanceDepleted(async (userId) => {
    await pauseAllForCredits(userId);
    await publishCredits(userId);
  });
  onCreditsAdded(async (userId) => {
    await resumeAfterCredits(userId);
    await publishCredits(userId);
  });
  setAutomationLimit((plan) => planLimits(plan).automations);

  // A blocked chat is marked; the agent is told to use the web app instead.
  setBlockedHandler(async (userId, sessionKey) => {
    const s = parseSessionKey(sessionKey);
    if (s && s.channel !== 'web' && s.externalChatId)
      await markBlocked(userId, s.channel, s.externalChatId);
  });

  setInboundHooks({
    // ✅ / ❌ buttons and yes/no replies answer approvals.
    handleButton: handleApprovalReply,
    // A coupon code sent in chat is redeemed, not given to the agent.
    handleText: async (userId, text, sessionKey) => {
      const reply = await redeemFromChat(userId, text);
      if (reply === null) return false;
      await queueOutbound({ userId, sessionKey, text: reply });
      return true;
    },
  });

  // New containers: the user's LiteLLM key, own MCP servers and allowlist.
  setSandboxConfigProvider({
    litellmKey: getLiteLLMKey,
    mcpServers: async (userId) => (await sandboxMcpConfig(userId)).servers,
    allowlist: async (userId) => (await sandboxMcpConfig(userId)).domains,
  });

  setLifecycleHooks({
    // Sign-up grant (respecting the free-credit cap) + LiteLLM key, before the sandbox.
    onboard: async (userId) => {
      await onboardBilling(userId);
    },
    offboard: async (userId) => {
      await offboardBilling(userId);
      await deleteUserConnections(userId);
      await deleteUserMcpServers(userId);
      await deleteUserAutomations(userId);
    },
  });
}
