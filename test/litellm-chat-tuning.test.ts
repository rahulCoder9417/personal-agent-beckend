// Quicker chat on Hermes (HLD 5.2): LiteLLM adds Anthropic's prompt caching and a low thinking
// effort where the model takes them, on the server's own models (infra/litellm/config.yaml) and on
// the model that holds the user's own key (model-tuning.ts).
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  getKeyRow,
  ownCrewModelName,
  ownModelName,
  syncLiteLLMKey,
} from '../src/modules/billing/litellm.ts';
import { chatTuning, TUNING_VERSION } from '../src/modules/billing/model-tuning.ts';
import { litellmKeys } from '../src/modules/billing/schema.ts';
import { closeQueues } from '../src/modules/events/queues.ts';
import { db } from '../src/shared/db/client.ts';
import { wireModules } from '../src/wiring.ts';
import { installFakes, member, type FakeLiteLLM } from './billing-fakes.ts';
import { call, expectContract } from './helpers.ts';

const CACHE_POINTS = [
  { location: 'message', role: 'system' },
  { location: 'message', index: -1 },
];

type ConfigModel = { model_name: string; litellm_params: Record<string, unknown> };

describe("the server's models (infra/litellm/config.yaml)", () => {
  const cfg = parse(readFileSync('infra/litellm/config.yaml', 'utf8')) as {
    model_list: ConfigModel[];
  };
  const params = (name: string) =>
    cfg.model_list.find((m) => m.model_name === name)!.litellm_params;

  it('Claude (the agent on Pro and Max): the prompt cache on the system and last message, low effort', () => {
    expect(params('claude')).toMatchObject({
      model: 'anthropic/claude-sonnet-5',
      cache_control_injection_points: CACHE_POINTS,
      output_config: { effort: 'low' },
    });
    // Not `reasoning_effort`: for Claude, LiteLLM would also ask for a thinking summary.
    expect(params('claude')).not.toHaveProperty('reasoning_effort');
  });

  it("Claude for Hermes's crew (agent-crew on Pro and Max): the same Claude and cache, medium effort, the same fallback", () => {
    expect(params('claude-crew')).toEqual({
      ...params('claude'),
      output_config: { effort: 'medium' },
    });
    const fallbacks = (
      parse(readFileSync('infra/litellm/config.yaml', 'utf8')) as {
        router_settings: { fallbacks: Array<Record<string, string[]>> };
      }
    ).router_settings.fallbacks;
    expect(fallbacks).toContainEqual({ 'claude-crew': ['cheap'] });
  });

  it('GPT gets a low reasoning effort; the cheap model and Whisper are left as they were', () => {
    expect(params('gpt')).toMatchObject({ model: 'openai/gpt-5-mini', reasoning_effort: 'low' });
    for (const name of ['cheap', 'whisper']) {
      expect(params(name)).not.toHaveProperty('reasoning_effort');
      expect(params(name)).not.toHaveProperty('output_config');
      expect(params(name)).not.toHaveProperty('cache_control_injection_points');
    }
  });
});

describe("the model of the user's own key", () => {
  it('Anthropic: the prompt cache always; the low effort only for a model that takes one', () => {
    expect(chatTuning('anthropic', 'claude-sonnet-5-5')).toEqual({
      cache_control_injection_points: CACHE_POINTS,
      output_config: { effort: 'low' },
    });
    for (const m of ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-4-6'])
      expect(chatTuning('anthropic', m)).toHaveProperty('output_config', { effort: 'low' });
    // Haiku 4.5 and older models refuse an effort.
    for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-3-7-sonnet'])
      expect(chatTuning('anthropic', m)).toEqual({ cache_control_injection_points: CACHE_POINTS });
  });

  it("the crew's copy: the same settings with a medium effort instead of low", () => {
    expect(chatTuning('anthropic', 'claude-sonnet-5-5', 'crew')).toEqual({
      cache_control_injection_points: CACHE_POINTS,
      output_config: { effort: 'medium' },
    });
    expect(chatTuning('anthropic', 'claude-haiku-4-5', 'crew')).toEqual({
      cache_control_injection_points: CACHE_POINTS,
    });
    expect(chatTuning('openai', 'gpt-6.1-sol', 'crew')).toEqual({ reasoning_effort: 'medium' });
    expect(chatTuning('openai', 'gpt-4o', 'crew')).toEqual({});
    expect(chatTuning('openrouter', 'anthropic/claude-sonnet-5.5', 'crew')).toEqual(
      chatTuning('openrouter', 'anthropic/claude-sonnet-5.5'),
    );
  });

  it('OpenAI: a low reasoning effort for reasoning models only; OpenRouter: the cache for Claude only', () => {
    expect(chatTuning('openai', 'gpt-6.1-sol')).toEqual({ reasoning_effort: 'low' });
    expect(chatTuning('openai', 'o4-mini')).toEqual({ reasoning_effort: 'low' });
    expect(chatTuning('openai', 'gpt-4o')).toEqual({});
    expect(chatTuning('openrouter', 'anthropic/claude-sonnet-5.5')).toEqual({
      cache_control_injection_points: CACHE_POINTS,
    });
    expect(chatTuning('openrouter', 'openai/gpt-6.1-sol')).toEqual({});
  });
});

describe('saving the own-key model in LiteLLM', () => {
  let llm: FakeLiteLLM;
  beforeAll(() => wireModules());
  afterAll(async () => {
    await closeQueues();
  });
  beforeEach(() => {
    ({ llm } = installFakes());
  });

  const ANT_KEY = 'sk-ant-good-key-TUNE1111';

  it('the model is saved with the settings, and the key still shows as in use', async () => {
    const u = await member(100);
    const saved = await expectContract<{ inUse: boolean }>(
      'setByokKey',
      await call('/v1/byok/anthropic', {
        method: 'PUT',
        token: u.token,
        body: { apiKey: ANT_KEY },
      }),
      200,
    );
    expect(saved.inUse).toBe(true);
    expect(llm.models.get(ownModelName(u.id))).toEqual({
      id: ownModelName(u.id),
      model: 'anthropic/claude-sonnet-5-5',
      apiKey: ANT_KEY,
      params: chatTuning('anthropic', 'claude-sonnet-5-5'),
    });
    expect((await getKeyRow(u.id))!.ownModelFingerprint).toMatch(
      new RegExp(`\\+${TUNING_VERSION}$`),
    );
    // Nothing changed: the next sync saves nothing.
    const before = llm.calls.filter((c) => c === 'saveModel').length;
    await syncLiteLLMKey(u.id);
    expect(llm.calls.filter((c) => c === 'saveModel').length).toBe(before);
  });

  it('a model saved before the settings existed is saved again with them at the next sync', async () => {
    const u = await member(100);
    await call('/v1/byok/anthropic', { method: 'PUT', token: u.token, body: { apiKey: ANT_KEY } });
    // As a model saved by the version before this one: no settings, the bare key fingerprint.
    const row = (await getKeyRow(u.id))!;
    const bare = row.ownModelFingerprint!.split('+')[0]!;
    await db()
      .update(litellmKeys)
      .set({ ownModelFingerprint: bare })
      .where(eq(litellmKeys.userId, u.id));
    llm.models.set(ownModelName(u.id), {
      id: ownModelName(u.id),
      model: 'anthropic/claude-sonnet-5-5',
      apiKey: ANT_KEY,
    });
    llm.models.delete(ownCrewModelName(ownModelName(u.id)));
    await syncLiteLLMKey(u.id);
    expect(llm.models.get(ownModelName(u.id))?.params).toEqual(
      chatTuning('anthropic', 'claude-sonnet-5-5'),
    );
    expect((await getKeyRow(u.id))!.ownModelFingerprint).toBe(`${bare}+${TUNING_VERSION}`);
    // The crew's copy too, which a model saved before had not.
    expect(llm.models.get(ownCrewModelName(ownModelName(u.id)))?.params).toEqual(
      chatTuning('anthropic', 'claude-sonnet-5-5', 'crew'),
    );
  });

  it("a key made before the crew's name gets it at the next sync, so Hermes's crew can call it", async () => {
    const u = await member(100, 'pro');
    await syncLiteLLMKey(u.id);
    const key = llm.byUser(u.id)!;
    // As saved by the version before this one.
    key.models = ['agent-default', 'cheap', 'claude', 'gpt'];
    key.aliases = { 'agent-default': 'claude' };
    await db().update(litellmKeys).set({ models: key.models }).where(eq(litellmKeys.userId, u.id));
    expect(() => llm.route(u.id, 'agent-crew')).toThrow();
    await syncLiteLLMKey(u.id);
    expect(llm.route(u.id, 'agent-crew')).toMatchObject({
      provider: 'server',
      model: 'claude-crew',
    });
    expect(llm.route(u.id, 'agent-default')).toMatchObject({ provider: 'server', model: 'claude' });
  });
});
