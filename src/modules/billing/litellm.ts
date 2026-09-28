// LiteLLM virtual keys: one per user, limited to the plan's models, with a budget equal to the
// user's balance in dollars of real cost (HLD 7.5). HTTP to LITELLM_URL with the master key.
//
// Budget note: LiteLLM compares a key's `max_budget` with its *cumulative* `spend`, so "budget =
// balance" is set as `max_budget = spend so far + balance in real dollars`, and "budget 0" as
// `max_budget = spend so far` (no room left).
import { eq, isNotNull } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { decryptSecret, encryptSecret } from '../../shared/crypto.ts';
import { db } from '../../shared/db/client.ts';
import { logger } from '../../shared/logger.ts';
import { getUser } from '../auth/users.ts';
import { hasByokKey } from '../integrations/byok.ts';
import { getBalance } from './credits.ts';
import {
  aliasesForPlan,
  creditsToRealUsd,
  keyModelsForPlan,
  microToUsd,
  usdToMicro,
} from './plans.ts';
import { litellmKeys } from './schema.ts';

export interface KeySpend {
  /** Cumulative real cost in USD. */
  spend: number;
  /** Cumulative spend per model name. */
  modelSpend: Record<string, number>;
}

export interface KeyPatch {
  models?: string[];
  aliases?: Record<string, string>;
  maxBudget?: number | null;
}

export interface LiteLLMClient {
  generateKey(input: {
    alias: string;
    userId: string;
    models: string[];
    /** Key-level model aliases, e.g. { 'agent-default': 'cheap' }. */
    aliases: Record<string, string>;
    maxBudget: number | null;
  }): Promise<{ key: string }>;
  updateKey(key: string, patch: KeyPatch): Promise<void>;
  deleteKey(key: string): Promise<void>;
  getKeySpend(key: string): Promise<KeySpend>;
  /** Spend of one key in [start, end) (used to reverse a failed turn). */
  getSpendBetween(key: string, start: Date, end: Date): Promise<KeySpend>;
}

class HttpLiteLLM implements LiteLLMClient {
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const c = config();
    if (!c.LITELLM_MASTER_KEY) throw new Error('LITELLM_MASTER_KEY is not set');
    const res = await fetch(new URL(path, c.LITELLM_URL), {
      method,
      headers: {
        authorization: `Bearer ${c.LITELLM_MASTER_KEY}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    // Never include the response body: it can echo the key.
    if (!res.ok) throw new Error(`LiteLLM ${method} ${path.split('?')[0]} failed: ${res.status}`);
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  async generateKey(input: Parameters<LiteLLMClient['generateKey']>[0]) {
    const out = await this.request<{ key: string }>('POST', '/key/generate', {
      key_alias: input.alias,
      user_id: input.userId,
      models: input.models,
      aliases: input.aliases,
      max_budget: input.maxBudget,
      metadata: { user_id: input.userId },
    });
    return { key: out.key };
  }

  async updateKey(key: string, patch: KeyPatch) {
    await this.request('POST', '/key/update', {
      key,
      ...(patch.models ? { models: patch.models } : {}),
      ...(patch.aliases ? { aliases: patch.aliases } : {}),
      ...(patch.maxBudget !== undefined ? { max_budget: patch.maxBudget } : {}),
    });
  }

  async deleteKey(key: string) {
    await this.request('POST', '/key/delete', { keys: [key] });
  }

  async getKeySpend(key: string): Promise<KeySpend> {
    const out = await this.request<{
      info?: { spend?: number; model_spend?: Record<string, number> };
    }>('GET', `/key/info?key=${encodeURIComponent(key)}`);
    return { spend: out.info?.spend ?? 0, modelSpend: out.info?.model_spend ?? {} };
  }

  async getSpendBetween(key: string, start: Date, end: Date): Promise<KeySpend> {
    const q = new URLSearchParams({
      api_key: key,
      start_date: start.toISOString(),
      end_date: end.toISOString(),
    });
    const logs = await this.request<Array<{ spend?: number; model?: string; startTime?: string }>>(
      'GET',
      `/spend/logs?${q}`,
    );
    const out: KeySpend = { spend: 0, modelSpend: {} };
    for (const l of Array.isArray(logs) ? logs : []) {
      const at = l.startTime ? new Date(l.startTime).getTime() : NaN;
      if (Number.isFinite(at) && (at < start.getTime() || at >= end.getTime())) continue;
      const s = l.spend ?? 0;
      out.spend += s;
      if (l.model) out.modelSpend[l.model] = (out.modelSpend[l.model] ?? 0) + s;
    }
    return out;
  }
}

let client: LiteLLMClient | undefined;

export function litellm(): LiteLLMClient {
  client ??= new HttpLiteLLM();
  return client;
}

/** Tests: swap in a fake LiteLLM. */
export function setLiteLLMClient(fake: LiteLLMClient | undefined): void {
  client = fake;
}

// --- per-user keys ----------------------------------------------------------------------------

export type LiteLLMKeyRow = typeof litellmKeys.$inferSelect;

export async function getKeyRow(userId: string): Promise<LiteLLMKeyRow | undefined> {
  const [row] = await db().select().from(litellmKeys).where(eq(litellmKeys.userId, userId));
  return row && !row.revokedAt ? row : undefined;
}

/** The dollars of real cost the user may still spend (null = no cap, for bring-your-own-key). */
async function remainingBudgetUsd(userId: string): Promise<number | null> {
  const balance = await getBalance(userId);
  if (balance <= 0) return 0;
  // BYOK: AI isn't paid in credits, so it isn't capped by the balance (awake time still is).
  if (await hasByokKey(userId)) return null;
  return creditsToRealUsd(balance);
}

/** Creates the user's key if they don't have one (idempotent). */
export async function ensureLiteLLMKey(userId: string): Promise<LiteLLMKeyRow> {
  const existing = await getKeyRow(userId);
  if (existing) return existing;
  const user = await getUser(userId);
  if (!user) throw new Error(`user ${userId} not found`);
  const models = keyModelsForPlan(user.plan);
  const remaining = await remainingBudgetUsd(userId);
  const alias = `user-${userId}`;
  const { key } = await litellm().generateKey({
    alias,
    userId,
    models,
    aliases: aliasesForPlan(user.plan),
    maxBudget: remaining,
  });
  const values = {
    userId,
    keyEncrypted: encryptSecret(key),
    keyAlias: alias,
    models,
    maxBudgetMicroUsd: remaining === null ? null : usdToMicro(remaining),
    syncedSpendMicroUsd: 0,
    syncedModelSpend: {},
    revokedAt: null,
    updatedAt: new Date(),
  };
  const [row] = await db()
    .insert(litellmKeys)
    .values(values)
    .onConflictDoUpdate({
      target: litellmKeys.userId,
      set: values,
      // Only a revoked key is replaced; a live one means another onboarding won the race.
      setWhere: isNotNull(litellmKeys.revokedAt),
    })
    .returning();
  if (row?.keyEncrypted === values.keyEncrypted) return row;
  // Lost a race with another onboarding: keep theirs, drop ours.
  await litellm()
    .deleteKey(key)
    .catch(() => {});
  return (await getKeyRow(userId))!;
}

/** The user's key in plaintext (for the sandbox config). Creates it if missing. */
export async function getLiteLLMKey(userId: string): Promise<string> {
  const row = await ensureLiteLLMKey(userId);
  return decryptSecret(row.keyEncrypted);
}

export async function revokeLiteLLMKey(userId: string): Promise<void> {
  const row = await getKeyRow(userId);
  if (!row) return;
  await litellm().deleteKey(decryptSecret(row.keyEncrypted));
  await db()
    .update(litellmKeys)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(litellmKeys.userId, userId));
}

/**
 * Sets the key's models + agent alias (by plan) and budget (by balance). Pass `spendUsd` when
 * the caller has just read the key's spend, to save a round trip. Safe to call any time.
 */
export async function refreshBudget(userId: string, opts: { spendUsd?: number } = {}) {
  const row = await getKeyRow(userId);
  if (!row) return;
  const user = await getUser(userId);
  if (!user) return;
  const key = decryptSecret(row.keyEncrypted);
  const models = keyModelsForPlan(user.plan);
  const remaining = await remainingBudgetUsd(userId);
  const spend = opts.spendUsd ?? (await litellm().getKeySpend(key)).spend;
  const maxBudget = remaining === null ? null : microToUsd(usdToMicro(spend + remaining));
  const maxMicro = maxBudget === null ? null : usdToMicro(maxBudget);
  const sameModels = JSON.stringify(row.models) === JSON.stringify(models);
  if (sameModels && row.maxBudgetMicroUsd === maxMicro) return;
  // Models and the agent alias change together with the plan.
  await litellm().updateKey(key, { models, aliases: aliasesForPlan(user.plan), maxBudget });
  await db()
    .update(litellmKeys)
    .set({ models, maxBudgetMicroUsd: maxMicro, updatedAt: new Date() })
    .where(eq(litellmKeys.userId, userId));
}

/** Best effort: a failure is logged and fixed by the next usage sync. */
export async function refreshBudgetQuietly(userId: string): Promise<void> {
  try {
    await refreshBudget(userId);
  } catch (err) {
    logger().warn({ userId, err: (err as Error).message }, 'LiteLLM budget update failed');
  }
}
