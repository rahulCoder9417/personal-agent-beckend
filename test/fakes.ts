// Fake vm-manager + fake Telegram Bot API for end-to-end tests without Docker.
import { randomBytes } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import { setLiteLLMClient } from '../src/modules/billing/litellm.ts';
import { sha256Hex } from '../src/shared/crypto.ts';
import { setTelegramApi } from '../src/modules/channels/adapters/telegram.ts';
import type {
  ToolkitScopes,
  AuthConfigInfo,
  ComposioAccount,
  ComposioTool,
} from '../src/modules/integrations/composio.ts';
import { setVmClient, type VmClient } from '../src/modules/orchestrator/vm.ts';
import { laterSettled } from '../src/shared/later.ts';
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
  /** What the platform adds to the delivery (JSON), e.g. `chat_epoch` or a crew job. */
  metadataJson?: string;
}

/**
 * What the fake "agent" does with a delivered message. Default: echo it back via send_message.
 * `progress` reports a progress line, as the Bridge does (a WORKING event). `draft` reports the
 * whole draft of the answer so far (a TEXT_DELTA event), as the Bridge does when the delivery's
 * metadata has `stream_text: true`.
 */
export type AgentBehaviour = (
  d: Delivery,
  mcp: (tool: string, args: Record<string, unknown>) => Promise<McpResult>,
  progress: (text: string) => void,
  draft: (text: string) => void,
) => Promise<void>;

export interface McpResult {
  isError?: boolean;
  text: string;
}

export async function mcpCall(
  token: string,
  tool: string,
  args: Record<string, unknown>,
  /** `settle: false`: return with the answer, as the agent gets it (the activity log may follow). */
  opts: { settle?: boolean } = {},
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
  // The tool's activity-log entry is written after its answer: tests read it right after.
  if (opts.settle !== false) await laterSettled();
  if (body.error) return { isError: true, text: body.error.message };
  return { isError: body.result?.isError ?? false, text: body.result?.content?.[0]?.text ?? '' };
}

export function installFakeVm(behaviour?: AgentBehaviour) {
  const tokens = new Map<string, string>();
  const deliveries: Delivery[] = [];
  const created: string[] = [];
  /** Every WakeSandbox call, by user id. */
  const wakes: string[] = [];
  /** The priority each WakeSandbox call asked for (the plan's: HLD 7.1). */
  const wakePriorities: Array<{ userId: string; priority: number | undefined }> = [];
  const touches: string[] = [];
  /** Every StopSandbox call. */
  const stops: Array<{ userId: string; force: boolean; reason: string }> = [];
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
    /** SetAgentRuntime fails with this while it is set (the vm-manager can't be told). */
    runtimeError: null as Error | null,
    /** SetBrowser fails with this while it is set (a function: asked at every call). */
    browserError: null as Error | (() => Error | null) | null,
    /** The next delivered turn ends with this ERROR instead of TURN_DONE (used once). */
    turnError: null as { message: string; platformFault: boolean } | null,
    /** Like turnError, but the agent runs first (it may have acted before the turn failed). */
    turnErrorAfterAgent: null as { message: string; platformFault: boolean } | null,
    /** Awake/browser seconds GetUsage reports per user. */
    usage: new Map<string, { awakeSeconds: bigint; browserSeconds: bigint }>(),
    /** StopSandbox fails with this while it is set (e.g. a polite stop refused mid-turn). */
    stopError: null as Error | null,
    /**
     * Progress lines and drafts are streamed while the agent works, like the real Bridge (so a
     * draft comes before the answer's send_message). Off: they come after the agent is done.
     */
    live: false,
    /** What WakeSandbox says about where its time went (the vm-manager's WakeTimings). */
    wakeTimings: undefined as
      | {
          lockWaitMs: bigint;
          capacityWaitMs: bigint;
          evicted: boolean;
          recreated: boolean;
          containerStartMs: bigint;
          bridgeReadyMs: bigint;
        }
      | undefined,
    /** WakeSandbox's `was_stopped` (a cold start). */
    wasStopped: true,
    /** Called at each WakeSandbox before it answers (a test can hold the wake there). */
    onWake: undefined as ((req: { userId: string }) => Promise<void>) | undefined,
    /** The Bridge's stage-times report on the turn's last event (`timings_json`). */
    bridgeTimings: '',
    /**
     * Containers that sleep and wake like real ones: a wake of a sleeping container takes
     * `coldWakeMs` and says so (`was_stopped`, its WakeTimings); a wake of an awake one is at once,
     * and GetSandbox tells the two apart. Put one to sleep with `asleep(userId)`. Null (the
     * default): every wake answers as `wasStopped` and `wakeTimings` say, and GetSandbox says awake.
     */
    sleepModel: null as { coldWakeMs: number } | null,
  };
  /** Containers awake under `sleepModel`. */
  const awake = new Set<string>();
  // Agent runtime + the in-container Claude Code sign-in (the code Anthropic shows the user).
  const runtimes = new Map<string, AgentRuntime>();
  const claudeConnected = new Set<string>();
  const runtimeCalls: Array<{ userId: string; runtime: AgentRuntime }> = [];
  const logins = new Map<string, { userId: string; code: string }>();
  const logouts: string[] = [];
  let loginSeq = 0;
  // Scout's browser: the switch the vm-manager has on record per user, and every SetBrowser call.
  const browser = new Map<string, boolean>();
  const browserCalls: Array<{ userId: string; enabled: boolean }> = [];
  const sandboxView = (userId: string, s: SandboxState) => ({
    userId,
    state: s,
    runtime: runtimes.get(userId) ?? AgentRuntime.UNSPECIFIED,
    claudeConnected: claudeConnected.has(userId),
    browserEnabled: browser.get(userId) ?? false,
  });
  const takeClaudeError = () => {
    const e = state.claudeError;
    state.claudeError = null;
    if (e) throw e;
  };

  const fake = {
    async createSandbox(req: { userId: string; runtime?: AgentRuntime; browserEnabled?: boolean }) {
      let token = tokens.get(req.userId);
      // Idempotent per user, like the real one: a second call changes nothing.
      if (!token) {
        token = randomBytes(24).toString('hex');
        tokens.set(req.userId, token);
        created.push(req.userId);
        runtimes.set(req.userId, req.runtime ?? AgentRuntime.UNSPECIFIED);
        browser.set(req.userId, req.browserEnabled ?? false);
      }
      return {
        sandbox: sandboxView(req.userId, SandboxState.STOPPED),
        mcpTokenHash: sha256Hex(token),
      };
    },
    async wakeSandbox(req: { userId: string; priority?: number }) {
      wakes.push(req.userId);
      wakePriorities.push({ userId: req.userId, priority: req.priority });
      if (state.onWake) await state.onWake(req);
      if (state.wakeError) throw state.wakeError;
      const sleep = state.sleepModel;
      if (sleep) {
        const cold = !awake.has(req.userId);
        if (cold) {
          awake.add(req.userId);
          await new Promise((r) => setTimeout(r, sleep.coldWakeMs));
        }
        const ms = BigInt(cold ? sleep.coldWakeMs : 0);
        return {
          sandbox: sandboxView(req.userId, SandboxState.AWAKE),
          wasStopped: cold,
          timings: {
            lockWaitMs: 0n,
            capacityWaitMs: 0n,
            evicted: false,
            recreated: false,
            containerStartMs: ms / 2n,
            bridgeReadyMs: ms - ms / 2n,
          },
        };
      }
      return {
        sandbox: sandboxView(req.userId, SandboxState.AWAKE),
        wasStopped: state.wasStopped,
        ...(state.wakeTimings ? { timings: state.wakeTimings } : {}),
      };
    },
    async *deliver(req: Delivery) {
      deliveries.push({ ...req });
      yield { type: DeliverEventType.ACCEPTED, message: '', platformFault: false };
      const token = tokens.get(req.userId)!;
      const failure = state.turnError;
      state.turnError = null;
      if (failure) {
        yield { type: DeliverEventType.ERROR, ...failure, timingsJson: state.bridgeTimings };
        return;
      }
      type Ev = { type: DeliverEventType; message: string; platformFault: boolean };
      const lines: Ev[] = [];
      let wake: (() => void) | undefined;
      let finished = false;
      const add = (type: DeliverEventType) => (message: string) => {
        lines.push({ type, message, platformFault: false });
        wake?.();
      };
      const run = state
        .agent(
          req,
          (tool, args) => mcpCall(token, tool, args),
          add(DeliverEventType.WORKING),
          add(DeliverEventType.TEXT_DELTA),
        )
        .finally(() => {
          finished = true;
          wake?.();
        });
      if (state.live) {
        for (;;) {
          const next = lines.shift();
          if (next) yield next;
          else if (finished) break;
          else await new Promise<void>((r) => (wake = r));
        }
      }
      await run;
      yield* lines;
      const late = state.turnErrorAfterAgent;
      state.turnErrorAfterAgent = null;
      if (late) {
        yield { type: DeliverEventType.ERROR, ...late };
        return;
      }
      yield {
        type: DeliverEventType.TURN_DONE,
        message: '',
        platformFault: false,
        timingsJson: state.bridgeTimings,
      };
    },
    async stopSandbox(req: { userId: string; force?: boolean; reason?: string }) {
      stops.push({ userId: req.userId, force: req.force ?? false, reason: req.reason ?? '' });
      if (state.stopError) throw state.stopError;
      if (!tokens.has(req.userId)) throw new ConnectError('sandbox not found', Code.NotFound);
      return { sandbox: sandboxView(req.userId, SandboxState.STOPPED) };
    },
    async touch(req: { userId: string }) {
      touches.push(req.userId);
      return {};
    },
    async getSandbox(req: { userId: string }) {
      return {
        ...sandboxView(
          req.userId,
          (state.sleepModel ? awake.has(req.userId) : tokens.has(req.userId))
            ? SandboxState.AWAKE
            : SandboxState.STOPPED,
        ),
        lastActiveAtUnixMs: BigInt(Date.now()),
      };
    },
    async deleteSandbox(req: { userId: string }) {
      tokens.delete(req.userId);
      browser.delete(req.userId);
      return {};
    },
    /** Stored now; a real container gets it on its next wake. */
    async setBrowser(req: { userId: string; enabled: boolean }) {
      browserCalls.push({ userId: req.userId, enabled: req.enabled });
      const failure =
        typeof state.browserError === 'function' ? state.browserError() : state.browserError;
      if (failure) throw failure;
      if (!tokens.has(req.userId)) throw new ConnectError('sandbox not found', Code.NotFound);
      browser.set(req.userId, req.enabled);
      return { sandbox: sandboxView(req.userId, SandboxState.STOPPED) };
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
      if (state.runtimeError) throw state.runtimeError;
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
    wakes,
    wakePriorities,
    touches,
    stops,
    allowlists,
    state,
    runtimes,
    claudeConnected,
    runtimeCalls,
    logins,
    logouts,
    browser,
    browserCalls,
    /** Under `sleepModel`: the container goes to sleep (its idle stop). */
    asleep: (userId: string) => void awake.delete(userId),
  };
}

export interface SentTelegram {
  chatId: string;
  text: string;
  buttons?: Array<{ text: string; callback_data: string }>;
}

/** One call to the Bot API, with when it was made (`performance.now()`). */
export interface TelegramCall {
  method: string;
  chatId: string;
  /** `sendChatAction`'s action (`typing`). */
  action?: string;
  at: number;
}

export function installFakeTelegram() {
  const sent: SentTelegram[] = [];
  /** Every call, in order: messages, chat actions ("typing…") and button answers. */
  const calls: TelegramCall[] = [];
  let nextId = 1000;
  setTelegramApi(async (method, body) => {
    calls.push({
      method,
      chatId: String(body.chat_id ?? ''),
      ...(typeof body.action === 'string' ? { action: body.action } : {}),
      at: performance.now(),
    });
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
  return { sent, calls };
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
  const triggers: Array<{
    userId: string;
    slug: string;
    triggerId: string;
    config: Record<string, unknown>;
    /** The connected account it watches (Composio picks the user's first one when none is given). */
    connectedAccountId: string | undefined;
  }> = [];
  const state = {
    /** What Composio reports for a user's connected accounts (listAccounts, account). */
    accounts: new Map<string, ComposioAccount[]>(),
    /** listAccounts calls, by user id. */
    accountLookups: [] as string[],
    /** account calls (one connected account, asked by its id), by account id. */
    accountGets: [] as string[],
    /**
     * Composio answers the list of a user's accounts in pages, oldest first. Null: one page holds
     * them all. A number: listAccounts returns only that many (the SDK call asks for no page size).
     */
    accountsPage: null as number | null,
    /** The next listAccounts or account call fails with this (used once). */
    accountsError: null as Error | null,
    /** deleteAccount calls that succeeded, by account id. */
    deletedAccounts: [] as string[],
    /** deleteAccount fails with this for these account ids, until a test removes them. */
    deleteAccountErrors: new Map<string, Error>(),
    /**
     * The tools of a toolkit, when a test sets them. Otherwise every toolkit has two: a send and a
     * list action.
     */
    tools: new Map<string, ComposioTool[]>(),
    /** listTools calls: the toolkits of each request. */
    toolRequests: [] as string[][],
    /**
     * Like Composio's tool list: one request for several toolkits answers at most this many tools
     * in all (the request's `limit`), toolkit by toolkit in name order.
     */
    toolsLimit: 200,
    /** The next listTools call for this toolkit fails (used once). */
    toolsError: new Map<string, Error>(),
    /** tool calls (one tool asked by its name), by slug. */
    toolLookups: [] as string[],
    /** The next tool call fails with this (used once). */
    toolError: null as Error | null,
    /** Composio's tags per tool slug (e.g. `readOnlyHint`). */
    tags: new Map<string, string[]>(),
    /** toolTags calls, by slug. */
    tagLookups: [] as string[],
    /** The next toolTags call fails with this (used once). */
    tagsError: null as Error | null,
    /** The next execute returns this failure, or throws it (used once). */
    executeFailure: null as string | Error | null,
    /** What execute returns as `data` for an action (default `{ ok: true }`). */
    executeData: new Map<string, unknown>(),
    /** The next createTrigger throws this (used once). */
    triggerError: null as Error | null,
    /** The next listTriggers throws this (used once). */
    listTriggersError: null as Error | null,
    /** Every listTriggers call, with its filter. */
    triggerListings: [] as Array<{ triggerIds?: string[]; connectedAccountIds?: string[] }>,
    /** The next deleteAccount throws this (used once). */
    deleteAccountError: null as Error | null,
    /**
     * What Composio says about each setup (auth config). One not listed here is Composio's
     * shared sign-in, as the real setups made in the dashboard are by default.
     */
    authConfigs: new Map<string, AuthConfigInfo>(),
    /** authConfig calls, by id. */
    authConfigLookups: [] as string[],
    /** The next authConfig call fails with this (used once). */
    authConfigError: null as Error | null,
    /** Every sign-in started: the way it went and the page to come back to. */
    signIns: [] as Array<{
      kind: 'link' | 'direct';
      userId: string;
      authConfigId: string;
      authScheme?: string;
      callbackUrl: string;
    }>,
    /** The next connectDirect / connectLink fails with this (used once). */
    directError: null as Error | null,
    linkError: null as Error | null,
    /** Setups the server made with Composio's shared sign-in, by toolkit. */
    managedSetups: [] as Array<{ toolkit: string; name: string; id: string }>,
    /** The scopes each setup names (absent: none, so Composio's default set). */
    setupScopes: new Map<string, string[]>(),
    /** What Composio says each toolkit's sign-in asks for (absent: nothing, no recommendation). */
    toolkitScopes: new Map<string, ToolkitScopes>(),
    /** Every scope question asked: a setup's (by id) or a toolkit's (with its actions). */
    scopeQuestions: [] as Array<{ setup: string } | { toolkit: string; tools: string[] }>,
    /** The next authConfigScopes / toolkitScopes call fails with this (used once). */
    scopesError: null as Error | null,
    /** The next setUpManagedAuthConfig fails with this (used once). */
    setupError: null as Error | null,
  };
  let n = 0;
  const once = <
    K extends 'authConfigError' | 'directError' | 'linkError' | 'setupError' | 'scopesError',
  >(
    key: K,
  ) => {
    const err = state[key];
    state[key] = null;
    if (err) throw err;
  };
  setComposioApi({
    async connectLink(userId, authConfigId, callbackUrl) {
      once('linkError');
      state.signIns.push({ kind: 'link', userId, authConfigId, callbackUrl });
      return {
        accountId: `ca_${userId}_${authConfigId}_${n++}`,
        redirectUrl: `https://composio.test/connect/${authConfigId}`,
      };
    },
    async connectDirect(userId, authConfigId, authScheme, callbackUrl) {
      once('directError');
      state.signIns.push({ kind: 'direct', userId, authConfigId, authScheme, callbackUrl });
      return {
        accountId: `ca_${userId}_${authConfigId}_${n++}`,
        redirectUrl: `https://provider.test/oauth/authorize?config=${authConfigId}`,
      };
    },
    async authConfig(authConfigId) {
      state.authConfigLookups.push(authConfigId);
      once('authConfigError');
      return state.authConfigs.get(authConfigId) ?? { composioManaged: true, authScheme: 'OAUTH2' };
    },
    async authConfigScopes(authConfigId) {
      state.scopeQuestions.push({ setup: authConfigId });
      once('scopesError');
      return state.setupScopes.get(authConfigId) ?? null;
    },
    async toolkitScopes(toolkit, tools) {
      state.scopeQuestions.push({ toolkit, tools: [...tools] });
      once('scopesError');
      return (
        state.toolkitScopes.get(toolkit) ?? { required: [], leastPrivilege: null, fewest: null }
      );
    },
    async setUpManagedAuthConfig(toolkit, name) {
      once('setupError');
      const id = `ac_made_${toolkit}_${n++}`;
      state.managedSetups.push({ toolkit, name, id });
      return { id };
    },
    async listAccounts(userId) {
      state.accountLookups.push(userId);
      const err = state.accountsError;
      state.accountsError = null;
      if (err) throw err;
      const all = state.accounts.get(userId) ?? [];
      return state.accountsPage === null ? all : all.slice(0, state.accountsPage);
    },
    async account(accountId) {
      state.accountGets.push(accountId);
      const err = state.accountsError;
      state.accountsError = null;
      if (err) throw err;
      for (const list of state.accounts.values()) {
        const found = list.find((a) => a.id === accountId);
        if (found) return found;
      }
      return null;
    },
    async deleteAccount(accountId) {
      const err = state.deleteAccountErrors.get(accountId) ?? state.deleteAccountError;
      state.deleteAccountError = null;
      if (err) throw err;
      state.deletedAccounts.push(accountId);
      for (const [userId, list] of state.accounts)
        state.accounts.set(
          userId,
          list.filter((a) => a.id !== accountId),
        );
    },
    async accessToken(accountId) {
      return `gho_fake_token_for_${accountId}`;
    },
    async listTools(toolkits) {
      state.toolRequests.push([...toolkits]);
      for (const t of toolkits) {
        const err = state.toolsError.get(t);
        state.toolsError.delete(t);
        if (err) throw err;
      }
      return [...toolkits]
        .sort()
        .flatMap(
          (t) =>
            state.tools.get(t) ?? [
              {
                slug: `${t.toUpperCase()}_SEND_EMAIL`,
                toolkit: t,
                name: 'Send',
                description: 'Send an email',
                inputParameters: {},
                tags: [],
              },
              {
                slug: `${t.toUpperCase()}_LIST_EMAILS`,
                toolkit: t,
                name: 'List',
                description: 'List emails',
                inputParameters: {},
                tags: ['readOnlyHint'],
              },
            ],
        )
        .slice(0, state.toolsLimit);
    },
    async tool(slug) {
      state.toolLookups.push(slug);
      const err = state.toolError;
      state.toolError = null;
      if (err) throw err;
      for (const list of state.tools.values()) {
        const found = list.find((t) => t.slug === slug);
        if (found) return found;
      }
      // A toolkit whose tools a test set has only those; any other name is a tool whose inputs
      // Composio did not describe (so they are not checked).
      const lower = slug.toLowerCase();
      if ([...state.tools.keys()].some((t) => lower.startsWith(`${t}_`))) return null;
      return { slug, toolkit: '', name: slug, description: '', inputParameters: {}, tags: [] };
    },
    async toolTags(slug) {
      state.tagLookups.push(slug);
      const err = state.tagsError;
      state.tagsError = null;
      if (err) throw err;
      return state.tags.get(slug) ?? [];
    },
    async execute(slug, input) {
      const failure = state.executeFailure;
      state.executeFailure = null;
      if (failure instanceof Error) throw failure;
      if (failure) return { successful: false, data: null, error: failure };
      executed.push({ slug, ...input });
      const data = state.executeData.has(slug) ? state.executeData.get(slug) : { ok: true };
      return { successful: true, data, error: null };
    },
    async createTrigger(userId, slug, connectedAccountId, config) {
      const err = state.triggerError;
      state.triggerError = null;
      if (err) throw err;
      // Unique across installs, as Composio's are: a test file installs this fake more than once.
      const triggerId = `ti_${randomBytes(6).toString('hex')}`;
      triggers.push({ userId, slug, triggerId, config, connectedAccountId });
      return { triggerId };
    },
    async listTriggers({ triggerIds, connectedAccountIds }) {
      state.triggerListings.push({ triggerIds, connectedAccountIds });
      const err = state.listTriggersError;
      state.listTriggersError = null;
      if (err) throw err;
      if (!triggerIds?.length && !connectedAccountIds?.length) return [];
      return triggers
        .filter(
          (t) =>
            (!triggerIds?.length || triggerIds.includes(t.triggerId)) &&
            (!connectedAccountIds?.length ||
              connectedAccountIds.includes(t.connectedAccountId ?? '')),
        )
        .map((t) => ({
          id: t.triggerId,
          connectedAccountId: t.connectedAccountId ?? '',
          slug: t.slug,
          config: t.config,
        }));
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
  return { executed, triggers, state };
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
    async saveModel() {},
    async deleteModel() {},
  });
  return { keys };
}
