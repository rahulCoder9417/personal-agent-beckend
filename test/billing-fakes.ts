// Phase 5 test fakes: billing env, in-memory LiteLLM and vm-manager, and the BYOK test-call.
// Importing this module sets the env (it runs after test/setup.ts).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  setLiteLLMClient,
  type KeyPatch,
  type KeySpend,
  type LiteLLMClient,
} from '../src/modules/billing/litellm.ts';
import { createGrant } from '../src/modules/billing/credits.ts';
import { ensureLiteLLMKey } from '../src/modules/billing/litellm.ts';
import { litellmKeys } from '../src/modules/billing/schema.ts';
import { setByokVerifier } from '../src/modules/integrations/byok.ts';
import { setVmClient, type VmClient } from '../src/modules/orchestrator/vm.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { createUser } from './helpers.ts';

export const DODO_SECRET = 'whsec_' + Buffer.from('dodo-test-secret-0123456789').toString('base64');

Object.assign(process.env, {
  LITELLM_MASTER_KEY: 'sk-test-master',
  LITELLM_CHEAP_MODEL: 'cheap',
  LITELLM_PAID_MODELS: 'cheap,claude,gpt',
  DODO_API_KEY: 'dodo-test-key',
  DODO_WEBHOOK_SECRET: DODO_SECRET,
  DODO_PRODUCT_PRO: 'prod_pro',
  DODO_PRODUCT_MAX: 'prod_max',
  DODO_PRODUCT_TOPUP_10: 'prod_topup10',
  TRUST_PROXY: 'true',
});
resetConfig();

// --- LiteLLM ----------------------------------------------------------------------------------

interface FakeKey {
  key: string;
  alias: string;
  userId: string;
  models: string[];
  aliases: Record<string, string>;
  maxBudget: number | null;
  /** Spend log: [atMs, model, usd] */
  logs: Array<[number, string, number]>;
  deleted: boolean;
}

export class FakeLiteLLM implements LiteLLMClient {
  keys = new Map<string, FakeKey>();
  calls: string[] = [];

  async generateKey(input: Parameters<LiteLLMClient['generateKey']>[0]) {
    const key = `sk-${randomUUID()}`;
    this.keys.set(key, { ...input, key, logs: [], deleted: false });
    this.calls.push('generate');
    return { key };
  }
  async updateKey(key: string, patch: KeyPatch) {
    const k = this.get(key);
    if (patch.models) k.models = patch.models;
    if (patch.aliases) k.aliases = patch.aliases;
    if (patch.maxBudget !== undefined) k.maxBudget = patch.maxBudget;
    this.calls.push('update');
  }
  async deleteKey(key: string) {
    this.get(key).deleted = true;
    this.calls.push('delete');
  }
  async getKeySpend(key: string): Promise<KeySpend> {
    return this.sum(this.get(key), -Infinity, Infinity);
  }
  async getSpendBetween(key: string, start: Date, end: Date): Promise<KeySpend> {
    return this.sum(this.get(key), start.getTime(), end.getTime());
  }

  private sum(k: FakeKey, from: number, to: number): KeySpend {
    const out: KeySpend = { spend: 0, modelSpend: {} };
    for (const [at, model, usd] of k.logs) {
      if (at < from || at >= to) continue;
      out.spend += usd;
      out.modelSpend[model] = (out.modelSpend[model] ?? 0) + usd;
    }
    return out;
  }
  private get(key: string): FakeKey {
    const k = this.keys.get(key);
    if (!k) throw new Error('LiteLLM 404: unknown key');
    return k;
  }

  byUser(userId: string): FakeKey | undefined {
    return [...this.keys.values()].find((k) => k.userId === userId && !k.deleted);
  }
  /** The user's AI traffic: `usd` of real cost on `model`. */
  spend(userId: string, model: string, usd: number, at = Date.now()) {
    const k = this.byUser(userId);
    if (!k) throw new Error(`no LiteLLM key for ${userId}`);
    k.logs.push([at, model, usd]);
  }
  /** Dollars the key may still spend (max_budget − spend). null = uncapped. */
  remainingBudget(userId: string): number | null {
    const k = this.byUser(userId)!;
    if (k.maxBudget === null) return null;
    const spent = k.logs.reduce((n, l) => n + l[2], 0);
    return Math.round((k.maxBudget - spent) * 1e6) / 1e6;
  }
}

// --- vm-manager -------------------------------------------------------------------------------

/** Awake/browser seconds recorded at a point in time; GetUsage sums the ones in [since, until). */
export class FakeVm {
  samples: Array<{ userId: string; at: number; awake: number; browser: number }> = [];
  add(userId: string, awakeSeconds: number, browserSeconds = 0, at = Date.now() - 1) {
    this.samples.push({ userId, at, awake: awakeSeconds, browser: browserSeconds });
  }
  client(): VmClient {
    return {
      getUsage: async (req: { sinceUnixMs: bigint; untilUnixMs: bigint; userId: string }) => {
        const since = Number(req.sinceUnixMs);
        const until = Number(req.untilUnixMs);
        const per = new Map<string, { awake: number; browser: number }>();
        for (const s of this.samples) {
          if (s.at < since || s.at >= until) continue;
          if (req.userId && s.userId !== req.userId) continue;
          const cur = per.get(s.userId) ?? { awake: 0, browser: 0 };
          cur.awake += s.awake;
          cur.browser += s.browser;
          per.set(s.userId, cur);
        }
        return {
          usage: [...per].map(([userId, u]) => ({
            userId,
            awakeSeconds: BigInt(u.awake),
            browserSeconds: BigInt(u.browser),
          })),
        };
      },
    } as unknown as VmClient;
  }
}

/** Installs fresh fakes; returns them. */
export function installFakes() {
  const llm = new FakeLiteLLM();
  const vm = new FakeVm();
  setLiteLLMClient(llm);
  setVmClient(vm.client());
  setByokVerifier(async (_provider, key) => !key.includes('bad'));
  return { llm, vm };
}

/** A user with `credits` and a LiteLLM key, created a minute ago. */
export async function member(credits = 100, plan: 'free' | 'pro' = 'free') {
  const u = await createUser({ plan });
  await createGrant({
    userId: u.id,
    source: plan === 'free' ? 'signup' : 'monthly',
    amount: credits,
    expiresAt: plan === 'free' ? null : new Date(Date.now() + 30 * 86400_000),
    idempotencyKey: `seed:${u.id}`,
    description: 'seed',
  });
  await ensureLiteLLMKey(u.id);
  // Make the key (and so the first period) start slightly in the past.
  await db()
    .update(litellmKeys)
    .set({ createdAt: new Date(Date.now() - 60_000) })
    .where(eq(litellmKeys.userId, u.id));
  return u;
}
