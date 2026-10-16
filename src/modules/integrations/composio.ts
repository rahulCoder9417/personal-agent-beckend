import { AuthScheme, Composio } from '@composio/core';
import { config } from '../../shared/config.ts';

export interface ComposioTool {
  slug: string;
  toolkit: string;
  name: string;
  description: string;
  inputParameters: Record<string, unknown>;
  /** Composio's tags, e.g. `readOnlyHint` on a tool that only reads. */
  tags: string[];
}

export interface ComposioAccount {
  id: string;
  toolkit: string;
  status: string;
  label: string | null;
  /** The setup (auth config) the account was made with, when Composio says. */
  authConfigId?: string | null;
}

export interface ComposioTriggerEvent {
  triggerSlug: string;
  toolkit: string;
  userId: string;
  connectedAccountId: string | null;
  triggerId: string | null;
  payload: Record<string, unknown>;
}

/** One trigger instance at Composio: what it watches for, and on which connected account. */
export interface ComposioTriggerInstance {
  id: string;
  connectedAccountId: string;
  /** The trigger's slug, e.g. GMAIL_NEW_GMAIL_MESSAGE. */
  slug: string;
  config: Record<string, unknown>;
}

/** What Composio says about one app setup (auth config). */
export interface AuthConfigInfo {
  /** Composio's shared sign-in app at the provider. False: our own app (a custom auth config). */
  composioManaged: boolean;
  /** How users sign in: `OAUTH2`, `OAUTH1`, `API_KEY`… Null when Composio didn't say. */
  authScheme: string | null;
}

/**
 * The scopes Composio names for an app's OAuth sign-in. `required`: the ones its sign-in always
 * asks for. `leastPrivilege` and `fewest`: Composio's recommendation for the given actions (the
 * narrowest scope per need, and the smallest set that covers all); Composio marks it beta, so it
 * is null when it can't be had.
 */
export interface ToolkitScopes {
  required: string[];
  leastPrivilege: string[] | null;
  fewest: string[] | null;
}

/**
 * The scopes a setup asks for, from its credentials, or null when it names none (Composio's default
 * set). Only the two scope fields are read: the same object holds the client secret of our own
 * sign-in app, which must never be printed. A list may be one string with commas or spaces.
 */
export function scopesFromCredentials(credentials: unknown): string[] | null {
  if (!credentials || typeof credentials !== 'object') return null;
  const c = credentials as Record<string, unknown>;
  const out: string[] = [];
  for (const value of [c.scopes, c.user_scopes]) {
    const items = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : typeof value === 'string'
        ? value.split(/[\s,]+/)
        : [];
    for (const item of items) if (item.trim()) out.push(item.trim());
  }
  return out.length ? [...new Set(out)] : null;
}

/** The scopes an app's OAuth sign-in always asks for, from Composio's description of the app. */
export function requiredScopesFrom(
  details: Array<{ mode?: string; requiredScopes?: string[] }> | undefined,
): string[] {
  const oauth = (details ?? []).find((d) => d.mode === 'OAUTH2' || d.mode === 'OAUTH1');
  return [...new Set(oauth?.requiredScopes ?? [])];
}

/** The slice of Composio we use. Real SDK below; tests install a fake. */
export interface ComposioApi {
  /**
   * A Composio Connect Link: Composio's own connect page, then the provider's. Works for every
   * setup, and is the only way left for one with Composio's shared sign-in (`initiate()` was
   * retired for those on 2026-07-03).
   */
  connectLink(
    userId: string,
    authConfigId: string,
    callbackUrl: string,
  ): Promise<{ accountId: string; redirectUrl: string }>;
  /**
   * For a setup with our own sign-in app: `initiate()` with the long redirect URL, so the link is
   * the provider's own sign-in page, with no Composio page and no Composio address on the way.
   */
  connectDirect(
    userId: string,
    authConfigId: string,
    authScheme: 'OAUTH2' | 'OAUTH1',
    callbackUrl: string,
  ): Promise<{ accountId: string; redirectUrl: string }>;
  /** One app setup, as Composio describes it (see `authConfigInfo` below, which caches it). */
  authConfig(authConfigId: string): Promise<AuthConfigInfo>;
  /**
   * The scopes one setup asks for, or null when it names none (then Composio's default set
   * applies). Read-only. Never returns anything else of the setup: see `scopesFromCredentials`.
   */
  authConfigScopes(authConfigId: string): Promise<string[] | null>;
  /**
   * What Composio says an app's sign-in asks for, and its recommendation for these actions
   * (`[]`: every action of the app). Read-only. For the ops script's `scopes` command.
   */
  toolkitScopes(toolkit: string, tools: string[]): Promise<ToolkitScopes>;
  /**
   * An enabled setup with Composio's shared sign-in for a toolkit: one already in the project, or
   * a new one named `name`. Needs a Composio key that may make setups (the default "full access").
   */
  setUpManagedAuthConfig(toolkit: string, name: string): Promise<{ id: string }>;
  /** The user's connected accounts. Composio answers in pages: this is the first one only. */
  listAccounts(userId: string): Promise<ComposioAccount[]>;
  /** One connected account, asked by its id. Null when Composio has no such account. */
  account(accountId: string): Promise<ComposioAccount | null>;
  /** Removes one connected account at Composio. One Composio no longer has counts as removed. */
  deleteAccount(accountId: string): Promise<void>;
  /**
   * The provider OAuth access token of one connected account, or null when Composio doesn't
   * return it (missing, or masked by the project's "mask connected account secrets" setting).
   * Used only by the git gateway; the token never leaves the api.
   */
  accessToken(accountId: string): Promise<string | null>;
  /**
   * The tools of these toolkits, in one request with one limit (200) for all of them. So ask for
   * one toolkit at a time (`appActionsFor`): GitHub alone has more than 200.
   */
  listTools(toolkits: string[]): Promise<ComposioTool[]>;
  /**
   * One tool, asked by its name, or null when Composio has no tool of that name (see `actionTool`
   * below, which looks in the app's listing first and caches the answer).
   */
  tool(slug: string): Promise<ComposioTool | null>;
  /** One tool's Composio tags (see `toolTags` below, which caches them). */
  toolTags(slug: string): Promise<string[]>;
  execute(
    slug: string,
    input: { userId: string; connectedAccountId?: string; arguments: Record<string, unknown> },
  ): Promise<{ successful: boolean; data: unknown; error: string | null }>;
  createTrigger(
    userId: string,
    triggerSlug: string,
    connectedAccountId: string | undefined,
    triggerConfig: Record<string, unknown>,
  ): Promise<{ triggerId: string }>;
  deleteTrigger(triggerId: string): Promise<void>;
  /**
   * Trigger instances (switched off ones too), by their ids or by the connected accounts they
   * watch. Read-only. Composio answers in pages; all pages are read, up to 2,000 instances.
   */
  listTriggers(filter: {
    triggerIds?: string[];
    connectedAccountIds?: string[];
  }): Promise<ComposioTriggerInstance[]>;
  /** Verifies a webhook and returns either a trigger event or a connection status change. */
  verifyWebhook(input: {
    rawBody: string;
    signature: string;
    webhookId: string;
    webhookTimestamp: string;
  }): Promise<
    | { kind: 'trigger'; event: ComposioTriggerEvent }
    | { kind: 'connection'; accountId: string; status: 'active' | 'expired' | 'error' }
    | { kind: 'other'; type: string }
  >;
}

/**
 * Which existing setup to reuse for a toolkit: an enabled one with Composio's shared sign-in for
 * that same toolkit. The list was asked for that toolkit already; the check here makes sure a
 * setup of another app is never taken, whatever the list holds.
 */
export function pickManagedSetup(
  items: Array<{ id: string; status: string; toolkit?: string | null }>,
  toolkit: string,
): string | undefined {
  return items.find(
    (ac) => ac.status === 'ENABLED' && ac.toolkit?.toLowerCase() === toolkit.toLowerCase(),
  )?.id;
}

type RawAccount = {
  id: string;
  status: string;
  toolkit?: { slug?: string };
  authConfig?: { id?: string };
  data?: Record<string, unknown>;
};

const toAccount = (a: RawAccount): ComposioAccount => ({
  id: a.id,
  toolkit: a.toolkit?.slug ?? '',
  status: a.status,
  label: (a.data?.email as string | undefined) ?? null,
  authConfigId: a.authConfig?.id ?? null,
});

/** Composio has no tool of that name (the SDK's own error for it, or an HTTP 404). */
function toolNotFound(err: unknown): boolean {
  const e = err as { name?: string; code?: string; status?: number; cause?: unknown } | null;
  const cause = e?.cause as { status?: number } | number | undefined;
  return (
    e?.code === 'TS-SDK::TOOL_NOT_FOUND' ||
    e?.name === 'ComposioToolNotFoundError' ||
    e?.status === 404 ||
    cause === 404 ||
    (typeof cause === 'object' && cause?.status === 404)
  );
}

interface RawTool {
  slug: string;
  name: string;
  description?: string;
  toolkit?: { slug?: string };
  inputParameters?: Record<string, unknown>;
  tags?: string[];
}

const toTool = (t: RawTool): ComposioTool => ({
  slug: t.slug,
  toolkit: t.toolkit?.slug ?? '',
  name: t.name,
  description: t.description ?? '',
  inputParameters: t.inputParameters ?? {},
  tags: t.tags ?? [],
});

/** Composio has no such connected account (an HTTP 404, or the SDK's own code for it). */
function accountNotFound(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return e?.status === 404 || e?.code === 'CONNECTED_ACCOUNT_NOT_FOUND';
}

/**
 * One SDK client per process (per key): making one is not free, and each new client used to ask
 * npm whether a newer SDK exists (`disableVersionCheck`), on every call to Composio.
 */
let client: { apiKey: string; sdk: Composio } | null = null;

function sdk(): Composio {
  const apiKey = config().COMPOSIO_API_KEY;
  if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set');
  if (client?.apiKey !== apiKey)
    client = { apiKey, sdk: new Composio({ apiKey, disableVersionCheck: true }) };
  return client.sdk;
}

/**
 * The inputs Composio marks as a file to upload, given as "no file" (empty text or null): sent as
 * no input at all, which is what Composio expects (the SDK's own execute does the same).
 */
export function withoutEmptyFiles(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const props = schema.properties;
  if (!props || typeof props !== 'object') return args;
  const out = { ...args };
  for (const [name, input] of Object.entries(
    props as Record<string, { file_uploadable?: unknown }>,
  ))
    if (input?.file_uploadable === true && (out[name] === '' || out[name] === null))
      delete out[name];
  return out;
}

const realApi: ComposioApi = {
  async connectLink(userId, authConfigId, callbackUrl) {
    // allowMultiple: the web app offers "Add account" for an app that already has one.
    const req = await sdk().connectedAccounts.link(userId, authConfigId, {
      callbackUrl,
      allowMultiple: true,
    });
    return { accountId: req.id, redirectUrl: req.redirectUrl ?? '' };
  },
  async connectDirect(userId, authConfigId, authScheme, callbackUrl) {
    // Composio's white-labeling guide: `long_redirect_url` makes the link the provider's own
    // page instead of a short backend.composio.dev link that forwards to it.
    const state =
      authScheme === 'OAUTH1'
        ? AuthScheme.OAuth1({ long_redirect_url: true })
        : AuthScheme.OAuth2({ long_redirect_url: true });
    const req = await sdk().connectedAccounts.initiate(userId, authConfigId, {
      callbackUrl,
      allowMultiple: true,
      config: state,
    });
    return { accountId: req.id, redirectUrl: req.redirectUrl ?? '' };
  },
  async authConfig(authConfigId) {
    const ac = await sdk().authConfigs.get(authConfigId);
    // Composio leaves the flag out on some setups; reading that as "shared" is the safe side,
    // because a Connect Link works for both kinds.
    return { composioManaged: ac.isComposioManaged !== false, authScheme: ac.authScheme ?? null };
  },
  async authConfigScopes(authConfigId) {
    const ac = await sdk().authConfigs.get(authConfigId);
    return scopesFromCredentials(ac.credentials);
  },
  async toolkitScopes(toolkit, tools) {
    const details = await sdk().toolkits.get(toolkit);
    const required = requiredScopesFrom(details.authConfigDetails);
    // Composio marks the recommendation beta: without it, the required scopes are still shown.
    const recommended = await sdk()
      .toolkits.recommendScopes(toolkit, { tools, authScheme: 'OAUTH2' })
      .then((r) => r.scopes)
      .catch(() => null);
    return {
      required,
      leastPrivilege: recommended ? [...recommended.leastPrivilege] : null,
      fewest: recommended ? [...recommended.fewest] : null,
    };
  },
  async setUpManagedAuthConfig(toolkit, name) {
    const found = await sdk().authConfigs.list({ toolkit, isComposioManaged: true });
    const ready = pickManagedSetup(
      found.items.map((ac) => ({ id: ac.id, status: ac.status, toolkit: ac.toolkit?.slug })),
      toolkit,
    );
    if (ready) return { id: ready };
    const made = await sdk().authConfigs.create(toolkit, {
      type: 'use_composio_managed_auth',
      name,
    });
    return { id: made.id };
  },
  async listAccounts(userId) {
    const res = (await sdk().connectedAccounts.list({ userIds: [userId] })) as unknown as {
      items: RawAccount[];
    };
    return res.items.map(toAccount);
  },
  async account(accountId) {
    try {
      return toAccount((await sdk().connectedAccounts.get(accountId)) as unknown as RawAccount);
    } catch (err) {
      if (accountNotFound(err)) return null;
      throw err;
    }
  },
  async deleteAccount(accountId) {
    try {
      await sdk().connectedAccounts.delete(accountId);
    } catch (err) {
      // Already gone (an earlier try got that far): that is what was asked.
      if (accountNotFound(err)) return;
      throw err;
    }
  },
  async accessToken(accountId) {
    const acc = (await sdk().connectedAccounts.get(accountId)) as unknown as {
      state?: { val?: Record<string, unknown> };
      data?: Record<string, unknown>;
    };
    const token = acc.state?.val?.access_token ?? acc.data?.access_token;
    // A masked token looks like "gho_abcd..." or has stars in it: not usable.
    if (typeof token !== 'string' || token.length < 20 || /\.\.\.|\*/.test(token)) return null;
    return token;
  },
  async listTools(toolkits) {
    if (toolkits.length === 0) return [];
    const tools = (await sdk().tools.getRawComposioTools({
      toolkits,
      limit: 200,
    } as never)) as unknown as RawTool[];
    return tools.map(toTool);
  },
  async tool(slug) {
    try {
      return toTool((await sdk().tools.getRawComposioToolBySlug(slug)) as unknown as RawTool);
    } catch (err) {
      if (toolNotFound(err)) return null;
      throw err;
    }
  },
  async toolTags(slug) {
    const tool = (await sdk().tools.getRawComposioToolBySlug(slug)) as unknown as {
      tags?: string[];
    };
    return tool.tags ?? [];
  },
  async execute(slug, input) {
    // The SDK's own execute asks Composio for the action's description before every run (about
    // 0.3 s). The description is kept here instead (`describedTool`: from the app's listing, or
    // asked once per action for a while), and the run goes straight to Composio's execute
    // endpoint, as the SDK sends it: the latest version, no retry (a write must not run twice).
    const tool = await describedTool(slug);
    const res = await sdk()
      .getClient()
      .tools.execute(
        tool?.slug ?? slug,
        {
          user_id: input.userId,
          ...(input.connectedAccountId ? { connected_account_id: input.connectedAccountId } : {}),
          arguments: tool
            ? withoutEmptyFiles(input.arguments, tool.inputParameters)
            : input.arguments,
          version: 'latest',
        },
        { maxRetries: 0 },
      );
    return { successful: res.successful, data: res.data, error: res.error ?? null };
  },
  async createTrigger(userId, triggerSlug, connectedAccountId, triggerConfig) {
    const res = (await sdk().triggers.create(userId, triggerSlug, {
      ...(connectedAccountId ? { connectedAccountId } : {}),
      triggerConfig,
    } as never)) as unknown as { triggerId: string };
    return { triggerId: res.triggerId };
  },
  async deleteTrigger(triggerId) {
    await sdk().triggers.delete(triggerId);
  },
  async listTriggers(filter) {
    const { triggerIds, connectedAccountIds } = filter;
    // An empty filter would list every trigger in the project.
    if (!triggerIds?.length && !connectedAccountIds?.length) return [];
    const out: ComposioTriggerInstance[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await sdk().triggers.listActive({
        ...(triggerIds?.length ? { triggerIds } : {}),
        ...(connectedAccountIds?.length ? { connectedAccountIds } : {}),
        showDisabled: true,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      for (const t of res.items)
        out.push({
          id: t.id,
          connectedAccountId: t.connectedAccountId,
          slug: t.triggerName,
          config: t.triggerConfig ?? {},
        });
      cursor = res.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return out;
  },
  async verifyWebhook(input) {
    const secret = config().COMPOSIO_WEBHOOK_SECRET;
    if (!secret) throw new Error('COMPOSIO_WEBHOOK_SECRET is not set');
    const result = await sdk().triggers.verifyWebhook({
      id: input.webhookId,
      payload: input.rawBody,
      timestamp: input.webhookTimestamp,
      signature: input.signature,
      secret,
    });
    const raw = result.rawPayload as unknown as { type?: string; data?: Record<string, unknown> };
    if (raw.type && raw.type.includes('connected_account')) {
      const status = raw.type.endsWith('expired')
        ? 'expired'
        : raw.type.endsWith('failed')
          ? 'error'
          : 'active';
      return { kind: 'connection', accountId: String(raw.data?.id ?? ''), status };
    }
    const p = result.payload;
    if (!p?.triggerSlug) return { kind: 'other', type: raw.type ?? 'unknown' };
    return {
      kind: 'trigger',
      event: {
        triggerSlug: p.triggerSlug,
        toolkit: p.toolkitSlug,
        userId: p.userId,
        connectedAccountId: p.metadata?.connectedAccount?.id ?? null,
        triggerId: p.id ?? null,
        payload: p.payload ?? {},
      },
    };
  },
};

let api: ComposioApi = realApi;
/** A tool's tags don't change between calls: asked once per tool, kept for the process. */
const tagCache = new Map<string, string[]>();
/**
 * Whether a setup is Composio's shared sign-in or our own never changes for one id (switching
 * means a new setup with a new id), so it is asked once per id and kept for the process.
 */
const authConfigCache = new Map<string, AuthConfigInfo>();

/**
 * An app's actions are the same for every user and change only when Composio changes the app, so
 * one listing serves every `list_app_actions` call for a while instead of one request to Composio
 * per app per call. A failed listing is not kept.
 */
export const TOOL_LIST_TTL_MS = 10 * 60_000;
const toolListCache = new Map<string, { at: number; tools: ComposioTool[] }>();
/** One action asked by its name (`actionTool`), kept as long as a listing. */
const toolCache = new Map<string, { at: number; tool: ComposioTool | null }>();

export function composio(): ComposioApi {
  return api;
}

/** Tests: swap in a fake Composio. */
export function setComposioApi(fake: ComposioApi | undefined): void {
  api = fake ?? realApi;
  tagCache.clear();
  authConfigCache.clear();
  toolListCache.clear();
  toolCache.clear();
}

/** One app's actions (its Composio toolkit), from the last listing when it is recent enough. */
export async function toolkitTools(toolkit: string, now = Date.now()): Promise<ComposioTool[]> {
  const key = toolkit.toLowerCase();
  const kept = toolListCache.get(key);
  if (kept && now - kept.at < TOOL_LIST_TTL_MS) return kept.tools;
  const tools = await api.listTools([toolkit]);
  toolListCache.set(key, { at: now, tools });
  return tools;
}

/**
 * One action as Composio describes it, with its input schema. From its app's listing when it is
 * there; otherwise asked by its name, because a listing holds at most 200 actions and GitHub has
 * more. Null: Composio has no action of that name. Throws when Composio can't be asked.
 */
export async function actionTool(
  toolkit: string,
  slug: string,
  now = Date.now(),
): Promise<ComposioTool | null> {
  const key = slug.toUpperCase();
  const listed = await toolkitTools(toolkit, now).catch(() => null);
  const found = listed?.find((t) => t.slug.toUpperCase() === key);
  if (found) return found;
  const kept = toolCache.get(key);
  if (kept && now - kept.at < TOOL_LIST_TTL_MS) return kept.tool;
  const tool = await api.tool(key);
  toolCache.set(key, { at: now, tool });
  return tool;
}

/**
 * One action's description for running it: from its app's listing when that is kept, else asked by
 * its name and kept as long as a listing. Never lists an app for this. Null: Composio has no such
 * action (its execute then says so).
 */
async function describedTool(slug: string, now = Date.now()): Promise<ComposioTool | null> {
  const key = slug.toUpperCase();
  for (const { at, tools } of toolListCache.values()) {
    if (now - at >= TOOL_LIST_TTL_MS) continue;
    const found = tools.find((t) => t.slug.toUpperCase() === key);
    if (found) return found;
  }
  const kept = toolCache.get(key);
  if (kept && now - kept.at < TOOL_LIST_TTL_MS) return kept.tool;
  const tool = await api.tool(key);
  toolCache.set(key, { at: now, tool });
  return tool;
}

/** What Composio says about a setup, or null when it can't be asked right now (nothing cached). */
export async function authConfigInfo(authConfigId: string): Promise<AuthConfigInfo | null> {
  const cached = authConfigCache.get(authConfigId);
  if (cached) return cached;
  try {
    const info = await api.authConfig(authConfigId);
    authConfigCache.set(authConfigId, info);
    return info;
  } catch {
    return null;
  }
}

/** Tells the cache about a setup the server just made itself (Composio's shared sign-in). */
export function rememberAuthConfig(authConfigId: string, info: AuthConfigInfo): void {
  authConfigCache.set(authConfigId, info);
}

/** A tool's Composio tags, or null when Composio can't be asked right now (nothing is cached). */
export async function toolTags(slug: string): Promise<string[] | null> {
  const key = slug.toUpperCase();
  const cached = tagCache.get(key);
  if (cached) return cached;
  try {
    const tags = await api.toolTags(key);
    tagCache.set(key, tags);
    return tags;
  } catch {
    return null;
  }
}

/**
 * The setup id named for an app in the server's settings (COMPOSIO_AUTH_CONFIGS =
 * {"gmail":"ac_…", …}). A setup the server made itself is in the `composio_auth_configs` table
 * instead (apps.ts).
 */
export function authConfigFor(appSlug: string): string | undefined {
  const raw = config().COMPOSIO_AUTH_CONFIGS;
  if (!raw) return undefined;
  try {
    return (JSON.parse(raw) as Record<string, string>)[appSlug];
  } catch {
    return undefined;
  }
}

/**
 * The trial setup named for an app (COMPOSIO_TRIAL_AUTH_CONFIGS = {"googlecalendar":"ac_…"}).
 * Only for the users in COMPOSIO_TRIAL_USERS; apps.ts decides who they are.
 */
export function trialAuthConfigFor(appSlug: string): string | undefined {
  return config().COMPOSIO_TRIAL_AUTH_CONFIGS[appSlug];
}

/**
 * Where `/oauth/callback` sends the browser on to: Composio's own callback, with the provider's
 * query string unchanged (`search` starts with "?" or is empty). Used for a sign-in app of our
 * own whose redirect address is ours (Composio's white-labeling guide, "the return redirect").
 */
export function composioCallbackUrl(search: string): string {
  return `${config().COMPOSIO_API_URL.replace(/\/+$/, '')}/api/v3/toolkits/auth/callback${search}`;
}
