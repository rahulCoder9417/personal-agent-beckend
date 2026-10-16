// What LiteLLM adds to each model call of the agent (Hermes), for a quicker and cheaper answer:
// Anthropic's prompt caching, and a low thinking effort for chat, where the model takes it. The
// server's own `claude` model has the same in infra/litellm/config.yaml.
//
// Checked with LiteLLM 1.104.2 (the server's version) in front of a stand-in provider that logged
// what it got, for an OpenAI-style request like Hermes sends:
// - `cache_control_injection_points` with the system message and the last message: Anthropic got
//   `cache_control: {type: ephemeral}` on the system text and on the last message's text. So the
//   tools, the instructions and the conversation so far are read from the cache on the next model
//   round of the same turn and on the next message within 5 minutes.
// - `output_config: {effort: low}`: passed through to Anthropic as it is, and no `thinking` field
//   is added (Claude's own default, adaptive thinking, stays). `reasoning_effort: low` would have
//   given the same effort but also `thinking: {display: summarized}`, so it is not used for Claude.
// - `reasoning_effort: low` for OpenAI: passed through as it is.
// A request's own effort wins over these (a `reasoning_effort: high` in the request reached
// Anthropic as `high`).

/** Changes whenever what is added changes, so models saved before are saved again. */
export const TUNING_VERSION = 't1';

/** The breakpoints: the system message (tools and instructions), and the last message. */
const CACHE_POINTS = [
  { location: 'message', role: 'system' },
  { location: 'message', index: -1 },
];

/**
 * Claude models that take an effort (Anthropic's thinking table: Opus 4.6 and later, Sonnet 4.6
 * and later, Haiku 5.5, Fable). Haiku 4.5 and the older ones refuse it.
 */
const CLAUDE_WITH_EFFORT = /^claude-(fable-5|opus-5|sonnet-5|haiku-5|opus-4-[678]|sonnet-4-6)/;

/** OpenAI's reasoning models (they take `reasoning_effort`); a gpt-4 refuses it. */
const OPENAI_REASONING = /^(gpt-[5-9]|o[1-9])/;

/**
 * The extra LiteLLM settings for a model of the user's own key: `provider` and the provider's
 * own model id (e.g. `anthropic`, `claude-sonnet-5-5`).
 */
export function chatTuning(provider: string, model: string): Record<string, unknown> {
  if (provider === 'anthropic')
    return {
      cache_control_injection_points: CACHE_POINTS,
      ...(CLAUDE_WITH_EFFORT.test(model) ? { output_config: { effort: 'low' } } : {}),
    };
  // OpenAI caches long prompts by itself; nothing to add for that.
  if (provider === 'openai') return OPENAI_REASONING.test(model) ? { reasoning_effort: 'low' } : {};
  // OpenRouter passes Anthropic's cache marks on to Claude. It translates an effort its own way,
  // which was not checked, so none is set there.
  if (provider === 'openrouter' && model.startsWith('anthropic/'))
    return { cache_control_injection_points: CACHE_POINTS };
  return {};
}
