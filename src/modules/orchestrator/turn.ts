// One agent turn: credit check → routing → wake → deliver (stream until turn done). HLD 5.2.
import { Code, ConnectError } from '@connectrpc/connect';
import { config } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { alert } from '../admin/alerts.ts';
import { audit } from '../admin/audit.ts';
import { getActiveUserCached, isSuspended } from '../auth/users.ts';
import { conversationFor, isAutomationsChat } from '../channels/conversations.ts';
import { signedFileUrl } from '../channels/files.ts';
import { setMessageStatus } from '../channels/messages.ts';
import { queueOutbound } from '../channels/outbound.ts';
import { purchaseLinksAllowed, WEB_APP_NAME } from '../channels/purchase-links.ts';
import type { MediaRef } from '../channels/schema.ts';
import { publish } from '../channels/stream.ts';
import type { Channel } from '../channels/types.ts';
import {
  claudeOptionsOf,
  fallBackIfClaudeSignedOut,
  getAgentSettings,
  syncRuntimeAfterWake,
  type AgentSettingsView,
  type RuntimeName,
} from './agent-settings.ts';
import { syncBrowserAfterWake } from './browser.ts';
import { crewOfProgress } from './crew.ts';
import { ensureSandbox, hasSandbox } from './sandbox.ts';
import { TurnTimer, type RouteTimes } from './timings.ts';
import { readTurnContext, recordEngineTurn, turnText } from './turn-context.ts';
import { DeliverEventType, DeliverKind, planPriority, vm } from './vm.ts';

export type TurnKind = 'message' | 'approval_answer' | 'automation' | 'app_event' | 'crew_job';

export interface TurnInput {
  userId: string;
  /** Idempotency key for the Bridge (the event id). */
  deliveryId: string;
  kind: TurnKind;
  sessionKey: string;
  channel: Channel;
  text: string;
  attachments?: MediaRef[];
  approval?: { id: string; approved: boolean };
  inboundMessageId?: string;
  /**
   * The conversation the turn belongs to: the inbound message's own, or the Automations chat for
   * an automation's run. Left out or no longer there: the chat's active one (but see
   * `inAutomationsChat`).
   */
  conversationId?: string;
  /**
   * An automation's run: `conversationId` is the Automations chat, and if the user deleted it
   * meanwhile the run starts a new one. Never the conversation the user has open.
   */
  inAutomationsChat?: boolean;
  metadata?: Record<string, unknown>;
}

export type RouteDecision =
  { kind: 'task'; apps?: string[] } | { kind: 'simple'; reply: string } | { kind: 'spam' };

/** `suspended`: an admin suspended the account; nothing ran and nothing was said. */
export type TurnOutcome = 'done' | 'out_of_credits' | 'simple' | 'spam' | 'error' | 'suspended';

/**
 * What the turn gives the route hook besides the message: a way to start waking the container while
 * the route is decided, and a record of how long each part of the decision took (timings.ts).
 */
export interface RouteContext {
  /**
   * Start waking the container now (setting WAKE_WHILE_ROUTING). Safe to call more than once. The
   * turn waits for the wake only if the message turns out to be a task; otherwise the container
   * just idles until its idle stop.
   */
  wakeEarly?: () => void;
  times?: RouteTimes;
  /** The user's agent settings, already being read by the turn (no second read). */
  settings?: Promise<AgentSettingsView>;
}

/** The turn that just ended, as billing needs it. */
export interface EndedTurn {
  /** The turn's delivery id (its event id). */
  id: string;
  /** The engine the turn ran on. Null: no container ran it (a quick reply). */
  engine: RuntimeName | null;
}

/** Filled in by other modules (billing, Jev routing). Defaults keep a turn working without them. */
export interface TurnHooks {
  hasCredits(userId: string): Promise<boolean>;
  /**
   * Just before the turn's credit check: bring the balance up to date when earlier turns still
   * wait for their billing (billing). Usually a quick look and nothing else. Never fails.
   */
  settleBeforeTurn(userId: string): Promise<void>;
  route(input: TurnInput, ctx?: RouteContext): Promise<RouteDecision>;
  /**
   * The turn has its outcome: queue its billing (billing). Quick, and before the user's lock is
   * given back; the billing itself runs as a job of its own, after the lock is free.
   */
  afterTurn(userId: string, outcome: TurnOutcome, turn: EndedTurn): Promise<void>;
  /** The turn failed on our side: queue its refund (billing). Quick; never does the refund here. */
  onPlatformFault(
    userId: string,
    turn: { startedAt: Date; endedAt: Date; idempotencyKey: string; engine: RuntimeName },
  ): Promise<void>;
}

let hooks: TurnHooks = {
  hasCredits: async () => true,
  settleBeforeTurn: async () => {},
  route: async () => ({ kind: 'task' }),
  afterTurn: async () => {},
  onPlatformFault: async () => {},
};

export function setTurnHooks(h: Partial<TurnHooks>): void {
  hooks = { ...hooks, ...h };
}

/** Balance > 0? (billing plugs in). */
export function userHasCredits(userId: string): Promise<boolean> {
  return hooks.hasCredits(userId);
}

/**
 * The reply at zero credits. Telegram gets no purchase link (HLD 7.6): it names the web app
 * instead. Other channels link to the billing page.
 */
export function outOfCreditsText(channel: Channel): string {
  const sorry = "You're out of credits, so I can't work on that right now.";
  if (!purchaseLinksAllowed(channel))
    return `${sorry} Open ${WEB_APP_NAME} to top up, upgrade or redeem a coupon.`;
  return `${sorry} Top up, upgrade or redeem a coupon at ${config().WEB_APP_URL}/billing`;
}

/** `AI_ACCESS_MODE=own_only` and the user has neither an API key nor a connected Claude plan. */
export function connectAiText(): string {
  return `Connect your own AI first: add an API key or connect your Claude plan at ${config().WEB_APP_URL}/settings/ai`;
}

const KIND: Record<TurnKind, DeliverKind> = {
  message: DeliverKind.MESSAGE,
  approval_answer: DeliverKind.APPROVAL_ANSWER,
  automation: DeliverKind.AUTOMATION,
  app_event: DeliverKind.APP_EVENT,
  // A crew job is the user's own request, written down by the platform from their brief. The
  // Bridge knows it is a job from the delivery's metadata (`crew_job`), so no new kind is needed.
  crew_job: DeliverKind.MESSAGE,
};

/** Retryable: the job waits (server full, vm-manager down). */
export class RetryableTurnError extends Error {}

// --- the engine of the turn in progress (HLD 5.1) ----------------------------------------------
// read_page opens any public address only while the user's turn runs on Claude Code. Every call
// from a container carries the same token, so the platform can't ask the caller: the worker
// records the engine a turn really runs on when it delivers it, and removes the record when the
// turn ends. No record means "not known", and read_page then keeps its strict rule.

/** Longer than the longest turn (15 minutes), so a record never outlives its turn by much. */
export const TURN_ENGINE_TTL_SECONDS = 20 * 60;
const turnEngineKey = (userId: string) => `turn-engine:${userId}`;

/** Never fails the turn: without the record read_page is only stricter. */
async function recordTurnEngine(userId: string, engine: RuntimeName): Promise<void> {
  try {
    await redis().set(turnEngineKey(userId), engine, 'EX', TURN_ENGINE_TTL_SECONDS);
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'engine of the turn not on record');
  }
}

async function clearTurnEngine(userId: string): Promise<void> {
  await redis()
    .del(turnEngineKey(userId))
    .catch((err: unknown) =>
      logger().warn({ userId, err: String(err) }, 'engine of the turn not cleared'),
    );
}

/** The engine the user's turn in progress runs on. Null: no turn in progress, or not known. */
export async function turnEngine(userId: string): Promise<RuntimeName | null> {
  try {
    const engine = await redis().get(turnEngineKey(userId));
    return engine === 'claude_code' || engine === 'hermes' ? engine : null;
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'engine of the turn not readable');
    return null;
  }
}

// --- the conversation of the turn in progress ---------------------------------------------------
// What the agent sends during a turn belongs to the turn's conversation, also when the user has
// opened another web conversation meanwhile, and it is saved with the turn's id, so the turn's
// reply can be found afterwards (an automation copies it to Telegram). The agent's tools only know
// the chat (the session key), so the worker records the turn when it delivers it, like the engine
// above.

const turnConversationKey = (userId: string) => `turn-conversation:${userId}`;

/** The turn in progress in a chat, as the agent's tools need it. */
export interface CurrentTurn {
  conversationId: string;
  /** The turn's delivery id. */
  turnId: string;
  /** The conversation is the Automations chat (an automation's run, or the user writing there). */
  inAutomationsChat: boolean;
  /** What the turn is: the user's message, an automation's run, an app event, … */
  kind?: TurnKind;
}

/** Never fails the turn: without the record a reply goes to the chat's active conversation. */
async function recordTurnConversation(
  userId: string,
  sessionKey: string,
  turn: CurrentTurn,
): Promise<void> {
  try {
    await redis().set(
      turnConversationKey(userId),
      JSON.stringify({ sessionKey, ...turn }),
      'EX',
      TURN_ENGINE_TTL_SECONDS,
    );
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'conversation of the turn not on record');
  }
}

async function clearTurnConversation(userId: string): Promise<void> {
  await redis()
    .del(turnConversationKey(userId))
    .catch((err: unknown) =>
      logger().warn({ userId, err: String(err) }, 'conversation of the turn not cleared'),
    );
}

/**
 * The user's turn in progress, when that turn is in this chat. Null: no turn in progress, another
 * chat's turn, or not known.
 */
export async function currentTurn(userId: string, sessionKey: string): Promise<CurrentTurn | null> {
  try {
    const raw = await redis().get(turnConversationKey(userId));
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<CurrentTurn> & { sessionKey?: string };
    if (record.sessionKey !== sessionKey || !record.conversationId) return null;
    return {
      conversationId: record.conversationId,
      turnId: record.turnId ?? '',
      inAutomationsChat: record.inAutomationsChat === true,
    };
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'conversation of the turn not readable');
    return null;
  }
}

/** The kinds of turn that are an automation's run: a timer's, and an app event's. */
const AUTOMATION_RUNS: ReadonlySet<string> = new Set<TurnKind>(['automation', 'app_event']);

/**
 * Whether the user's turn in progress, in any chat, is an automation's run (a timer or an app
 * event, pull-request review included). What the agent read during such a run was not written by
 * the user, so some tools refuse then (schedule_reminder). `unknown`: the record could not be read.
 */
export async function automationRunInProgress(userId: string): Promise<boolean | 'unknown'> {
  try {
    const raw = await redis().get(turnConversationKey(userId));
    if (!raw) return false;
    const kind = (JSON.parse(raw) as { kind?: unknown }).kind;
    return typeof kind === 'string' && AUTOMATION_RUNS.has(kind);
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'kind of the turn not readable');
    return 'unknown';
  }
}

/**
 * The conversation of the user's turn in progress, when that turn is in this chat. Null: no turn
 * in progress, another chat's turn, or not known.
 */
export async function turnConversationId(
  userId: string,
  sessionKey: string,
): Promise<string | null> {
  return (await currentTurn(userId, sessionKey))?.conversationId ?? null;
}

/**
 * What a message the agent sends to `sessionKey` is saved with: the conversation of the turn in
 * progress in that chat, the turn's id, and whether that is the Automations chat. Empty when no
 * turn of that chat is in progress (the chat's active conversation then).
 */
export async function turnMessageFields(
  userId: string,
  sessionKey: string,
): Promise<{ conversationId: string | null; turnId?: string; inAutomationsChat?: boolean }> {
  const turn = await currentTurn(userId, sessionKey);
  if (!turn) return { conversationId: null };
  return {
    conversationId: turn.conversationId,
    ...(turn.turnId ? { turnId: turn.turnId } : {}),
    ...(turn.inAutomationsChat ? { inAutomationsChat: true } : {}),
  };
}

/** A progress line is short; anything longer is cut. */
export const PROGRESS_MAX_CHARS = 300;
/** Crew lines saved to the activity log per turn (the rest are only streamed). */
export const CREW_LINES_PER_TURN = 30;

/**
 * A progress line from the Bridge (HLD 0.7), e.g. `Scout: reading 4 pages` or `using web_search`.
 * It goes to the web chat's live stream. Nothing is sent to Telegram or any other chat for it: a
 * chat only gets what the agent itself sends. A line that names a crew member is also saved to
 * the activity log. Never fails the turn.
 */
async function reportProgress(
  input: TurnInput,
  ev: { message: string; atUnixMs?: bigint },
  turn: { crewLines: number },
): Promise<void> {
  const text = ev.message.trim().slice(0, PROGRESS_MAX_CHARS);
  if (!text) return;
  const crew = crewOfProgress(text);
  const at = ev.atUnixMs ? new Date(Number(ev.atUnixMs)) : new Date();
  try {
    await publish(input.userId, 'agent.progress', { text, crew, at: at.toISOString() });
    if (crew && turn.crewLines < CREW_LINES_PER_TURN) {
      turn.crewLines++;
      await audit({
        userId: input.userId,
        actor: 'agent',
        action: 'crew_progress',
        summary: text,
        details: { crew, deliveryId: input.deliveryId },
      });
    }
  } catch (err) {
    logger().debug({ userId: input.userId, err: String(err) }, 'progress line dropped');
  }
}

/** A draft is cut at this length (the Bridge stops one there too). */
export const DRAFT_MAX_CHARS = 16_000;

/**
 * Whether a turn's answer is shown as it is written: only in web chat, where the web app draws
 * the draft (`message.draft`). Telegram and the other chat apps get the finished answer only.
 */
export const streamsDraft = (input: Pick<TurnInput, 'channel'>) => input.channel === 'web';

/**
 * The answer the agent is writing, so far: a TEXT_DELTA from the Bridge, which holds the whole
 * draft. It goes to the web app's live stream as `message.draft`, with the turn's conversation,
 * the turn's id (its delivery id) and the message it answers. Nothing is saved and nothing goes to
 * a chat app. An empty text means the agent started over (a new message, or a tool call). Never
 * fails the turn.
 */
async function publishDraft(
  input: TurnInput,
  ev: { message: string; atUnixMs?: bigint },
): Promise<boolean> {
  if (!streamsDraft(input) || !input.conversationId) return false;
  const at = ev.atUnixMs ? new Date(Number(ev.atUnixMs)) : new Date();
  try {
    await publish(input.userId, 'message.draft', {
      conversationId: input.conversationId,
      turnId: input.deliveryId,
      messageId: input.inboundMessageId ?? null,
      text: ev.message.slice(0, DRAFT_MAX_CHARS),
      at: at.toISOString(),
    });
    return true;
  } catch (err) {
    logger().debug({ userId: input.userId, err: String(err) }, 'draft dropped');
    return false;
  }
}

/**
 * Where what the platform itself says during a turn goes (out of credits, the turn failed): the
 * turn's conversation, saved with the turn's id, like the agent's own reply.
 */
const turnSays = (input: TurnInput) => ({
  sessionKey: input.sessionKey,
  conversationId: input.conversationId ?? null,
  turnId: input.deliveryId,
  inAutomationsChat: input.inAutomationsChat === true,
});

/**
 * Runs one turn, and writes where its time went (timings.ts) when it ends, whatever the outcome.
 * `retry`: the job will try again; `failed`: an error the job does not retry by itself.
 */
export async function runTurn(given: TurnInput): Promise<TurnOutcome> {
  const timer = new TurnTimer({
    deliveryId: given.deliveryId,
    userId: given.userId,
    kind: given.kind,
    channel: given.channel,
  });
  try {
    const outcome = await turnSteps(given, timer);
    timer.outcome = outcome;
    return outcome;
  } catch (err) {
    timer.outcome = err instanceof RetryableTurnError ? 'retry' : 'failed';
    throw err;
  } finally {
    timer.mark('finished');
    await timer.save();
  }
}

/** The user and the vm-manager's answer to the wake. */
interface Woken {
  plan: Parameters<typeof planPriority>[0];
  woke: Awaited<ReturnType<ReturnType<typeof vm>['wakeSandbox']>>;
}

/**
 * Makes sure the container exists and wakes it. Null: the user is gone, or suspended.
 * `created`: whether the container's record is there, read at the turn's start beside its other
 * reads (a failed read counts as "not known": it is read again here).
 */
async function wakeContainer(
  userId: string,
  timer: TurnTimer,
  created: Promise<boolean>,
): Promise<Woken | null> {
  const user = await getActiveUserCached(userId);
  // A suspended account's container is never woken (an admin's decision).
  if (!user || user.status === 'suspended') return null;
  await ensureSandbox(userId, await created.catch(() => false));
  timer.mark('wake_started');
  let woke;
  try {
    woke = await vm().wakeSandbox({ userId, priority: planPriority(user.plan) });
  } catch (err) {
    if (
      err instanceof ConnectError &&
      [Code.ResourceExhausted, Code.Unavailable, Code.DeadlineExceeded].includes(err.code)
    ) {
      throw new RetryableTurnError(`wake failed: ${err.message}`);
    }
    throw err;
  }
  timer.mark('woken');
  timer.noteWake(woke);
  return { plan: user.plan, woke };
}

async function turnSteps(given: TurnInput, timer: TurnTimer): Promise<TurnOutcome> {
  const { userId } = given;
  const log = logger().child({ userId, deliveryId: given.deliveryId });
  // An admin suspended the account: the message stays saved, nothing runs, nothing is said (the
  // chat path sends its own short notice), and the container is not woken. Covers what was queued
  // before the suspension too: a web message, an automation's run, a crew job.
  if (await isSuspended(userId)) {
    timer.route = 'suspended';
    if (given.inboundMessageId) await setMessageStatus(given.inboundMessageId, 'delivered');
    return 'suspended';
  }
  // Read now, beside the conversation, what the turn needs next: whether the user has credits and
  // their agent settings (the route and the wake both need them). Each is a round trip to the
  // database; at once they cost one. Only reads: nothing is decided before its usual place. The
  // balance is first brought up to date if earlier turns still wait for their billing (usually
  // not: a look in Redis and nothing else).
  const hasCreditsRead = hooks
    .settleBeforeTurn(userId)
    .catch(() => {})
    .then(() => hooks.hasCredits(userId));
  hasCreditsRead.catch(() => {});
  const settingsRead = getAgentSettings(userId);
  settingsRead.catch(() => {});
  // And whether the user's container was created: the wake needs it, and on the server it is one
  // more round trip of about 260 ms when read after the route.
  const createdRead = hasSandbox(userId);
  createdRead.catch(() => {});
  // The turn's conversation: the message's own (or the Automations chat), else the chat's active
  // one. Everything the turn saves and everything the agent is given comes from this conversation.
  const conversation = await conversationFor(userId, given.sessionKey, given.conversationId, {
    automations: given.inAutomationsChat === true,
  });
  const input: TurnInput = {
    ...given,
    conversationId: conversation.id,
    inAutomationsChat: isAutomationsChat(conversation),
  };
  const said = turnSays(input);

  if (!(await hasCreditsRead)) {
    timer.route = 'out_of_credits';
    await queueOutbound({ userId, ...said, text: outOfCreditsText(input.channel) });
    timer.mark('answered');
    if (input.inboundMessageId) await setMessageStatus(input.inboundMessageId, 'delivered');
    return 'out_of_credits';
  }

  // The container may start waking while the route is decided (routing.ts calls `wakeEarly` once
  // the message is one Jev will judge), so a task does not wait for both one after the other.
  let wakeOnce: Promise<Woken | null> | undefined;
  const wake = () => (wakeOnce ??= wakeContainer(userId, timer, createdRead));
  const decision = await hooks.route(input, {
    wakeEarly: () => {
      // A wake nobody waits for (the route said simple) must not end as an unhandled error.
      if (config().WAKE_WHILE_ROUTING) wake().catch(() => {});
    },
    times: timer.routeTimes,
    settings: settingsRead,
  });
  timer.mark('routed');
  timer.route = decision.kind;
  if (decision.kind === 'spam') {
    if (input.inboundMessageId) await setMessageStatus(input.inboundMessageId, 'delivered');
    return 'spam';
  }
  if (decision.kind === 'simple') {
    await queueOutbound({ userId, ...said, text: decision.reply });
    timer.mark('answered');
    await hooks.afterTurn(userId, 'simple', { id: input.deliveryId, engine: null });
    if (input.inboundMessageId) await setMessageStatus(input.inboundMessageId, 'delivered');
    return 'simple';
  }

  // What the turn's text is made of (the user's memory, and which engine had this conversation,
  // for the recap) is read while the container wakes, not after: only reads, and the user's lock
  // keeps any other turn from changing them meanwhile.
  const contextReads = readTurnContext(userId, conversation);
  // The settings (read above, while the container woke) say which engine it must run.
  if (!timer.has('woken'))
    await publish(userId, 'agent.status', { state: 'waking', lastActiveAt: null });
  const awake = await wake();
  // Suspended while the route was decided: the same as suspended before it.
  if (!awake) return (await isSuspended(userId)) ? 'suspended' : 'error';
  const { woke } = awake;
  const settings = await settingsRead;
  // The container runs the agent the user's settings say (Hermes or Claude Code).
  const engine = await syncRuntimeAfterWake(userId, woke.sandbox, settings);
  timer.engine = engine;
  // Scout's browser is on for this container only if the plan says so (HLD 11.3).
  await syncBrowserAfterWake(userId, awake.plan, woke.sandbox);
  // What is known about the user (the same in every conversation), and a recap of this
  // conversation if the engine changed (HLD 0.9).
  const text = await turnText({ ...input, conversation }, engine, contextReads);
  // What the platform adds to the delivery's metadata: the conversation's number in its chat,
  // always. The Bridge keeps one engine conversation per number, so this turn continues its own
  // conversation's context; the number is lower than the chat's highest when the user went back
  // to an earlier conversation. On Claude Code also the model and the effort the user chose (each
  // left out when it is Claude Code's default). `stream_text`: whether the Bridge sends the draft of
  // the answer as it is written (web chat only).
  const metadata: Record<string, unknown> = {
    chat_epoch: conversation.epoch,
    stream_text: streamsDraft(input),
    ...(engine === 'claude_code' ? { claude: claudeOptionsOf(settings) } : {}),
  };

  // From here until the turn ends, read_page knows which engine is calling it (HLD 5.1), and what
  // the agent sends to this chat is saved in the turn's conversation.
  await recordTurnEngine(userId, engine);
  await recordTurnConversation(userId, input.sessionKey, {
    conversationId: conversation.id,
    turnId: input.deliveryId,
    inAutomationsChat: input.inAutomationsChat === true,
    kind: input.kind,
  });
  const outcome = await deliverTurn(
    input,
    { text, apps: decision.apps, metadata, engine, log },
    timer,
  ).finally(() => Promise.all([clearTurnEngine(userId), clearTurnConversation(userId)]));

  if (!outcome) throw new RetryableTurnError('deliver stream ended without turn_done');
  // The reply is out. The billing is queued first (Redis only), so it exists whatever happens
  // next; it runs as a job of its own once the lock is free. What the next message depends on is
  // saved before the lock goes: this engine now has the conversation up to here (a failed turn
  // is not recorded: it gets the recap again), and the message's last state. The two writes don't
  // depend on each other, so they go at once.
  await hooks.afterTurn(userId, outcome, { id: input.deliveryId, engine });
  await Promise.all([
    outcome === 'done'
      ? recordEngineTurn(userId, conversation, engine).catch((err: unknown) =>
          log.warn({ err: String(err) }, 'engine of the turn not recorded'),
        )
      : undefined,
    input.inboundMessageId
      ? setMessageStatus(input.inboundMessageId, outcome === 'done' ? 'delivered' : 'failed')
      : undefined,
  ]);
  await publish(userId, 'agent.status', { state: 'awake', lastActiveAt: new Date().toISOString() });
  return outcome;
}

export const PLATFORM_FAULT_TEXT =
  "Sorry, something went wrong on our side and I couldn't finish that. You weren't charged for it. Please try again.";

/** Never fails the turn. If even adding the refund job fails, an alert says which turn it was. */
async function refundFailedTurn(
  userId: string,
  turn: { startedAt: Date; endedAt: Date; idempotencyKey: string; engine: RuntimeName },
): Promise<void> {
  try {
    await hooks.onPlatformFault(userId, turn);
  } catch (err) {
    await alert('Refund of a failed turn not queued', {
      userId,
      key: turn.idempotencyKey,
      startedAt: turn.startedAt.toISOString(),
      endedAt: turn.endedAt.toISOString(),
      err: String(err),
    }).catch(() => {});
  }
}

/**
 * Delivers the turn and follows its stream to the end. Null: the stream ended with no result.
 * `metadata` is what the platform adds to the delivery's metadata; it wins over the input's own.
 */
async function deliverTurn(
  input: TurnInput,
  turn: {
    text: string;
    apps: string[] | undefined;
    metadata: Record<string, unknown>;
    /** The engine the turn runs on (its refund needs it). */
    engine: RuntimeName;
    log: ReturnType<typeof logger>;
  },
  timer: TurnTimer,
): Promise<TurnOutcome | null> {
  const { userId } = input;
  const { text, log } = turn;
  const startedAt = new Date();
  timer.mark('deliver_sent');
  const progress = { crewLines: 0 };
  // Whether a draft of the answer was shown in the web app during this turn.
  let drafted = false;
  let outcome: TurnOutcome | null = null;
  const stream = vm().deliver({
    userId,
    deliveryId: input.deliveryId,
    kind: KIND[input.kind],
    sessionKey: input.sessionKey,
    channel: input.channel,
    text,
    attachments: (input.attachments ?? [])
      .filter((a) => a.path)
      .map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, url: signedFileUrl(a.id) })),
    approvalId: input.approval?.id ?? '',
    approved: input.approval?.approved ?? false,
    metadataJson: JSON.stringify({
      ...input.metadata,
      ...(turn.apps?.length ? { apps: turn.apps } : {}),
      ...turn.metadata,
    }),
  });

  for await (const ev of stream) {
    switch (ev.type) {
      case DeliverEventType.ACCEPTED:
        timer.mark('accepted');
        if (input.inboundMessageId) await setMessageStatus(input.inboundMessageId, 'processing');
        await publish(userId, 'agent.status', {
          state: 'busy',
          lastActiveAt: new Date().toISOString(),
        });
        break;
      case DeliverEventType.WORKING:
        timer.mark('first_progress');
        await reportProgress(input, ev, progress);
        break;
      case DeliverEventType.TEXT_DELTA:
        if (ev.message) timer.mark('first_draft');
        if (await publishDraft(input, ev)) drafted = true;
        break;
      case DeliverEventType.TURN_DONE:
        timer.mark('turn_done');
        timer.noteBridge(ev.timingsJson);
        outcome = 'done';
        break;
      case DeliverEventType.ERROR: {
        timer.mark('turn_done');
        timer.noteBridge(ev.timingsJson);
        outcome = 'error';
        log.warn({ platformFault: ev.platformFault, message: ev.message }, 'turn error');
        // A half-written answer goes away before the user is told the turn failed.
        if (drafted) await publishDraft(input, { message: '' });
        if (ev.platformFault) {
          // The user is told first. The refund is a job of its own (retried, given once): it
          // never holds back the reply or the message's last state.
          const endedAt = new Date();
          await queueOutbound({ userId, ...turnSays(input), text: PLATFORM_FAULT_TEXT });
          await refundFailedTurn(userId, {
            startedAt,
            endedAt,
            idempotencyKey: `fault:${input.deliveryId}`,
            engine: turn.engine,
          });
        } else {
          await queueOutbound({
            userId,
            ...turnSays(input),
            text: `I couldn't finish that: ${ev.message}`,
          });
          // Claude Code whose sign-in stopped working: forget it, Hermes answers next time.
          if (await fallBackIfClaudeSignedOut(userId)) {
            await queueOutbound({
              userId,
              ...turnSays(input),
              text: `Your Claude plan is no longer connected, so I've switched back to the standard agent. Reconnect it at ${config().WEB_APP_URL}/settings/ai`,
            });
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return outcome;
}
