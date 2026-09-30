// Fake vm-manager + fake Telegram Bot API for end-to-end tests without Docker.
import { randomBytes } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import { setLiteLLMClient } from '../src/modules/billing/litellm.ts';
import { sha256Hex } from '../src/shared/crypto.ts';
import { setTelegramApi } from '../src/modules/channels/adapters/telegram.ts';
import { setVmClient, type VmClient } from '../src/modules/orchestrator/vm.ts';
import { AgentRuntime, DeliverEventType, SandboxState } from '../proto-gen/vm/v1/vm_pb.ts';
import { testApp } from './helpers.ts';

export interface Delivery {
  userId: string;
  deliveryId: string;
  sessionKey: string;
  text: string;
  kind: number;
  approvalId: string;
  approved: boolean;
}

/** What the fake "agent" does with a delivered message. Default: echo it back via send_message. */
export type AgentBehaviour = (
  d: Delivery,
  mcp: (tool: string, args: Record<string, unknown>) => Promise<McpResult>,
) => Promise<void>;

export interface McpResult {
  isError?: boolean;
  text: string;
}

export async function mcpCall(
  token: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<McpResult> {
  const res = await testApp().request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const body = (await res.json()) as {
    result?: { isError?: boolean; content?: Array<{ text: string }> };
    error?: { message: string };
  };
  if (body.error) return { isError: true, text: body.error.message };
  return { isError: body.result?.isError ?? false, text: body.result?.content?.[0]?.text ?? '' };
}

export function installFakeVm(behaviour?: AgentBehaviour) {
  const tokens = new Map<string, string>();
  const deliveries: Delivery[] = [];
  const created: string[] = [];
  const touches: string[] = [];
  const allowlists: Array<{
    userId: string;
    domains: string[];
    mcpServers: Array<{ url: string; authSecret: string }>;
  }> = [];
  const agent: AgentBehaviour =
    behaviour ??
    (async (d, mcp) =>
      void (await mcp('send_message', { text: `echo: ${d.text}`, session_key: d.sessionKey })));
  const state = {
    agent,
    wakeError: null as Error | null,
    /** Next StartClaudeLogin / ClaudeLogout error (e.g. UNAVAILABLE), used once. */
    claudeError: null as Error | null,
    /** The next delivered turn ends with this ERROR instead of TURN_DONE (used once). */
    turnError: null as { message: string; platformFault: boolean } | null,
    /** Awake/browser seconds GetUsage reports per user. */
    usage: new Map<string, { awakeSeconds: bigint; browserSeconds: bigint }>(),
  };
  // Agent runtime + the in-container Claude Code sign-in (the code Anthropic shows the user).
  const runtimes = new Map<string, AgentRuntime>();
  const claudeConnected = new Set<string>();
  const runtimeCalls: Array<{ userId: string; runtime: AgentRuntime }> = [];
  const logins = new Map<string, { userId: string; code: string }>();
  const logouts: string[] = [];
  let loginSeq = 0;
  const sandboxView = (userId: string, s: SandboxState) => ({
    userId,
    state: s,
    runtime: runtimes.get(userId) ?? AgentRuntime.UNSPECIFIED,
    claudeConnected: claudeConnected.has(userId),
  });
  const takeClaudeError = () => {
    const e = state.claudeError;
    state.claudeError = null;
    if (e) throw e;
  };

  const fake = {
    async createSandbox(req: { userId: string; runtime?: AgentRuntime }) {
      let token = tokens.get(req.userId);
      if (!token) {
        token = randomBytes(24).toString('hex');
        tokens.set(req.userId, token);
        created.push(req.userId);
        runtimes.set(req.userId, req.runtime ?? AgentRuntime.UNSPECIFIED);
      }
      return {
        sandbox: sandboxView(req.userId, SandboxState.STOPPED),
        mcpTokenHash: sha256Hex(token),
      };
    },
    async wakeSandbox(req: { userId: string }) {
      if (state.wakeError) throw state.wakeError;
      return { sandbox: sandboxView(req.userId, SandboxState.AWAKE), wasStopped: true };
    },
    async *deliver(req: Delivery) {
      deliveries.push({ ...req });
      yield { type: DeliverEventType.ACCEPTED, message: '', platformFault: false };
      const token = tokens.get(req.userId)!;
      const failure = state.turnError;
      state.turnError = null;
      if (failure) {
        yield { type: DeliverEventType.ERROR, ...failure };
        return;
      }
      await state.agent(req, (tool, args) => mcpCall(token, tool, args));
      yield { type: DeliverEventType.TURN_DONE, message: '', platformFault: false };
    },
    async touch(req: { userId: string }) {
      touches.push(req.userId);
      return {};
    },
    async getSandbox(req: { userId: string }) {
      return {
        ...sandboxView(
          req.userId,
          tokens.has(req.userId) ? SandboxState.AWAKE : SandboxState.STOPPED,
        ),
        lastActiveAtUnixMs: BigInt(Date.now()),
      };
    },
    async deleteSandbox(req: { userId: string }) {
      tokens.delete(req.userId);
      return {};
    },
    async setEgressAllowlist(req: {
      userId: string;
      domains: string[];
      mcpServers: Array<{ url: string; authSecret: string }>;
    }) {
      allowlists.push(req);
      return {};
    },
    async getUsage(req: { userId: string }) {
      const u = state.usage.get(req.userId);
      return { usage: u ? [{ userId: req.userId, ...u }] : [] };
    },
    async setAgentRuntime(req: { userId: string; runtime: AgentRuntime }) {
      runtimeCalls.push({ userId: req.userId, runtime: req.runtime });
      if (!tokens.has(req.userId)) throw new ConnectError('sandbox not found', Code.NotFound);
      runtimes.set(req.userId, req.runtime);
      return { sandbox: sandboxView(req.userId, SandboxState.AWAKE) };
    },
    async startClaudeLogin(req: { userId: string }) {
      takeClaudeError();
      if (!tokens.has(req.userId)) throw new ConnectError('sandbox not found', Code.NotFound);
      const loginId = `login_${++loginSeq}`;
      logins.set(loginId, { userId: req.userId, code: `anthropic-code-${loginSeq}-secret` });
      return {
        loginId,
        authorizeUrl: `https://claude.ai/oauth/authorize?code=true&state=${loginId}`,
        expiresAtUnixMs: BigInt(Date.now() + 10 * 60_000),
      };
    },
    async completeClaudeLogin(req: { userId: string; loginId: string; code: string }) {
      const login = logins.get(req.loginId);
      if (!login || login.userId !== req.userId)
        throw new ConnectError('login not found', Code.NotFound);
      if (req.code !== login.code)
        return { connected: false, message: 'That code is wrong or expired. Start again.' };
      logins.delete(req.loginId);
      claudeConnected.add(req.userId);
      return { connected: true, message: '' };
    },
    async claudeLogout(req: { userId: string }) {
      takeClaudeError();
      logouts.push(req.userId);
      claudeConnected.delete(req.userId);
      return {};
    },
  };
  setVmClient(fake as unknown as VmClient);
  installFakeLiteLLM();
  return {
    tokens,
    deliveries,
    created,
    touches,
    allowlists,
    state,
    runtimes,
    claudeConnected,
    runtimeCalls,
    logins,
    logouts,
  };
}

export interface SentTelegram {
  chatId: string;
  text: string;
  buttons?: Array<{ text: string; callback_data: string }>;
}

export function installFakeTelegram() {
  const sent: SentTelegram[] = [];
  let nextId = 1000;
  setTelegramApi(async (method, body) => {
    if (method === 'sendMessage') {
      const kb = (
        body.reply_markup as
          { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> } | undefined
      )?.inline_keyboard?.[0];
      sent.push({
        chatId: String(body.chat_id),
        text: String(body.text),
        ...(kb ? { buttons: kb } : {}),
      });
      return { message_id: nextId++ };
    }
    return {};
  });
  return { sent };
}

let updateId = 1;
export function telegramUpdate(chatId: number, text: string, username = 'someone') {
  return {
    update_id: updateId++ + Math.floor(Math.random() * 1e9),
    message: { message_id: updateId, from: { id: chatId, username }, chat: { id: chatId }, text },
  };
}

export function telegramButton(chatId: number, data: string) {
  return {
    update_id: updateId++ + Math.floor(Math.random() * 1e9),
    callback_query: {
      id: `cb${updateId}`,
      from: { id: chatId },
      data,
      message: { message_id: 1, chat: { id: chatId } },
    },
  };
}

export interface ExecutedAction {
  slug: string;
  userId: string;
  connectedAccountId?: string;
  arguments: Record<string, unknown>;
}

/** Fake Composio: every app "connects" instantly; webhooks are "signed" with signature "valid". */
export async function installFakeComposio() {
  const { setComposioApi } = await import('../src/modules/integrations/composio.ts');
  const executed: ExecutedAction[] = [];
  const triggers: Array<{ userId: string; slug: string; triggerId: string }> = [];
  let n = 0;
  setComposioApi({
    async connectLink(userId, authConfigId) {
      return {
        accountId: `ca_${userId}_${authConfigId}_${n++}`,
        redirectUrl: `https://composio.test/connect/${authConfigId}`,
      };
    },
    async listAccounts() {
      return [];
    },
    async deleteAccount() {},
    async listTools(toolkits) {
      return toolkits.flatMap((t) => [
        {
          slug: `${t.toUpperCase()}_SEND_EMAIL`,
          toolkit: t,
          name: 'Send',
          description: 'Send an email',
          inputParameters: {},
        },
        {
          slug: `${t.toUpperCase()}_LIST_EMAILS`,
          toolkit: t,
          name: 'List',
          description: 'List emails',
          inputParameters: {},
        },
      ]);
    },
    async execute(slug, input) {
      executed.push({ slug, ...input });
      return { successful: true, data: { ok: true }, error: null };
    },
    async createTrigger(userId, slug) {
      const triggerId = `ti_${n++}`;
      triggers.push({ userId, slug, triggerId });
      return { triggerId };
    },
    async deleteTrigger(triggerId) {
      const i = triggers.findIndex((t) => t.triggerId === triggerId);
      if (i >= 0) triggers.splice(i, 1);
    },
    async verifyWebhook(input) {
      if (input.signature !== 'valid') throw new Error('bad signature');
      return JSON.parse(input.rawBody);
    },
  });
  return { executed, triggers };
}

/** No-network LiteLLM (keys, budgets, zero spend) so the real billing path runs in chat tests. */
export function installFakeLiteLLM() {
  const keys = new Map<
    string,
    { userId: string; aliases: Record<string, string>; maxBudget: number | null }
  >();
  setLiteLLMClient({
    async generateKey(input) {
      const key = `sk-fake-${randomBytes(8).toString('hex')}`;
      keys.set(key, { userId: input.userId, aliases: input.aliases, maxBudget: input.maxBudget });
      return { key };
    },
    async updateKey(key, patch) {
      const k = keys.get(key);
      if (k && patch.maxBudget !== undefined) k.maxBudget = patch.maxBudget;
    },
    async deleteKey(key) {
      keys.delete(key);
    },
    async getKeySpend() {
      return { spend: 0, modelSpend: {} };
    },
    async getSpendBetween() {
      return { spend: 0, modelSpend: {} };
    },
  });
  return { keys };
}
