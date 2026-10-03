// One agent turn: credit check → routing → wake → deliver (stream until turn done). HLD 5.2.
import { Code, ConnectError } from '@connectrpc/connect';
import { config } from '../../shared/config.ts';
import { logger } from '../../shared/logger.ts';
import { getActiveUser } from '../auth/users.ts';
import { signedFileUrl } from '../channels/files.ts';
import { setMessageStatus } from '../channels/messages.ts';
import { queueOutbound } from '../channels/outbound.ts';
import { purchaseLinksAllowed, WEB_APP_NAME } from '../channels/purchase-links.ts';
import type { MediaRef } from '../channels/schema.ts';
import { publish } from '../channels/stream.ts';
import type { Channel } from '../channels/types.ts';
import { fallBackIfClaudeSignedOut, syncRuntimeAfterWake } from './agent-settings.ts';
import { ensureSandbox } from './sandbox.ts';
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

export async function runTurn(input: TurnInput): Promise<TurnOutcome> {
  const { userId } = input;
  const log = logger().child({ userId, deliveryId: input.deliveryId });

  if (!(await hooks.hasCredits(userId))) {
    await queueOutbound({
      userId,
      sessionKey: input.sessionKey,
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
    await queueOutbound({ userId, sessionKey: input.sessionKey, text: decision.reply });
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
  await syncRuntimeAfterWake(userId, woke.sandbox);

  const startedAt = new Date();
  let outcome: TurnOutcome | null = null;
  const stream = vm().deliver({
    userId,
    deliveryId: input.deliveryId,
    kind: KIND[input.kind],
    sessionKey: input.sessionKey,
    channel: input.channel,
    text: input.text,
    attachments: (input.attachments ?? [])
      .filter((a) => a.path)
      .map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, url: signedFileUrl(a.id) })),
    approvalId: input.approval?.id ?? '',
    approved: input.approval?.approved ?? false,
    metadataJson: JSON.stringify({
      ...input.metadata,
      ...(decision.apps?.length ? { apps: decision.apps } : {}),
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
      case DeliverEventType.TURN_DONE:
        outcome = 'done';
        break;
      case DeliverEventType.ERROR: {
        outcome = 'error';
        log.warn({ platformFault: ev.platformFault, message: ev.message }, 'turn error');
        if (ev.platformFault) {
          await hooks.onPlatformFault(userId, {
            startedAt,
            endedAt: new Date(),
            idempotencyKey: `fault:${input.deliveryId}`,
          });
          await queueOutbound({
            userId,
            sessionKey: input.sessionKey,
            text: "Sorry, something went wrong on our side and I couldn't finish that. You weren't charged for it. Please try again.",
          });
        } else {
          await queueOutbound({
            userId,
            sessionKey: input.sessionKey,
            text: `I couldn't finish that: ${ev.message}`,
          });
          // Claude Code whose sign-in stopped working: forget it, Hermes answers next time.
          if (await fallBackIfClaudeSignedOut(userId)) {
            await queueOutbound({
              userId,
              sessionKey: input.sessionKey,
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

  if (!outcome) throw new RetryableTurnError('deliver stream ended without turn_done');
  if (input.inboundMessageId)
    await setMessageStatus(input.inboundMessageId, outcome === 'done' ? 'delivered' : 'failed');
  await publish(userId, 'agent.status', { state: 'awake', lastActiveAt: new Date().toISOString() });
  await hooks.afterTurn(userId, outcome);
  return outcome;
}
