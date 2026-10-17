// Jev routing (HLD 5.2): before waking a container, TypeSafe's Jev decides whether a message is
// simple (a cheap model answers it, no container), a task (normal wake → deliver, with the apps it
// likely needs), or spam (ignored). If Jev is down, erroring or not configured, every message is a
// task (HLD 10.1), so routing can only ever save work, never lose a message.
import { TypeSafeClient, type Questions } from '@typesafe-ai/sdk';
import { config } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { recentConversationMessages, recentSessionMessages } from '../channels/messages.ts';
import type { Channel } from '../channels/types.ts';
import type { RouteTimes } from './timings.ts';
import { setTurnHooks, type RouteContext, type RouteDecision, type TurnInput } from './turn.ts';

/** A candidate app for the "which apps" question (the user's connected apps). */
export interface RoutingApp {
  slug: string;
  name: string;
}

export interface JevRequest {
  /** What Jev judges: the recent conversation and the new message. */
  state: { conversation: Array<{ role: 'user' | 'assistant'; text: string }>; message: string };
  apps: RoutingApp[];
}

export interface JevDecision {
  route: 'simple' | 'task' | 'spam';
  /** Probability of the chosen route (0–1). */
  confidence: number;
  /** Slugs of the apps the message likely needs. */
  apps: string[];
}

export interface JevClient {
  decide(req: JevRequest): Promise<JevDecision>;
}

/** Only answer without the agent when Jev is quite sure. */
export const SIMPLE_MIN_CONFIDENCE = 0.7;
/** Dropping a user's message is costly: only when Jev is very sure. */
export const SPAM_MIN_CONFIDENCE = 0.9;
export const APP_MIN_PROBABILITY = 0.5;
/** Longer messages are always tasks. */
const MAX_ROUTABLE_CHARS = 1000;
/**
 * A message up to this long gets its quick reply written while Jev decides (it is used only if Jev
 * says "simple"). Small talk is short; a longer message is rarely simple, so its quick reply would
 * mostly be thrown away.
 */
export const QUICK_REPLY_EARLY_MAX_CHARS = 200;
const CONTEXT_MESSAGES = 6;
const CONTEXT_CHARS = 500;
/** The cheap model says this when it shouldn't answer on its own. */
const ESCALATE = 'ESCALATE';

// --- Jev request/response mapping (TypeSafe System One API: POST /v1/systemone) --------------
//
// Request:  { model, state, questions: {
//              route: { type: 'choice', instructions, criteria: { simple, task, spam } },
//              'app_<slug>': { type: 'noul', instructions } … } }
// Response: { answers: { route: { choice, confidence, probabilities: { simple, task, spam } },
//              'app_<slug>': { noul: 0..1 } … } }

const ROUTE_CRITERIA = {
  simple:
    'Greetings, thanks, small talk, or a general-knowledge question that a basic chatbot can fully answer in one short reply, without tools, the web, current information, the user’s apps, files, reminders, memory of the user, or the earlier conversation.',
  task: 'Anything else: needs the user’s apps (email, calendar, documents…), files, web search or current information, reminders or automations, personal details or memory, several steps, or answers or continues something from the earlier conversation.',
  spam: 'Spam, scams, gibberish, or automated junk that is not meant for the assistant.',
};

export function jevQuestions(apps: RoutingApp[]): Questions {
  const questions: Questions = {
    route: {
      type: 'choice',
      instructions:
        'How should a personal AI assistant handle the latest message in this chat? The user has their own full agent with tools; “simple” skips it and answers with a small model.',
      criteria: ROUTE_CRITERIA,
    },
  };
  for (const app of apps) {
    questions[`app_${app.slug}`] = {
      type: 'noul',
      instructions: `Handling the latest message needs the user's ${app.name} account.`,
    };
  }
  return questions;
}

type RawAnswers = Record<
  string,
  { choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }
>;

export function mapJevAnswers(answers: RawAnswers, apps: RoutingApp[]): JevDecision {
  const r = answers.route;
  const route = r?.choice === 'simple' || r?.choice === 'spam' ? r.choice : 'task';
  const confidence = r?.probabilities?.[route] ?? r?.confidence ?? 0;
  const picked = apps
    .filter((a) => (answers[`app_${a.slug}`]?.noul ?? 0) >= APP_MIN_PROBABILITY)
    .map((a) => a.slug);
  return { route, confidence, apps: picked };
}

/** The real client (TypeSafe SDK). Null when routing isn't configured. */
function sdkClient(): JevClient | null {
  const c = config();
  if (!c.JEV_API_KEY) return null;
  const client = new TypeSafeClient({
    apiKey: c.JEV_API_KEY,
    ...(c.JEV_URL ? { baseURL: c.JEV_URL } : {}),
    defaultModel: c.JEV_MODEL,
    timeout: c.JEV_TIMEOUT_MS,
    // A slow or failing Jev just means "task"; don't wait on retries.
    retry: { maxRetries: 0 },
    logLevel: 'off',
  });
  return {
    async decide(req) {
      const res = await client.systemOne({ state: req.state, questions: jevQuestions(req.apps) });
      return mapJevAnswers(res.answers as unknown as RawAnswers, req.apps);
    },
  };
}

let jevOverride: JevClient | undefined;

/** Tests: replace Jev. `undefined` goes back to the SDK client (or none, if unconfigured). */
export function setJevClient(fake: JevClient | undefined): void {
  jevOverride = fake;
}

// --- cheap-model reply (LiteLLM, OpenAI-compatible chat completions) --------------------------

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
/** `signal`: aborted when the reply is no longer wanted (Jev said the message is a task). */
export type ChatCompleter = (req: {
  userId: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}) => Promise<string>;

type KeyProvider = (userId: string) => Promise<string | null>;
let userKey: KeyProvider = async () => null;

/**
 * Billing plugs in the user's own LiteLLM key so quick replies count against their budget.
 * Until then quick replies use the master key (tagged with `user` for LiteLLM's spend logs).
 */
export function setRoutingKeyProvider(fn: KeyProvider): void {
  userKey = fn;
}

const litellmChat: ChatCompleter = async ({ userId, messages, signal }) => {
  const c = config();
  const key = (await userKey(userId)) || c.LITELLM_MASTER_KEY;
  const res = await fetch(`${c.LITELLM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: c.LITELLM_CHEAP_MODEL,
      messages,
      max_tokens: 600,
      user: userId,
    }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`litellm chat failed: ${res.status}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (json.choices?.[0]?.message?.content ?? '').trim();
};

let chat: ChatCompleter = litellmChat;

/** Tests: replace the cheap model. */
export function setChatCompleter(fn: ChatCompleter | undefined): void {
  chat = fn ?? litellmChat;
}

/**
 * How a quick reply is to be written, by the turn's channel. The same rule the Bridge gives the
 * agent: the web app renders Markdown, a chat app shows the text as typed. This asks the model
 * for it; what goes out to a chat app is made plain in any case (channels/plain-text.ts).
 */
const REPLY_STYLE = {
  web: 'Your reply is shown as rendered Markdown. Use Markdown only when it helps the reader: a list for steps, a table for a comparison, a fenced code block (with the language) for code or commands. A short answer stays a short plain sentence. No headings, no raw HTML, no images.',
  chatApp:
    'Write plain text only, as in a text message. No Markdown symbols. Short paragraphs. A list is lines that start with "- " or "1. ". No tables: one line per item. A link is the bare address.',
};

/** The cheap model's instructions for a turn on this channel. */
export function quickReplyPrompt(channel: Channel): string {
  const where = channel === 'web' ? 'a web chat' : 'a chat app';
  const style = channel === 'web' ? REPLY_STYLE.web : REPLY_STYLE.chatApp;
  return `You are a friendly personal assistant replying in ${where}. Answer in a few short sentences. ${style} If answering needs tools, the web, current information, the user's accounts, files, reminders, memory of the user, or anything you are unsure about, reply with exactly ${ESCALATE} and nothing else. Do the same when the message answers or continues something said earlier in the chat (a yes, a no, a choice, a follow-up to the assistant's question or work).`;
}

// --- apps -----------------------------------------------------------------------------------

type AppsProvider = (userId: string) => Promise<RoutingApp[]>;
let appsFor: AppsProvider = async () => [];

/** Integrations plug in the user's connected apps (candidates for Jev's app pick). */
export function setRoutingAppsProvider(fn: AppsProvider): void {
  appsFor = fn;
}

// --- the route hook -------------------------------------------------------------------------

const TASK: RouteDecision = { kind: 'task' };

/** A quick reply in progress: its answer, and a way to drop it when it is not wanted. */
interface QuickReply {
  result: Promise<string>;
  /** Time from the start until the model answered (set when it has). */
  ms: () => number | undefined;
  cancel: () => void;
}

function startQuickReply(
  input: TurnInput,
  history: Array<{ role: 'user' | 'assistant'; text: string }>,
  text: string,
): QuickReply {
  const abort = new AbortController();
  const started = Date.now();
  let ms: number | undefined;
  const result = chat({
    userId: input.userId,
    messages: [
      { role: 'system', content: quickReplyPrompt(input.channel) },
      ...history.map((m) => ({ role: m.role, content: m.text })),
      { role: 'user', content: text },
    ],
    signal: abort.signal,
  }).finally(() => {
    ms = Date.now() - started;
  });
  // A reply nobody waits for (Jev said task, or routing failed) must not end as an unhandled error.
  result.catch(() => {});
  return { result, ms: () => ms, cancel: () => abort.abort() };
}

function taskWithApps(_input: TurnInput, apps: string[]): RouteDecision {
  // The likely apps reach the agent as a hint (Deliver.metadata_json.apps).
  return apps.length ? { kind: 'task', apps } : TASK;
}

/** What was said just before, in the turn's own conversation only. */
async function conversation(input: TurnInput) {
  const rows = input.conversationId
    ? await recentConversationMessages(input.userId, input.conversationId, CONTEXT_MESSAGES + 1)
    : await recentSessionMessages(input.userId, input.sessionKey, CONTEXT_MESSAGES + 1);
  return rows
    .filter((m) => m.id !== input.inboundMessageId && m.text)
    .slice(-CONTEXT_MESSAGES)
    .map((m) => ({
      role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
      text: m.text.slice(0, CONTEXT_CHARS),
    }));
}

/**
 * The `route` turn hook: simple / task / spam. Any failure → task.
 *
 * What runs at the same time, so a quick answer does not wait for each step in turn: once the
 * message is one Jev will judge, the container starts waking (`ctx.wakeEarly`), and a short
 * message's quick reply is written while Jev decides. The quick reply is used only when Jev says
 * "simple" (and the model did not say ESCALATE); otherwise it is dropped and the request to the
 * model is aborted. A woken container that turns out not to be needed just idles until its idle
 * stop.
 */
export async function routeTurn(input: TurnInput, ctx: RouteContext = {}): Promise<RouteDecision> {
  // Only fresh user messages are routed; approval answers, automations and app events are tasks,
  // and so is a request from the New automation page (the agent must draft it or say why not).
  if (input.kind !== 'message' || input.attachments?.length || input.purpose) return TASK;
  const text = input.text.trim();
  if (!text || text.length > MAX_ROUTABLE_CHARS) return TASK;
  const jev = jevOverride ?? sdkClient();
  if (!jev) return TASK;
  const log = logger().child({ userId: input.userId, deliveryId: input.deliveryId });
  const times: RouteTimes = ctx.times ?? {};
  ctx.wakeEarly?.();
  let quick: QuickReply | undefined;
  try {
    const reading = Date.now();
    const [history, apps] = await Promise.all([conversation(input), appsFor(input.userId)]);
    times.contextMs = Date.now() - reading;
    if (text.length <= QUICK_REPLY_EARLY_MAX_CHARS) {
      quick = startQuickReply(input, history, text);
      times.quickReplyEarly = true;
    }
    const asking = Date.now();
    const decision = await jev.decide({ state: { conversation: history, message: text }, apps });
    times.jevMs = Date.now() - asking;
    if (decision.route === 'spam' && decision.confidence >= SPAM_MIN_CONFIDENCE) {
      quick?.cancel();
      log.info('routing: spam, ignored');
      return { kind: 'spam' };
    }
    if (decision.route !== 'simple' || decision.confidence < SIMPLE_MIN_CONFIDENCE) {
      quick?.cancel();
      return taskWithApps(input, decision.apps);
    }

    quick ??= startQuickReply(input, history, text);
    const waiting = Date.now();
    const reply = await quick.result;
    times.quickReplyWaitMs = Date.now() - waiting;
    times.quickReplyMs = quick.ms();
    if (!reply || reply.toUpperCase().startsWith(ESCALATE)) {
      times.escalated = true;
      return taskWithApps(input, decision.apps);
    }
    log.info('routing: simple, answered without the agent');
    return { kind: 'simple', reply };
  } catch (err) {
    quick?.cancel();
    times.failed = true;
    log.warn({ err: (err as Error).message }, 'routing failed; treating the message as a task');
    return TASK;
  }
}

/** Registers Jev routing as the turn's `route` hook. Called once from src/wiring.ts. */
export function wireRouting(): void {
  setTurnHooks({ route: routeTurn });
}
