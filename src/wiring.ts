// Composition root: connects modules through their exported hooks. Imported by api and worker.
import { toBalance } from './api/billing-presenters.ts';
import { markBlocked } from './modules/auth/links.ts';
import { getActiveUserCached } from './modules/auth/users.ts';
import {
  deleteUserAutomations,
  pauseAllForCredits,
  resumeAfterCredits,
  setAutomationLimit,
} from './modules/automations/automations.ts';
import { deleteUserCrewJobs } from './modules/automations/crew-jobs.ts';
import {
  chargeAppAction,
  chargePaidTool,
  getBalanceAndGrants,
  getLiteLLMKey,
  hasCredits,
  offboardBilling,
  onBalanceDepleted,
  onboardBilling,
  onCreditsAdded,
  onPlanChanged,
  onTurnBilled,
  planHasWebSearch,
  planLimits,
  queueTurnBilling,
  queueTurnRefund,
  redeemFromChat,
  settleUnbilledTurns,
  switchAiRoutingQuietly,
} from './modules/billing/index.ts';
import { queueOutbound, setBlockedHandler } from './modules/channels/outbound.ts';
import { wireChannels } from './modules/channels/register.ts';
import { publish } from './modules/channels/stream.ts';
import { parseSessionKey } from './modules/channels/types.ts';
import { activeConnections, deleteUserConnections } from './modules/integrations/apps.ts';
import { deleteUserByokKeys } from './modules/integrations/byok.ts';
import { setInboundPriority } from './modules/events/intake.ts';
import { deleteUserMcpServers, sandboxMcpConfig } from './modules/integrations/mcp-servers.ts';
import { handleApprovalReply } from './modules/orchestrator/approvals.ts';
import { queueBrowserSync, setBrowserPlanCheck } from './modules/orchestrator/browser.ts';
import { setLifecycleHooks } from './modules/orchestrator/lifecycle.ts';
import { setInboundHooks } from './modules/orchestrator/process-message.ts';
import { getAgentSettings, onAiSourceChanged } from './modules/orchestrator/agent-settings.ts';
import {
  routeTurn,
  setRoutingAppsProvider,
  setRoutingKeyProvider,
  wireRouting,
} from './modules/orchestrator/routing.ts';
import { setSandboxConfigProvider } from './modules/orchestrator/sandbox.ts';
import { connectAiText, setTurnHooks } from './modules/orchestrator/turn.ts';
import { setAppActionCharger } from './modules/platform-mcp/tools/apps.ts';
import { setPaidToolCharger, setWebSearchPlanCheck } from './modules/platform-mcp/tools/web.ts';

let wired = false;

/** Live balance for the web app (SSE `credits.updated`). */
async function publishCredits(userId: string): Promise<void> {
  const { balance, grants } = await getBalanceAndGrants(userId);
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
  // The AI choice or the Claude plan changed: settle usage, then point the user's LiteLLM key at
  // what pays now (their own key, or the plan). Saving or deleting a key does this in its route.
  onAiSourceChanged((userId) => switchAiRoutingQuietly(userId));

  // Bring your own AI: no AI source (AI_ACCESS_MODE=own_only) → "connect your AI", no wake.
  // A Claude plan answers everything itself: no Jev, no platform-model quick replies.
  setTurnHooks({
    route: async (input, ctx) => {
      const { aiAccess } = await (ctx?.settings ?? getAgentSettings(input.userId));
      if (aiAccess === 'none') return { kind: 'simple', reply: connectAiText() };
      if (aiAccess === 'claude_plan') return { kind: 'task' };
      return routeTurn(input, ctx);
    },
  });

  // Credits (HLD 7.4, 7.5): check before a turn, bill it after, never charge our failures. The
  // turn only adds its billing job and its refund job: the user's lock is given back without
  // waiting for either. A turn on the user's Claude plan never asks LiteLLM: Claude Code's AI
  // doesn't go through it. Before the check, earlier turns still waiting for their billing are
  // billed first when there are more than one.
  const aiThroughLiteLLM = (engine: string | null) => engine !== 'claude_code';
  setTurnHooks({
    hasCredits,
    settleBeforeTurn: settleUnbilledTurns,
    afterTurn: (userId, _outcome, turn) =>
      queueTurnBilling(userId, { turnId: turn.id, ai: aiThroughLiteLLM(turn.engine) }),
    onPlatformFault: (userId, { engine, ...turn }) =>
      queueTurnRefund(userId, { ...turn, ai: aiThroughLiteLLM(engine) }),
  });
  // Once a turn is billed, the web app gets the new balance.
  onTurnBilled((userId) => publishCredits(userId).catch(() => {}));

  // 1 credit for each successful app action that changes something (HLD 7.2).
  setAppActionCharger(async (userId, input) => (await chargeAppAction(userId, input)).charged);
  // Web search through Textcrew is a Max feature (HLD 7.1).
  setWebSearchPlanCheck(planHasWebSearch);
  // A paid tool costs its configured cost × 2.5 (HLD 7.2). For Scout's web search that is set
  // to exactly 1 credit a search.
  setPaidToolCharger(
    async (userId, { costUsd, ...input }) =>
      (await chargePaidTool(userId, { ...input, costMicroUsd: Math.round(costUsd * 1_000_000) }))
        .charged,
  );

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

  // Scout's browser is part of the Max plan (HLD 11.3). When a plan changes, a system job tells
  // the vm-manager to switch it on or off.
  setBrowserPlanCheck((plan) => planLimits(plan).browser);
  onPlanChanged(queueBrowserSync);

  // Max plan: priority in the inbound queue (lower number runs first; FIFO within a priority).
  setInboundPriority(async (userId) => {
    const plan = (await getActiveUserCached(userId))?.plan;
    return plan === 'max' ? 1 : plan === 'pro' ? 2 : 3;
  });

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
      await deleteUserByokKeys(userId); // after billing removed LiteLLM's copy
      await deleteUserConnections(userId);
      await deleteUserMcpServers(userId);
      await deleteUserAutomations(userId);
      await deleteUserCrewJobs(userId);
    },
  });
}
