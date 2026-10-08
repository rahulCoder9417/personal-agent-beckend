import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  ensureLiteLLMKey,
  getLiteLLMKey,
  syncLiteLLMKey,
  revokeLiteLLMKey,
} from '../src/modules/billing/litellm.ts';
import { users } from '../src/modules/auth/schema.ts';
import { litellmKeys } from '../src/modules/billing/schema.ts';
import {
  deleteByokKey,
  getByokKey,
  hasByokKey,
  listByokKeys,
  setByokKey,
} from '../src/modules/integrations/byok.ts';
import { byokKeys } from '../src/modules/integrations/schema.ts';
import { db } from '../src/shared/db/client.ts';
import { installFakes, member } from './billing-fakes.ts';
import { createUser } from './helpers.ts';

const { llm } = installFakes();

describe('LiteLLM key per user', () => {
  it('is created once, limited to the plan models, with budget = balance in real dollars', async () => {
    const u = await member(100);
    await ensureLiteLLMKey(u.id);
    const key = llm.byUser(u.id)!;
    expect(llm.calls.filter((c) => c === 'generate')).toHaveLength(1);
    // Containers call `agent-default`; on Free the key aliases it to the cheap model.
    expect(key.models).toEqual(['agent-default', 'cheap']);
    expect(key.aliases).toEqual({ 'agent-default': 'cheap' });
    expect(key.maxBudget).toBeCloseTo(0.4, 6); // 100 credits ÷ 2.5 ÷ 100
    expect(await getLiteLLMKey(u.id)).toBe(key.key);
    // Stored encrypted, never in plaintext.
    const [row] = await db().select().from(litellmKeys).where(eq(litellmKeys.userId, u.id));
    expect(row!.keyEncrypted).not.toContain(key.key);
  });

  it('revoking deletes the key at LiteLLM', async () => {
    const u = await member();
    const key = llm.byUser(u.id)!.key;
    await revokeLiteLLMKey(u.id);
    expect(llm.keys.get(key)!.deleted).toBe(true);
  });
});

describe('agent model alias follows the plan', () => {
  it('Pro/Max map agent-default to the premium model; back on Free, to cheap', async () => {
    const u = await member(100);
    await db().update(users).set({ plan: 'pro' }).where(eq(users.id, u.id));
    await syncLiteLLMKey(u.id);
    const key = llm.byUser(u.id)!;
    expect(key.models).toEqual(['agent-default', 'cheap', 'claude', 'gpt']);
    expect(key.aliases).toEqual({ 'agent-default': 'claude' });
    await db().update(users).set({ plan: 'free' }).where(eq(users.id, u.id));
    await syncLiteLLMKey(u.id);
    expect(key.models).toEqual(['agent-default', 'cheap']);
    expect(key.aliases).toEqual({ 'agent-default': 'cheap' });
  });
});

describe('bring your own key', () => {
  it('is test-called before saving, stored encrypted, never returned', async () => {
    const u = await createUser();
    expect(await setByokKey(u.id, 'anthropic', 'sk-ant-bad-key-000', null)).toBeNull();
    expect(await hasByokKey(u.id)).toBe(false);
    const saved = await setByokKey(u.id, 'anthropic', 'sk-ant-good-key-4321', 'claude-sonnet-5');
    expect(saved).toMatchObject({ provider: 'anthropic', set: true, last4: '4321' });
    const [row] = await db().select().from(byokKeys).where(eq(byokKeys.userId, u.id));
    expect(row!.keyEncrypted).not.toContain('good-key');
    expect((await getByokKey(u.id, 'anthropic'))!.apiKey).toBe('sk-ant-good-key-4321');
    const list = await listByokKeys(u.id);
    expect(list.map((k) => [k.provider, k.set])).toEqual([
      ['anthropic', true],
      ['openai', false],
      ['openrouter', false],
    ]);
    expect(JSON.stringify(list)).not.toContain('good-key');
    await deleteByokKey(u.id, 'anthropic');
    expect(await hasByokKey(u.id)).toBe(false);
  });

  it("a BYOK user's AI is not capped by credits", async () => {
    const u = await member(100);
    await setByokKey(u.id, 'openai', 'sk-openai-good-key', null);
    await syncLiteLLMKey(u.id);
    expect(llm.remainingBudget(u.id)).toBeNull();
    await deleteByokKey(u.id, 'openai');
    await syncLiteLLMKey(u.id);
    expect(llm.remainingBudget(u.id)).toBeCloseTo(0.4, 6);
  });
});
