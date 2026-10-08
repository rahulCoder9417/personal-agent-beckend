// LiteLLM virtual keys: one per user, limited to the plan's models, with a budget equal to the
// user's balance in dollars of real cost (HLD 7.5). HTTP to LITELLM_URL with the master key.
//
// Budget note: LiteLLM compares a key's `max_budget` with its *cumulative* `spend`, so "budget =
// balance" is set as `max_budget = spend so far + balance in real dollars`, and "budget 0" as
// `max_budget = spend so far` (no room left).
//
// Bring your own key (HLD 7.1): while the user's own provider key pays, LiteLLM holds that key in
// a model of its own (stored encrypted in LiteLLM's database, never shown by its API), the user's
// LiteLLM key may call only that model, and the names the container and the quick replies ask for
// both mean it. So every model call is made with the user's key, and the provider key still never
// enters the container. When the own key stops paying, the key goes back to the plan and the
// model is deleted.
import { randomUUID } from 'node:crypto';
import { eq, isNotNull } from 'drizzle-orm';
import { config } from '../../shared/config.ts';
import { decryptSecret, encryptSecret, keyedHashHex, sha256Hex } from '../../shared/crypto.ts';
import { db } from '../../shared/db/client.ts';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { getUser } from '../auth/users.ts';
import { byokFingerprints, ownKeyForAi, type ByokProvider } from '../integrations/byok.ts';
import { ownKeyPaysForAi } from '../orchestrator/agent-settings.ts';
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

/** A model in LiteLLM that carries a provider key (the user's own key). */
export interface OwnModel {
  /** Model name = model id in LiteLLM. */
  id: string;
  /** LiteLLM's `<provider>/<provider's model id>`, e.g. `anthropic/claude-sonnet-5-5`. */
  model: string;
  /** The provider key. Never log it. */
  apiKey: string;
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
  /** Spend of one key in [start, end), from LiteLLM's spend log (used to refund a failed turn). */
  getSpendBetween(key: string, start: Date, end: Date): Promise<KeySpend>;
  /** Creates the model, or replaces it in place. `exists`: we believe LiteLLM has it already. */
  saveModel(model: OwnModel, opts: { exists: boolean }): Promise<void>;
  /** Deletes the model. One that is already gone counts as deleted. */
  deleteModel(id: string): Promise<void>;
}

interface SpendLogPage {
  data?: Array<{ spend?: number; model?: string; model_group?: string; startTime?: string }>;
  total_pages?: number;
  total_is_capped?: boolean;
}

const SPEND_LOG_PAGE_SIZE = 1000;
/** 10,000 rows. One key in one turn's minutes never comes near it. */
const SPEND_LOG_MAX_PAGES = 10;

/** `YYYY-MM-DD HH:MM:SS` in UTC, rounded to the whole second outward. */
function spendLogTime(at: Date, round: 'floor' | 'ceil'): string {
  const ms = round === 'floor' ? Math.floor(at.getTime() / 1000) : Math.ceil(at.getTime() / 1000);
  return new Date(ms * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** LiteLLM's times are UTC; one written without a zone is read as UTC, not local time. */
function parseUtc(s: string): number {
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`).getTime();
}

/** A LiteLLM answer that wasn't 2xx. Carries only the status: the body can echo a key. */
export class LiteLLMHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
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
    if (!res.ok) {
      throw new LiteLLMHttpError(
        res.status,
        `LiteLLM ${method} ${path.split('?')[0]} failed: ${res.status}`,
      );
    }
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

  // LiteLLM (read in the source the server runs, 1.103.1): the old `/spend/logs` takes dates only
  // (`YYYY-MM-DD`). A full timestamp makes it answer 500, and with dates it returns one summary
  // row per day. It is marked deprecated. `/spend/logs/v2` takes `YYYY-MM-DD HH:MM:SS` in UTC,
  // both ends included, and filters `api_key` on the stored value: the SHA-256 of the key. It
  // pages, at most 1,000 rows a page.
  async getSpendBetween(key: string, start: Date, end: Date): Promise<KeySpend> {
    const out: KeySpend = { spend: 0, modelSpend: {} };
    for (let page = 1; ; page++) {
      const q = new URLSearchParams({
        api_key: sha256Hex(key),
        start_date: spendLogTime(start, 'floor'),
        end_date: spendLogTime(end, 'ceil'),
        page: String(page),
        page_size: String(SPEND_LOG_PAGE_SIZE),
      });
      const res = await this.request<SpendLogPage>('GET', `/spend/logs/v2?${q}`);
      if (!Array.isArray(res.data)) throw new Error('LiteLLM GET /spend/logs/v2: no data');
      // Rows we would not read: the sum would be too low.
      if (res.total_is_capped || (res.total_pages ?? 0) > SPEND_LOG_MAX_PAGES)
        throw new Error('LiteLLM GET /spend/logs/v2: too many rows');
      for (const l of res.data) {
        // The query is to the second; the turn's own window is to the millisecond.
        const at = l.startTime ? parseUtc(l.startTime) : NaN;
        if (Number.isFinite(at) && (at < start.getTime() || at >= end.getTime())) continue;
        const s = Number(l.spend ?? 0);
        out.spend += s;
        const model = l.model_group || l.model; // model_group is our name for it, e.g. `cheap`
        if (model) out.modelSpend[model] = (out.modelSpend[model] ?? 0) + s;
      }
      if (page >= (res.total_pages ?? 0)) return out;
    }
  }

  // LiteLLM (checked on 1.104.2): /model/update on a missing id answers 400; /model/new on an id
  // it already has answers 500; /model/delete on a missing id answers 400. Needs
  // STORE_MODEL_IN_DB=True. The key is stored encrypted with LITELLM_SALT_KEY, or the master key
  // when that isn't set.
  async saveModel(m: OwnModel, opts: { exists: boolean }) {
    const body = {
      model_name: m.id,
      litellm_params: { model: m.model, api_key: m.apiKey },
      model_info: { id: m.id },
    };
    const update = () => this.request('POST', '/model/update', body);
    const create = () => this.request('POST', '/model/new', body);
    if (opts.exists) {
      // Replace in place: the model stays callable throughout.
      try {
        await update();
      } catch (err) {
        if (!(err instanceof LiteLLMHttpError && err.status === 400)) throw err;
        await create(); // it was gone after all
      }
      return;
    }
    try {
      await create();
    } catch (err) {
      if (!(err instanceof LiteLLMHttpError)) throw err;
      await update(); // it was there after all
    }
  }

  async deleteModel(id: string) {
    try {
      await this.request('POST', '/model/delete', { id });
    } catch (err) {
      if (!(err instanceof LiteLLMHttpError && err.status === 400)) throw err;
    }
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

/**
 * The name of the model that holds this user's own key. Stable per user, and not guessable from
 * the user id: any key may list the model names in LiteLLM (never the provider keys).
 */
export function ownModelName(userId: string): string {
  return `own-${keyedHashHex(`litellm-own-model:${userId}`).slice(0, 24)}`;
}

/** Does this key send the user's AI to their own provider key right now? */
export function routesToOwnKey(row: Pick<LiteLLMKeyRow, 'models' | 'ownModelId'>): boolean {
  return row.ownModelId !== null && row.models.includes(row.ownModelId);
}

/** While the own key pays: the agent's fixed name and the quick-reply model both mean it. */
function ownKeyAliases(modelId: string): Record<string, string> {
  const c = config();
  return { [c.LITELLM_AGENT_MODEL]: modelId, [c.LITELLM_CHEAP_MODEL]: modelId };
}

/** Creates the user's key if they don't have one (idempotent). It starts on the plan. */
export async function ensureLiteLLMKey(userId: string): Promise<LiteLLMKeyRow> {
  const existing = await getKeyRow(userId);
  if (existing) return existing;
  const user = await getUser(userId);
  if (!user) throw new Error(`user ${userId} not found`);
  const models = keyModelsForPlan(user.plan);
  const balance = await getBalance(userId);
  const remaining = balance <= 0 ? 0 : creditsToRealUsd(balance);
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
    maxBudgetMicroUsd: usdToMicro(remaining),
    syncedSpendMicroUsd: 0,
    syncedModelSpend: {},
    ownModelId: null,
    ownModelFingerprint: null,
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

/** Account deletion: the stored own key first (so a retry still finds it), then the key. */
export async function revokeLiteLLMKey(userId: string): Promise<void> {
  const row = await getKeyRow(userId);
  if (!row) return;
  if (row.ownModelId) await litellm().deleteModel(row.ownModelId);
  await litellm().deleteKey(decryptSecret(row.keyEncrypted));
  await db()
    .update(litellmKeys)
    .set({
      revokedAt: new Date(),
      ownModelId: null,
      ownModelFingerprint: null,
      updatedAt: new Date(),
    })
    .where(eq(litellmKeys.userId, userId));
}

// One sync per user at a time, so two of them can't leave our record and LiteLLM disagreeing.
const SYNC_LOCK_TTL_MS = 90_000;
const SYNC_LOCK_WAIT_MS = 30_000;
const syncLockKey = (userId: string) => `lock:litellm-key:${userId}`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

async function withSyncLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const deadline = Date.now() + SYNC_LOCK_WAIT_MS;
  while ((await redis().set(syncLockKey(userId), token, 'PX', SYNC_LOCK_TTL_MS, 'NX')) !== 'OK') {
    if (Date.now() > deadline) throw new Error('LiteLLM key sync is busy');
    await new Promise((r) => setTimeout(r, 100));
  }
  try {
    return await fn();
  } finally {
    await redis()
      .eval(RELEASE, 1, syncLockKey(userId), token)
      .catch(() => {});
  }
}

/**
 * Brings the user's LiteLLM key in line with what pays for their AI. Safe to call any time and
 * twice: LiteLLM is called only for what differs from the state last applied.
 *
 * 1. The own key pays: LiteLLM gets (or keeps) a model holding the key that pays, before the key
 *    is pointed at it.
 * 2. The key: with the own key, only the agent name and that model, both names aliased to it, and
 *    no AI budget; otherwise the plan's models and alias with budget = balance. At a balance of 0
 *    the budget is 0 either way (awake time is still paid in credits).
 * 3. The own key doesn't pay: the model holding it is deleted, after the key stopped using it.
 *    If only this step fails, the key is no longer used and the next sync deletes the model.
 *
 * Pass `spendUsd` when the caller has just read the key's spend. Throws if LiteLLM can't be
 * updated in steps 1 or 2.
 */
export async function syncLiteLLMKey(
  userId: string,
  opts: { spendUsd?: number } = {},
): Promise<void> {
  await withSyncLock(userId, () => applyKeyState(userId, opts));
}

async function applyKeyState(userId: string, opts: { spendUsd?: number }): Promise<void> {
  const row = await getKeyRow(userId);
  if (!row) return;
  const user = await getUser(userId);
  if (!user) return;
  const key = decryptSecret(row.keyEncrypted);
  const own = (await ownKeyPaysForAi(userId)) ? await ownKeyForAi(userId) : undefined;
  const setRow = (values: Partial<LiteLLMKeyRow>) =>
    db()
      .update(litellmKeys)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(litellmKeys.userId, userId));

  // 1. The own key, stored in LiteLLM.
  let ownModelId = row.ownModelId;
  if (own && row.ownModelFingerprint !== own.fingerprint) {
    const id = row.ownModelId ?? ownModelName(userId);
    await litellm().saveModel(
      { id, model: `${own.provider}/${own.model}`, apiKey: own.apiKey },
      { exists: row.ownModelId !== null },
    );
    ownModelId = id;
    await setRow({ ownModelId: id, ownModelFingerprint: own.fingerprint });
  }

  // 2. The key's models, aliases and budget.
  const balance = await getBalance(userId);
  const spend = opts.spendUsd ?? (await litellm().getKeySpend(key)).spend;
  const target =
    own && ownModelId
      ? {
          models: [config().LITELLM_AGENT_MODEL, ownModelId],
          aliases: ownKeyAliases(ownModelId),
          remaining: balance <= 0 ? 0 : null,
        }
      : {
          models: keyModelsForPlan(user.plan),
          aliases: aliasesForPlan(user.plan),
          remaining: balance <= 0 ? 0 : creditsToRealUsd(balance),
        };
  const maxBudget =
    target.remaining === null ? null : microToUsd(usdToMicro(spend + target.remaining));
  const maxMicro = maxBudget === null ? null : usdToMicro(maxBudget);
  const sameModels = JSON.stringify(row.models) === JSON.stringify(target.models);
  if (!sameModels || row.maxBudgetMicroUsd !== maxMicro) {
    await litellm().updateKey(key, { models: target.models, aliases: target.aliases, maxBudget });
    await setRow({ models: target.models, maxBudgetMicroUsd: maxMicro });
  }

  // 3. No own key pays: delete the copy LiteLLM holds.
  if (!own && row.ownModelId) {
    try {
      await litellm().deleteModel(row.ownModelId);
      await setRow({ ownModelId: null, ownModelFingerprint: null });
    } catch (err) {
      logger().warn(
        { userId, err: (err as Error).message },
        'LiteLLM: deleting the own-key model failed; the next sync retries',
      );
    }
  }
}

/** Best effort: a failure is logged; the 5-minute usage sync applies the state again. */
export async function syncLiteLLMKeyQuietly(userId: string): Promise<void> {
  try {
    await syncLiteLLMKey(userId);
  } catch (err) {
    logger().warn({ userId, err: (err as Error).message }, 'LiteLLM key update failed');
  }
}

/** Which saved key the agent's model calls use right now (null: none, the platform's AI). */
export async function ownKeyInUse(userId: string): Promise<ByokProvider | null> {
  const row = await getKeyRow(userId);
  if (!row || !routesToOwnKey(row)) return null;
  const keys = await byokFingerprints(userId);
  return keys.find((k) => k.fingerprint === row.ownModelFingerprint)?.provider ?? null;
}
