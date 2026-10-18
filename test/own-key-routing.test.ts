// Bring your own key, end to end with a fake LiteLLM (HLD 7.1): while the user's own key pays,
// every model name their LiteLLM key may call goes to their provider with their key; when it stops
// paying, the key goes back to the plan and LiteLLM's copy of the provider key is deleted.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBalance } from '../src/modules/billing/credits.ts';
import {
  ensureLiteLLMKey,
  getKeyRow,
  getLiteLLMKey,
  ownCrewModelName,
  ownModelName,
  revokeLiteLLMKey,
  syncLiteLLMKey,
} from '../src/modules/billing/litellm.ts';
import { chatTuning } from '../src/modules/billing/model-tuning.ts';
import { litellmKeys } from '../src/modules/billing/schema.ts';
import { syncUsageForUser } from '../src/modules/billing/usage.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { deleteUserByokKeys, listByokKeys } from '../src/modules/integrations/byok.ts';
import {
  markClaudeConnected,
  markClaudeDisconnected,
  ownKeyPaysForAi,
} from '../src/modules/orchestrator/agent-settings.ts';
import { db } from '../src/shared/db/client.ts';
import { logger } from '../src/shared/logger.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakes, member, type FakeLiteLLM, type FakeVm } from './billing-fakes.ts';
import { call, createUser, expectContract } from './helpers.ts';

type ByokKey = {
  provider: string;
  set: boolean;
  last4: string | null;
  model: string | null;
  effectiveModel: string;
  inUse: boolean;
};

const ANT_KEY = 'sk-ant-good-key-AAAA1111';
const ANT_KEY_2 = 'sk-ant-good-key-BBBB2222';
const OR_KEY = 'sk-or-good-key-CCCC3333';
const OAI_KEY = 'sk-openai-good-key-DDDD4444';
const ALL_KEYS = [ANT_KEY, ANT_KEY_2, OR_KEY, OAI_KEY];

let llm: FakeLiteLLM;
let vm: FakeVm;
let logged: unknown[][] = [];
beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(() => {
  ({ llm, vm } = installFakes());
  logged = [];
  for (const level of ['error', 'warn', 'info', 'debug'] as const) {
    vi.spyOn(logger(), level).mockImplementation(((...args: unknown[]) => {
      logged.push(args);
    }) as never);
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  // No saved provider key ever reaches a log line.
  const text = JSON.stringify(logged);
  for (const k of ALL_KEYS) expect(text).not.toContain(k);
});

const save = (token: string, provider: string, body: Record<string, unknown>) =>
  call(`/v1/byok/${provider}`, { method: 'PUT', token, body });
const saveOk = async (token: string, provider: string, body: Record<string, unknown>) =>
  expectContract<ByokKey>('setByokKey', await save(token, provider, body), 200);
const remove = (token: string, provider: string) =>
  call(`/v1/byok/${provider}`, { method: 'DELETE', token });
const list = async (token: string) =>
  (
    await expectContract<{ items: ByokKey[] }>(
      'listByokKeys',
      await call('/v1/byok', { token }),
      200,
    )
  ).items;
const inUse = async (token: string) => (await list(token)).filter((k) => k.inUse);
const patchSettings = (token: string, body: unknown) =>
  call('/v1/agent/settings', { method: 'PATCH', token, body });

/** What LiteLLM does for the container's fixed model name. */
const agentCall = (userId: string) => llm.route(userId, 'agent-default');

describe('saving an own key puts it in use', () => {
  it('every name the container or a quick reply asks for goes to the provider with the user key', async () => {
    const u = await member(100);
    expect(agentCall(u.id)).toMatchObject({ provider: 'server', model: 'cheap' });

    const saved = await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    expect(saved).toMatchObject({
      provider: 'anthropic',
      set: true,
      last4: '1111',
      model: null,
      effectiveModel: 'claude-sonnet-5-5',
      inUse: true,
    });
    expect(JSON.stringify(saved)).not.toContain(ANT_KEY);

    // LiteLLM holds the key in a model of this user's own, under a name that hides the user id.
    const id = ownModelName(u.id);
    expect(id).toMatch(/^own-[0-9a-f]{24}$/);
    expect(id).not.toContain(u.id);
    // And a second one for Hermes's crew: the same model and key, tuned for the crew.
    expect([...llm.models.values()]).toEqual([
      {
        id,
        model: 'anthropic/claude-sonnet-5-5',
        apiKey: ANT_KEY,
        params: chatTuning('anthropic', 'claude-sonnet-5-5'),
      },
      {
        id: ownCrewModelName(id),
        model: 'anthropic/claude-sonnet-5-5',
        apiKey: ANT_KEY,
        params: chatTuning('anthropic', 'claude-sonnet-5-5', 'crew'),
      },
    ]);
    // The container's name and the quick-reply model both go there, with the user's key; the
    // crew's name goes to the crew's copy.
    const own = { provider: 'anthropic', model: 'claude-sonnet-5-5', apiKey: ANT_KEY };
    expect(agentCall(u.id)).toEqual(own);
    expect(llm.route(u.id, 'cheap')).toEqual(own);
    expect(llm.route(u.id, 'agent-crew')).toEqual(own);
    expect(llm.byUser(u.id)!.aliases['agent-crew']).toBe(ownCrewModelName(id));
    // Textcrew's own models are refused, so no call can use a server provider key.
    for (const name of ['claude', 'claude-crew', 'gpt', 'whisper'])
      expect(() => llm.route(u.id, name)).toThrow(/403/);
    // No AI budget while the own key pays.
    expect(llm.remainingBudget(u.id)).toBeNull();

    // The container only ever gets the LiteLLM key, which holds no provider key.
    const containerKey = await getLiteLLMKey(u.id);
    expect(containerKey).not.toContain(ANT_KEY);
    expect(JSON.stringify(llm.byUser(u.id))).not.toContain(ANT_KEY);

    expect((await inUse(u.token)).map((k) => k.provider)).toEqual(['anthropic']);
  });

  it("uses the model the user chose, else the provider's default; the key saved last pays", async () => {
    const u = await member(100);
    await saveOk(u.token, 'openrouter', { apiKey: OR_KEY, model: 'openai/gpt-6.1-sol' });
    expect(agentCall(u.id)).toEqual({
      provider: 'openrouter',
      model: 'openai/gpt-6.1-sol',
      apiKey: OR_KEY,
    });

    // A second key, saved later, pays from now on.
    const oai = await saveOk(u.token, 'openai', { apiKey: OAI_KEY });
    expect(oai).toMatchObject({ effectiveModel: 'gpt-6.1-sol', inUse: true });
    expect(agentCall(u.id)).toEqual({ provider: 'openai', model: 'gpt-6.1-sol', apiKey: OAI_KEY });
    expect(llm.models.size).toBe(2); // one model per user and its crew copy, replaced in place
    expect(await list(u.token)).toEqual([
      expect.objectContaining({ provider: 'anthropic', set: false, inUse: false }),
      expect.objectContaining({ provider: 'openai', set: true, inUse: true }),
      expect.objectContaining({
        provider: 'openrouter',
        set: true,
        inUse: false,
        effectiveModel: 'openai/gpt-6.1-sol',
      }),
    ]);

    // Deleting it hands over to the other key.
    expect((await remove(u.token, 'openai')).status).toBe(204);
    expect(agentCall(u.id)).toMatchObject({ provider: 'openrouter', apiKey: OR_KEY });
    expect((await inUse(u.token)).map((k) => k.provider)).toEqual(['openrouter']);
  });

  it('replacing the key updates the same model in place', async () => {
    const u = await member(100);
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY_2, model: 'claude-opus-5-5' });
    expect([...llm.models.values()]).toEqual([
      {
        id: ownModelName(u.id),
        model: 'anthropic/claude-opus-5-5',
        apiKey: ANT_KEY_2,
        params: chatTuning('anthropic', 'claude-opus-5-5'),
      },
      {
        id: ownCrewModelName(ownModelName(u.id)),
        model: 'anthropic/claude-opus-5-5',
        apiKey: ANT_KEY_2,
        params: chatTuning('anthropic', 'claude-opus-5-5', 'crew'),
      },
    ]);
    expect(agentCall(u.id).apiKey).toBe(ANT_KEY_2);
  });

  it('rejects a model id with characters no provider uses', async () => {
    const u = await member(100);
    const res = await save(u.token, 'anthropic', { apiKey: ANT_KEY, model: 'claude?x=1' });
    expect(res.status).toBe(400);
    expect(llm.models.size).toBe(0);
  });

  it('is idempotent: syncing again changes nothing at LiteLLM', async () => {
    const u = await member(100);
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    const before = llm.calls.filter((c) => c !== 'generate').length;
    await syncLiteLLMKey(u.id);
    await syncLiteLLMKey(u.id);
    await syncUsageForUser(u.id); // the 5-minute job, with nothing to charge
    expect(llm.calls.filter((c) => c !== 'generate')).toHaveLength(before);
  });
});

describe('when the own key stops paying, the key goes back to the plan', () => {
  it('deleting the key: plan models and alias, budget = balance, LiteLLM copy deleted', async () => {
    const u = await member(100, 'pro');
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    expect((await remove(u.token, 'anthropic')).status).toBe(204);
    // Pro: the fixed name means the premium model again, on Textcrew's provider key.
    expect(agentCall(u.id)).toMatchObject({ provider: 'server', model: 'claude' });
    expect(llm.byUser(u.id)!.models).toEqual([
      'agent-default',
      'agent-crew',
      'cheap',
      'claude',
      'gpt',
      'claude-crew',
    ]);
    expect(llm.remainingBudget(u.id)).toBeCloseTo(100 / 250, 6);
    expect(llm.models.size).toBe(0);
    expect(await getKeyRow(u.id)).toMatchObject({ ownModelId: null, ownModelFingerprint: null });
    expect(await inUse(u.token)).toEqual([]);
    // Deleting again is fine.
    expect((await remove(u.token, 'anthropic')).status).toBe(204);
  });

  it('choosing Textcrew AI, and back', async () => {
    const u = await member(100);
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    expect((await patchSettings(u.token, { aiPreference: 'platform' })).status).toBe(200);
    expect(agentCall(u.id)).toMatchObject({ provider: 'server', model: 'cheap' });
    expect(llm.models.size).toBe(0);
    // The key stays saved, just not in use.
    expect(await list(u.token)).toContainEqual(
      expect.objectContaining({ provider: 'anthropic', set: true, inUse: false }),
    );

    expect((await patchSettings(u.token, { aiPreference: 'auto' })).status).toBe(200);
    expect(agentCall(u.id)).toMatchObject({ provider: 'anthropic', apiKey: ANT_KEY });
  });

  it('a Claude plan that takes over, and back when it goes', async () => {
    const u = await member(100);
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    await markClaudeConnected(u.id); // Claude Code chosen: the plan pays
    expect(await ownKeyPaysForAi(u.id)).toBe(false);
    expect(agentCall(u.id)).toMatchObject({ provider: 'server', model: 'cheap' });
    expect(llm.remainingBudget(u.id)).toBeCloseTo(100 / 250, 6);
    expect(llm.models.size).toBe(0);

    await markClaudeDisconnected(u.id); // back to Hermes: the own key pays again
    expect(await ownKeyPaysForAi(u.id)).toBe(true);
    expect(agentCall(u.id)).toMatchObject({ provider: 'anthropic', apiKey: ANT_KEY });
  });
});

describe('charging', () => {
  it('AI on the own key is free, awake time is not; usage before a switch is charged as it ran', async () => {
    const u = await member(100);
    const ownModel = ownModelName(u.id);
    // Textcrew AI used before the key is saved: charged when the key is saved.
    llm.spend(u.id, 'cheap', 0.04); // 10 credits
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    expect(await getBalance(u.id)).toBe(90);

    // On the own key: only awake time.
    llm.spend(u.id, ownModel, 0.04);
    vm.add(u.id, 300);
    expect((await syncUsageForUser(u.id)).charged).toBe(1);
    expect(await getBalance(u.id)).toBe(89);

    // Own-key AI not synced yet when the key is deleted: still free.
    llm.spend(u.id, ownModel, 0.04);
    expect((await remove(u.token, 'anthropic')).status).toBe(204);
    expect(await getBalance(u.id)).toBe(89);

    // From now on it is Textcrew AI again.
    llm.spend(u.id, 'cheap', 0.004);
    expect((await syncUsageForUser(u.id, new Date(Date.now() + 1000))).charged).toBe(1);
    expect(await getBalance(u.id)).toBe(88);
  });

  it('at a balance of 0 the own key is still capped (awake time is paid in credits)', async () => {
    const u = await createUser(); // no credits
    await ensureLiteLLMKey(u.id);
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    expect(agentCall(u.id).apiKey).toBe(ANT_KEY);
    expect(llm.remainingBudget(u.id)).toBe(0);
  });
});

describe('when LiteLLM cannot be updated', () => {
  it('saving: 503, nothing saved, the AI is as it was', async () => {
    const u = await member(100);
    llm.down = true;
    const res = await save(u.token, 'anthropic', { apiKey: ANT_KEY });
    const body = await expectContract<{ error: { code: string; message: string } }>(
      'setByokKey',
      res,
      503,
    );
    expect(body.error.code).toBe('unavailable');
    expect(body.error.message).toMatch(/wasn't saved/);
    llm.down = false;
    expect(await list(u.token)).toContainEqual(
      expect.objectContaining({ provider: 'anthropic', set: false, inUse: false }),
    );
    expect(agentCall(u.id)).toMatchObject({ provider: 'server' });
  });

  it('replacing: 503, the earlier key is kept and stays in use', async () => {
    const u = await member(100);
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    llm.down = true;
    expect((await save(u.token, 'anthropic', { apiKey: ANT_KEY_2 })).status).toBe(503);
    llm.down = false;
    expect(await list(u.token)).toContainEqual(
      expect.objectContaining({ provider: 'anthropic', last4: '1111', inUse: true }),
    );
    expect(agentCall(u.id).apiKey).toBe(ANT_KEY);
  });

  it('deleting: 503, the key is kept and stays in use', async () => {
    const u = await member(100);
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    llm.down = true;
    const res = await remove(u.token, 'anthropic');
    const body = await expectContract<{ error: { message: string } }>('deleteByokKey', res, 503);
    expect(body.error.message).toMatch(/wasn't removed/);
    llm.down = false;
    expect(await inUse(u.token)).toEqual([
      expect.objectContaining({ provider: 'anthropic', set: true }),
    ]);
    expect(agentCall(u.id).apiKey).toBe(ANT_KEY);
  });

  it('only the copy could not be deleted: the key is no longer used; the next sync deletes it', async () => {
    const u = await member(100);
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    llm.modelDeleteFails = true;
    expect((await remove(u.token, 'anthropic')).status).toBe(204);
    expect(agentCall(u.id)).toMatchObject({ provider: 'server' });
    expect(llm.models.size).toBe(2);
    llm.modelDeleteFails = false;
    await syncUsageForUser(u.id); // the 5-minute job
    expect(llm.models.size).toBe(0);
    expect(await getKeyRow(u.id)).toMatchObject({ ownModelId: null });
  });

  it('a change of AI choice is applied by the 5-minute sync; meanwhile inUse tells the truth', async () => {
    const u = await member(100);
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    llm.down = true;
    expect((await patchSettings(u.token, { aiPreference: 'platform' })).status).toBe(200);
    llm.down = false;
    // Not switched yet: the key is still the one in use, and the list says so.
    expect(agentCall(u.id).apiKey).toBe(ANT_KEY);
    expect((await inUse(u.token)).map((k) => k.provider)).toEqual(['anthropic']);
    await syncUsageForUser(u.id);
    expect(agentCall(u.id)).toMatchObject({ provider: 'server' });
    expect(await inUse(u.token)).toEqual([]);
  });
});

describe('account deletion', () => {
  it("removes LiteLLM's copy of the key, the LiteLLM key, and the saved keys", async () => {
    const u = await member(100);
    await saveOk(u.token, 'anthropic', { apiKey: ANT_KEY });
    const key = llm.byUser(u.id)!.key;
    await revokeLiteLLMKey(u.id);
    expect(llm.models.size).toBe(0);
    expect(llm.keys.get(key)!.deleted).toBe(true);
    const [row] = await db().select().from(litellmKeys).where(eq(litellmKeys.userId, u.id));
    expect(row).toMatchObject({ ownModelId: null, ownModelFingerprint: null });
    expect(row!.revokedAt).not.toBeNull();
    await deleteUserByokKeys(u.id);
    expect((await listByokKeys(u.id)).filter((k) => k.set)).toEqual([]);
  });
});
