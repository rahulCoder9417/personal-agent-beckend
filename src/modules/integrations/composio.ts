import { Composio } from '@composio/core';
import { config } from '../../shared/config.ts';

export interface ComposioTool {
  slug: string;
  toolkit: string;
  name: string;
  description: string;
  inputParameters: Record<string, unknown>;
}

export interface ComposioAccount {
  id: string;
  toolkit: string;
  status: string;
  label: string | null;
}

export interface ComposioTriggerEvent {
  triggerSlug: string;
  toolkit: string;
  userId: string;
  connectedAccountId: string | null;
  triggerId: string | null;
  payload: Record<string, unknown>;
}

/** The slice of Composio we use. Real SDK below; tests install a fake. */
export interface ComposioApi {
  connectLink(
    userId: string,
    authConfigId: string,
    callbackUrl: string,
  ): Promise<{ accountId: string; redirectUrl: string }>;
  listAccounts(userId: string): Promise<ComposioAccount[]>;
  deleteAccount(accountId: string): Promise<void>;
  /**
   * The provider OAuth access token of one connected account, or null when Composio doesn't
   * return it (missing, or masked by the project's "mask connected account secrets" setting).
   * Used only by the git gateway; the token never leaves the api.
   */
  accessToken(accountId: string): Promise<string | null>;
  listTools(toolkits: string[]): Promise<ComposioTool[]>;
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

function sdk(): Composio {
  const apiKey = config().COMPOSIO_API_KEY;
  if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set');
  return new Composio({ apiKey });
}

const realApi: ComposioApi = {
  async connectLink(userId, authConfigId, callbackUrl) {
    const req = await sdk().connectedAccounts.link(userId, authConfigId, { callbackUrl });
    return { accountId: req.id, redirectUrl: req.redirectUrl ?? '' };
  },
  async listAccounts(userId) {
    const res = (await sdk().connectedAccounts.list({ userIds: [userId] })) as unknown as {
      items: Array<{
        id: string;
        status: string;
        toolkit?: { slug?: string };
        data?: Record<string, unknown>;
      }>;
    };
    return res.items.map((a) => ({
      id: a.id,
      toolkit: a.toolkit?.slug ?? '',
      status: a.status,
      label: (a.data?.email as string | undefined) ?? null,
    }));
  },
  async deleteAccount(accountId) {
    await sdk().connectedAccounts.delete(accountId);
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
    } as never)) as unknown as Array<{
      slug: string;
      name: string;
      description?: string;
      toolkit?: { slug?: string };
      inputParameters?: Record<string, unknown>;
    }>;
    return tools.map((t) => ({
      slug: t.slug,
      toolkit: t.toolkit?.slug ?? '',
      name: t.name,
      description: t.description ?? '',
      inputParameters: t.inputParameters ?? {},
    }));
  },
  async execute(slug, input) {
    const res = await sdk().tools.execute(slug, {
      userId: input.userId,
      ...(input.connectedAccountId ? { connectedAccountId: input.connectedAccountId } : {}),
      arguments: input.arguments,
      dangerouslySkipVersionCheck: true,
    } as never);
    return { successful: res.successful, data: res.data, error: res.error };
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

export function composio(): ComposioApi {
  return api;
}

/** Tests: swap in a fake Composio. */
export function setComposioApi(fake: ComposioApi | undefined): void {
  api = fake ?? realApi;
}

/** Composio auth config id per app slug (COMPOSIO_AUTH_CONFIGS = {"gmail":"ac_…", …}). */
export function authConfigFor(appSlug: string): string | undefined {
  const raw = config().COMPOSIO_AUTH_CONFIGS;
  if (!raw) return undefined;
  try {
    return (JSON.parse(raw) as Record<string, string>)[appSlug];
  } catch {
    return undefined;
  }
}
