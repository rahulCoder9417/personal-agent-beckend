// One agent turn: credit check → routing → wake → deliver (stream until turn done). HLD 5.2.
import { Code, ConnectError } from '@connectrpc/connect';
import { config } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { redis } from '../../shared/redis.ts';
import { alert } from '../admin/alerts.ts';
import { audit } from '../admin/audit.ts';
import { getActiveUser } from '../auth/users.ts';
import { conversationFor } from '../channels/conversations.ts';
import { signedFileUrl } from '../channels/files.ts';
import { setMessageStatus } from '../channels/messages.ts';
import { queueOutbound } from '../channels/outbound.ts';
import { purchaseLinksAllowed, WEB_APP_NAME } from '../channels/purchase-links.ts';
import type { MediaRef } from '../channels/schema.ts';
import { publish } from '../channels/stream.ts';
import type { Channel } from '../channels/types.ts';
import {
  claudeTurnOptions,
  fallBackIfClaudeSignedOut,
  syncRuntimeAfterWake,
  type RuntimeName,
} from './agent-settings.ts';
import { syncBrowserAfterWake } from './browser.ts';
import { crewOfProgress } from './crew.ts';
import { ensureSandbox } from './sandbox.ts';
import { recordEngineTurn, turnText } from './turn-context.ts';
import { DeliverEventType, DeliverKind, planPriority, vm } from './vm.ts';

export type TurnKind = 'message' | 'approval_answer' | 'automation' | 'app_event';

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
   * The conversation the turn belongs to: the inbound message's own, or the one an automation's
   * runs reply in. Left out (an automation on a chat app) or no longer there: the chat's active
   * one.
   */
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export type RouteDecision =
  { kind: 'task'; apps?: string[] } | { kind: 'simple'; reply: string } | { kind: 'spam' };

export type TurnOutcome = 'done' | 'out_of_credits' | 'simple' | 'spam' | 'error';

/** Filled in by other modules (billing, Jev routing). Defaults keep a turn working without them. */
export interface TurnHooks {
  hasCredits(userId: string): Promise<boolean>;
  route(input: TurnInput): Promise<RouteDecision>;
  afterTurn(userId: string, outcome: TurnOutcome): Promise<void>;
  /** The turn failed on our side: queue its refund (billing). Quick; never does the refund here. */
  onPlatformFault(
    userId: string,
    turn: { startedAt: Date; endedAt: Date; idempotencyKey: string },
  ): Promise<void>;
}

let hooks: TurnHooks = {
  hasCredits: async () => true,
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
// opened another web conversation meanwhile. The agent's tools only know the chat (the session
// key), so the worker records the turn's conversation when it delivers it, like the engine above.

const turnConversationKey = (userId: string) => `turn-conversation:${userId}`;

/** Never fails the turn: without the record a reply goes to the chat's active conversation. */
async function recordTurnConversation(
  userId: string,
  sessionKey: string,
  conversationId: string,
): Promise<void> {
  try {
    await redis().set(
      turnConversationKey(userId),
      JSON.stringify({ sessionKey, conversationId }),
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
 * The conversation of the user's turn in progress, when that turn is in this chat. Null: no turn
 * in progress, another chat's turn, or not known.
 */
export async function turnConversationId(
  userId: string,
  sessionKey: string,
): Promise<string | null> {
  try {
    const raw = await redis().get(turnConversationKey(userId));
    if (!raw) return null;
    const record = JSON.parse(raw) as { sessionKey?: string; conversationId?: string };
    return record.sessionKey === sessionKey && record.conversationId ? record.conversationId : null;
  } catch (err) {
    logger().warn({ userId, err: String(err) }, 'conversation of the turn not readable');
    return null;
  }
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

export async function runTurn(given: TurnInput): Promise<TurnOutcome> {
  const { userId } = given;
  const log = logger().child({ userId, deliveryId: given.deliveryId });
  // The turn's conversation: the message's own, else the chat's active one. Everything the turn
  // saves and everything the agent is given comes from this one conversation.
  const conversation = await conversationFor(userId, given.sessionKey, given.conversationId);
  const input: TurnInput = { ...given, conversationId: conversation.id };

  if (!(await hooks.hasCredits(userId))) {
    await queueOutbound({
      userId,
      sessionKey: input.sessionKey,
      conversationId: conversation.id,
      text: outOfCreditsText(input.channel),
    });
    if (input.inboundMessageId) await setMessageStatus(input.inboundMessageId, 'delivered');
    return 'out_of_credits';
  }

  const decision = await hooks.route(input);
  if (decision.kind === 'spam') {
    if (input.inboundMessageId) await setMessageStatus(input.inboundMessageId, 'delivered');
    return 'spam';
  }
  if (decision.kind === 'simple') {
    await queueOutbound({
      userId,
      sessionKey: input.sessionKey,
      conversationId: conversation.id,
      text: decision.reply,
    });
    if (input.inboundMessageId) await setMessageStatus(input.inboundMessageId, 'delivered');
    await hooks.afterTurn(userId, 'simple');
    return 'simple';
  }

  const user = await getActiveUser(userId);
  if (!user) return 'error';

  await ensureSandbox(userId);
  await publish(userId, 'agent.status', { state: 'waking', lastActiveAt: null });
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
  // The container runs the agent the user's settings say (Hermes or Claude Code).
  const engine = await syncRuntimeAfterWake(userId, woke.sandbox);
  // Scout's browser is on for this container only if the plan says so (HLD 11.3).
  await syncBrowserAfterWake(userId, user.plan, woke.sandbox);
  // What is known about the user (the same in every conversation), and a recap of this
  // conversation if the engine changed (HLD 0.9).
  const text = await turnText({ ...input, conversation }, engine);
  // What the platform adds to the delivery's metadata: the conversation's number in its chat,
  // always. The Bridge keeps one engine conversation per number, so this turn continues its own
  // conversation's context; the number is lower than the chat's highest when the user went back
  // to an earlier conversation. On Claude Code also the model and the effort the user chose (each
  // left out when it is Claude Code's default).
  const metadata: Record<string, unknown> = {
    chat_epoch: conversation.epoch,
    ...(engine === 'claude_code' ? { claude: await claudeTurnOptions(userId) } : {}),
  };

  // From here until the turn ends, read_page knows which engine is calling it (HLD 5.1), and what
  // the agent sends to this chat is saved in the turn's conversation.
  await recordTurnEngine(userId, engine);
  await recordTurnConversation(userId, input.sessionKey, conversation.id);
  const outcome = await deliverTurn(input, { text, apps: decision.apps, metadata, log }).finally(
    () => Promise.all([clearTurnEngine(userId), clearTurnConversation(userId)]),
  );

  if (!outcome) throw new RetryableTurnError('deliver stream ended without turn_done');
  // This engine now has the conversation up to here. A failed turn is not recorded: it gets the
  // recap again.
  if (outcome === 'done')
    await recordEngineTurn(userId, conversation, engine).catch((err: unknown) =>
      log.warn({ err: String(err) }, 'engine of the turn not recorded'),
    );
  if (input.inboundMessageId)
    await setMessageStatus(input.inboundMessageId, outcome === 'done' ? 'delivered' : 'failed');
  await publish(userId, 'agent.status', { state: 'awake', lastActiveAt: new Date().toISOString() });
  await hooks.afterTurn(userId, outcome);
  return outcome;
}

export const PLATFORM_FAULT_TEXT =
  "Sorry, something went wrong on our side and I couldn't finish that. You weren't charged for it. Please try again.";

/** Never fails the turn. If even adding the refund job fails, an alert says which turn it was. */
async function refundFailedTurn(
  userId: string,
  turn: { startedAt: Date; endedAt: Date; idempotencyKey: string },
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
    log: ReturnType<typeof logger>;
  },
): Promise<TurnOutcome | null> {
  const { userId } = input;
  const { text, log } = turn;
  const startedAt = new Date();
  const progress = { crewLines: 0 };
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
        if (input.inboundMessageId) await setMessageStatus(input.inboundMessageId, 'processing');
        await publish(userId, 'agent.status', {
          state: 'busy',
          lastActiveAt: new Date().toISOString(),
        });
        break;
      case DeliverEventType.WORKING:
        await reportProgress(input, ev, progress);
        break;
      case DeliverEventType.TURN_DONE:
        outcome = 'done';
        break;
      case DeliverEventType.ERROR: {
        outcome = 'error';
        log.warn({ platformFault: ev.platformFault, message: ev.message }, 'turn error');
        if (ev.platformFault) {
          // The user is told first. The refund is a job of its own (retried, given once): it
          // never holds back the reply or the message's last state.
          const endedAt = new Date();
          await queueOutbound({
            userId,
            sessionKey: input.sessionKey,
            conversationId: input.conversationId,
            text: PLATFORM_FAULT_TEXT,
          });
          await refundFailedTurn(userId, {
            startedAt,
            endedAt,
            idempotencyKey: `fault:${input.deliveryId}`,
          });
        } else {
          await queueOutbound({
            userId,
            sessionKey: input.sessionKey,
            conversationId: input.conversationId,
            text: `I couldn't finish that: ${ev.message}`,
          });
          // Claude Code whose sign-in stopped working: forget it, Hermes answers next time.
          if (await fallBackIfClaudeSignedOut(userId)) {
            await queueOutbound({
              userId,
              sessionKey: input.sessionKey,
              conversationId: input.conversationId,
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
