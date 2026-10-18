// Choosing Textcrew AI (HLD 7.1): a user with their own key or Claude plan can still pick the
// platform's AI, paid in credits, and switch back. Only while Textcrew AI is on offer.
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog } from '../src/modules/admin/schema.ts';
import { getBalance } from '../src/modules/billing/credits.ts';
import { ownModelName } from '../src/modules/billing/litellm.ts';
import { syncUsageForUser } from '../src/modules/billing/usage.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { setByokKey } from '../src/modules/integrations/byok.ts';
import {
  decideAccess,
  getAgentSettings,
  markClaudeConnected,
  ownKeyPaysForAi,
} from '../src/modules/orchestrator/agent-settings.ts';
import { resetConfig } from '../src/shared/config.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakes, member, type FakeLiteLLM, type FakeVm } from './billing-fakes.ts';
import { call, expectContract } from './helpers.ts';

type Settings = {
  runtime: string;
  effectiveRuntime: string | null;
  aiAccess: string;
  aiPreference: string;
  platformAvailable: boolean;
};

let llm: FakeLiteLLM;
let vm: FakeVm;
beforeAll(() => wireModules());
afterAll(async () => {
  await closeQueues();
});
beforeEach(() => {
  ({ llm, vm } = installFakes());
});
afterEach(() => setAiAccessMode(undefined));

function setAiAccessMode(mode: 'platform' | 'own_only' | undefined): void {
  if (mode) process.env.AI_ACCESS_MODE = mode;
  else delete process.env.AI_ACCESS_MODE;
  resetConfig();
}

const patch = (token: string, body: unknown) =>
  call('/v1/agent/settings', { method: 'PATCH', token, body });
const choose = async (token: string, body: unknown) =>
  expectContract<Settings>('updateAgentSettings', await patch(token, body), 200);
const settingsOf = async (token: string) =>
  expectContract<Settings>('getAgentSettings', await call('/v1/agent/settings', { token }), 200);

describe('the rule (decideAccess)', () => {
  it('Textcrew AI wins when chosen and on offer; in own_only the choice is ignored', () => {
    const base = { runtime: 'hermes' as const, claudeConnected: false, hasOwnKey: false };
    const cases = [
      // platform mode + chose Textcrew AI: always Hermes on credits.
      [{ hasOwnKey: true }, 'platform', 'hermes', 'platform'],
      [{ runtime: 'claude_code', claudeConnected: true }, 'platform', 'hermes', 'platform'],
      [
        { runtime: 'claude_code', claudeConnected: true, hasOwnKey: true },
        'platform',
        'hermes',
        'platform',
      ],
      [{}, 'platform', 'hermes', 'platform'],
      // own_only: the existing rules, as if nothing was chosen.
      [{ hasOwnKey: true }, 'own_only', 'hermes', 'own_key'],
      [{ runtime: 'claude_code', claudeConnected: true }, 'own_only', 'claude_code', 'claude_plan'],
      [{ claudeConnected: true }, 'own_only', 'claude_code', 'claude_plan'],
      [{}, 'own_only', null, 'none'],
    ] as const;
    for (const [over, mode, effectiveRuntime, aiAccess] of cases) {
      expect(
        decideAccess({ ...base, ...over, mode, preferPlatform: true }),
        JSON.stringify({ over, mode }),
      ).toEqual({ effectiveRuntime, aiAccess });
    }
  });
});

describe('PATCH /v1/agent/settings { aiPreference }', () => {
  it('a user with their own key chooses Textcrew AI and switches back', async () => {
    const u = await member(100);
    expect(await settingsOf(u.token)).toMatchObject({
      aiAccess: 'platform',
      aiPreference: 'auto',
      platformAvailable: true,
    });
    await setByokKey(u.id, 'anthropic', 'sk-ant-good-key-1234', null);
    expect(await settingsOf(u.token)).toMatchObject({ aiAccess: 'own_key', aiPreference: 'auto' });

    const chosen = await choose(u.token, { aiPreference: 'platform' });
    expect(chosen).toMatchObject({
      runtime: 'hermes',
      effectiveRuntime: 'hermes',
      aiAccess: 'platform',
      aiPreference: 'platform',
    });
    // Choosing it twice changes nothing.
    await choose(u.token, { aiPreference: 'platform' });

    const back = await choose(u.token, { aiPreference: 'auto' });
    expect(back).toMatchObject({ aiAccess: 'own_key', aiPreference: 'auto' });

    const audits = await db().select().from(auditLog).where(eq(auditLog.userId, u.id));
    expect(
      audits.filter((a) => a.action === 'ai_preference_changed').map((a) => a.summary),
    ).toEqual(['Chose Textcrew AI (paid in credits)', 'Went back to their own AI']);
  });

  it('with Textcrew AI chosen the AI is charged in credits and capped by the balance again', async () => {
    const u = await member(100);
    const saved = await call('/v1/byok/anthropic', {
      method: 'PUT',
      token: u.token,
      body: { apiKey: 'sk-ant-good-key-1234' },
    });
    expect(saved.status).toBe(200);
    expect(await ownKeyPaysForAi(u.id)).toBe(true);
    expect(llm.route(u.id, 'agent-default').provider).toBe('anthropic');

    // Own key: the AI part of a sync is free.
    llm.spend(u.id, ownModelName(u.id), 0.04); // would be 10 credits
    vm.add(u.id, 300); // 1 credit of awake time
    expect((await syncUsageForUser(u.id)).charged).toBe(1);
    expect(llm.remainingBudget(u.id)).toBeNull(); // no AI cap on an own key

    await choose(u.token, { aiPreference: 'platform' });
    expect(await ownKeyPaysForAi(u.id)).toBe(false);
    // The AI goes back to Textcrew's models, and the budget follows: 99 credits of real cost.
    expect(llm.route(u.id, 'agent-default')).toMatchObject({ provider: 'server', model: 'cheap' });
    expect(llm.remainingBudget(u.id)).toBeCloseTo(99 / 250, 6);

    llm.spend(u.id, 'cheap', 0.04); // 10 credits
    expect((await syncUsageForUser(u.id, new Date(Date.now() + 1000))).charged).toBe(10);
    expect(await getBalance(u.id)).toBe(89);

    await choose(u.token, { aiPreference: 'auto' });
    expect(await ownKeyPaysForAi(u.id)).toBe(true);
    expect(llm.route(u.id, 'agent-default').apiKey).toBe('sk-ant-good-key-1234');
    expect(llm.remainingBudget(u.id)).toBeNull();
  });

  it('a user on their Claude plan chooses Textcrew AI: Hermes runs; switching back needs no new sign-in', async () => {
    const u = await member(100);
    await markClaudeConnected(u.id);
    expect(await settingsOf(u.token)).toMatchObject({
      runtime: 'claude_code',
      effectiveRuntime: 'claude_code',
      aiAccess: 'claude_plan',
    });

    expect(await choose(u.token, { aiPreference: 'platform' })).toMatchObject({
      runtime: 'claude_code',
      effectiveRuntime: 'hermes',
      aiAccess: 'platform',
      aiPreference: 'platform',
    });
    // One call can pick the Claude plan again.
    expect(await choose(u.token, { runtime: 'claude_code', aiPreference: 'auto' })).toMatchObject({
      effectiveRuntime: 'claude_code',
      aiAccess: 'claude_plan',
      aiPreference: 'auto',
    });
    const s = await getAgentSettings(u.id);
    expect(s.claude.connected).toBe(true);
  });

  it('connecting a Claude plan drops an earlier choice of Textcrew AI', async () => {
    const u = await member(100);
    await choose(u.token, { aiPreference: 'platform' });
    await markClaudeConnected(u.id);
    expect(await settingsOf(u.token)).toMatchObject({
      aiPreference: 'auto',
      effectiveRuntime: 'claude_code',
      aiAccess: 'claude_plan',
    });
  });

  it('own_only: Textcrew AI is not on offer, choosing it is refused, a saved choice is ignored', async () => {
    const u = await member(100);
    await setByokKey(u.id, 'anthropic', 'sk-ant-good-key-1234', null);
    await choose(u.token, { aiPreference: 'platform' });

    setAiAccessMode('own_only');
    // The choice saved earlier is ignored: the key pays, as before.
    expect(await settingsOf(u.token)).toMatchObject({
      platformAvailable: false,
      aiAccess: 'own_key',
      effectiveRuntime: 'hermes',
    });
    expect(await ownKeyPaysForAi(u.id)).toBe(true);

    const refused = await expectContract<{ error: { code: string } }>(
      'updateAgentSettings',
      await patch(u.token, { aiPreference: 'platform' }),
      409,
    );
    expect(refused.error.code).toBe('conflict');
    // Going back to `auto` and choosing a runtime still work.
    expect(await choose(u.token, { aiPreference: 'auto' })).toMatchObject({ aiAccess: 'own_key' });
    expect(await choose(u.token, { runtime: 'hermes' })).toMatchObject({ aiAccess: 'own_key' });
  });

  it('validates the body: one of runtime or aiPreference, nothing else', async () => {
    const u = await member(100);
    await expectContract('updateAgentSettings', await patch(u.token, {}), 400);
    await expectContract('updateAgentSettings', await patch(u.token, { aiPreference: 'own' }), 400);
    await expectContract(
      'updateAgentSettings',
      await patch(u.token, { aiPreference: 'auto', extra: 1 }),
      400,
    );
    await expectContract('updateAgentSettings', await patch('', { aiPreference: 'auto' }), 401);
    // The old shape still works.
    expect(await choose(u.token, { runtime: 'hermes' })).toMatchObject({ runtime: 'hermes' });
  });
});
