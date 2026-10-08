// Phase 5 test fakes: billing env, in-memory LiteLLM and vm-manager, and the BYOK test-call.
// Importing this module sets the env (it runs after test/setup.ts).
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  setLiteLLMClient,
  type KeyPatch,
  type KeySpend,
  type LiteLLMClient,
  type OwnModel,
} from '../src/modules/billing/litellm.ts';
import { createGrant } from '../src/modules/billing/credits.ts';
import { ensureLiteLLMKey } from '../src/modules/billing/litellm.ts';
import { litellmKeys } from '../src/modules/billing/schema.ts';
import { setByokVerifier } from '../src/modules/integrations/byok.ts';
import { setVmClient, type VmClient } from '../src/modules/orchestrator/vm.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { createUser } from './helpers.ts';

export const POLAR_SECRET =
  'whsec_' + Buffer.from('polar-test-secret-0123456789').toString('base64');

Object.assign(process.env, {
  LITELLM_MASTER_KEY: 'sk-test-master',
  LITELLM_CHEAP_MODEL: 'cheap',
  LITELLM_PAID_MODELS: 'cheap,claude,gpt',
  POLAR_ACCESS_TOKEN: 'polar_oat_test',
  POLAR_WEBHOOK_SECRET: POLAR_SECRET,
  POLAR_PRODUCT_PRO: '5b8c4f3e-1111-4c5a-9d7e-0a1b2c3d4e01',
  POLAR_PRODUCT_MAX: '5b8c4f3e-2222-4c5a-9d7e-0a1b2c3d4e02',
  POLAR_PRODUCT_TOPUP_10: '5b8c4f3e-3333-4c5a-9d7e-0a1b2c3d4e03',
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

/** The server's own models (infra/litellm/config.yaml), paid with the server's provider keys. */
export const SERVER_MODELS = ['cheap', 'claude', 'gpt', 'whisper'];

export class FakeLiteLLM implements LiteLLMClient {
  keys = new Map<string, FakeKey>();
  /** Models added at runtime (own keys): id → what LiteLLM would store. */
  models = new Map<string, OwnModel>();
  calls: string[] = [];
  /** LiteLLM unreachable: every call fails. */
  down = false;
  /** Only deleting a model fails. */
  modelDeleteFails = false;

  private check(op: string) {
    if (this.down) throw new Error(`LiteLLM POST /${op} failed: 503`);
  }

  async generateKey(input: Parameters<LiteLLMClient['generateKey']>[0]) {
    this.check('key/generate');
    const key = `sk-${randomUUID()}`;
    this.keys.set(key, { ...input, key, logs: [], deleted: false });
    this.calls.push('generate');
    return { key };
  }
  async updateKey(key: string, patch: KeyPatch) {
    this.check('key/update');
    const k = this.get(key);
    if (patch.models) k.models = patch.models;
    if (patch.aliases) k.aliases = patch.aliases;
    if (patch.maxBudget !== undefined) k.maxBudget = patch.maxBudget;
    this.calls.push('update');
  }
  async deleteKey(key: string) {
    this.check('key/delete');
    this.get(key).deleted = true;
    this.calls.push('delete');
  }
  async getKeySpend(key: string): Promise<KeySpend> {
    this.check('key/info');
    return this.sum(this.get(key), -Infinity, Infinity);
  }
  async getSpendBetween(key: string, start: Date, end: Date): Promise<KeySpend> {
    this.check('spend/logs');
    return this.sum(this.get(key), start.getTime(), end.getTime());
  }
  async saveModel(model: OwnModel) {
    this.check('model/new');
    this.models.set(model.id, { ...model });
    this.calls.push('saveModel');
  }
  async deleteModel(id: string) {
    this.check('model/delete');
    if (this.modelDeleteFails) throw new Error('LiteLLM POST /model/delete failed: 500');
    this.models.delete(id);
    this.calls.push('deleteModel');
  }

  /**
   * What LiteLLM does with a call from the user's key for `name` (as checked on 1.104.2): the
   * key's alias applies, the result must be in the key's models, then it goes to a runtime model
   * (with the key that model holds) or to a server model (with the server's provider key).
   */
  route(userId: string, name: string): { provider: string; model: string; apiKey: string } {
    const k = this.byUser(userId);
    if (!k) throw new Error('401: no key');
    const target = k.aliases[name] ?? name;
    const allowed = k.models.length === 0 || k.models.includes(target);
    if (!allowed) throw new Error(`403: model ${name} not allowed for this key`);
    const own = this.models.get(target);
    if (own) {
      const [provider, ...rest] = own.model.split('/');
      return { provider: provider!, model: rest.join('/'), apiKey: own.apiKey };
    }
    if (SERVER_MODELS.includes(target))
      return { provider: 'server', model: target, apiKey: 'SERVER-PROVIDER-KEY' };
    throw new Error(`400: invalid model name ${target}`);
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

/**
 * Awake/browser seconds recorded at a point in time; GetUsage sums the ones in [since, until).
 * Every user has a container here, with the browser switch the backend last sent.
 */
export class FakeVm {
  samples: Array<{ userId: string; at: number; awake: number; browser: number }> = [];
  /** The browser switch on record per user, and every SetBrowser call. */
  browser = new Map<string, boolean>();
  browserCalls: Array<{ userId: string; enabled: boolean }> = [];
  add(userId: string, awakeSeconds: number, browserSeconds = 0, at = Date.now() - 1) {
    this.samples.push({ userId, at, awake: awakeSeconds, browser: browserSeconds });
  }
  client(): VmClient {
    return {
      getSandbox: async (req: { userId: string }) => ({
        userId: req.userId,
        browserEnabled: this.browser.get(req.userId) ?? false,
      }),
      setBrowser: async (req: { userId: string; enabled: boolean }) => {
        this.browserCalls.push({ userId: req.userId, enabled: req.enabled });
        this.browser.set(req.userId, req.enabled);
        return { sandbox: { userId: req.userId, browserEnabled: req.enabled } };
      },
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
export async function member(credits = 100, plan: 'free' | 'pro' | 'max' = 'free') {
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
