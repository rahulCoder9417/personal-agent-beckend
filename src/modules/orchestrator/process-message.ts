import type { Job } from 'bullmq';
import { config, isChannelEnabled } from '../../shared/config.ts';
import { badRequest, channelDisabled, outOfCredits } from '../../shared/errors.ts';
import { enforce, hit } from '../../shared/rate-limit.ts';
import { audit } from '../admin/audit.ts';
import { findLink, linkWithCode, normalizeLinkCode, touchInbound } from '../auth/links.ts';
import { getEvent, ingestEvent } from '../events/intake.ts';
import { getUserAttachments } from '../channels/files.ts';
import { acknowledgeButton, parseInbound } from '../channels/inbound.ts';
import {
  getMessageById,
  saveInbound,
  saveWebMessage,
  setMessageEvent,
  setMessageStatus,
  type MessageRow,
} from '../channels/messages.ts';
import { queueOutbound, queueRawOutbound } from '../channels/outbound.ts';
import { sessionKeyFor, type InboundMessage } from '../channels/types.ts';
import { IGNORED } from '../../worker/ignored.ts';
import { runTurn, userHasCredits } from './turn.ts';

/** Hooks other modules plug into the inbound path (approvals, coupons in chat). */
export interface InboundHooks {
  /** A tapped button or a yes/no answer. Return true if it was handled. */
  handleButton(userId: string, msg: InboundMessage, eventId: string): Promise<boolean>;
  /** Plain text that isn't for the agent (e.g. a coupon code). Return true if handled. */
  handleText(userId: string, text: string, sessionKey: string): Promise<boolean>;
  /**
   * Runs just before the message is saved: download media, transcribe voice (channels/media.ts).
   * Returns the message to save (media with local paths, transcripts appended to the text).
   */
  prepareInbound(userId: string, msg: InboundMessage, eventId: string): Promise<InboundMessage>;
}

let inboundHooks: InboundHooks = {
  handleButton: async () => false,
  handleText: async () => false,
  prepareInbound: async (_userId, msg) => msg,
};

export function setInboundHooks(h: Partial<InboundHooks>): void {
  inboundHooks = { ...inboundHooks, ...h };
}

export function linkInstructionsText(): string {
  return `Hi! This chat isn't linked to an account yet. Open ${config().WEB_APP_URL}, go to Settings → Channels, and send me the code you get there.`;
}

/**
 * inbound/process-message: a chat message from WhatsApp / Telegram / iMessage.
 * Unknown senders only get the "please link" reply; the message never reaches an agent.
 */
export async function handleProcessMessage(job: Job): Promise<unknown> {
  const { eventId } = job.data as { eventId: string };
  const event = await getEvent(eventId);
  if (!event) return IGNORED;
  const msg = parseInbound(event.source, event.payload);
  if (!msg) return IGNORED;
  // Queued before its channel was switched off: no work, no reply (HLD 0.3).
  if (!isChannelEnabled(msg.channel)) return IGNORED;

  const link = await findLink(msg.channel, msg.externalChatId);
  if (!link) {
    await handleUnlinked(msg, eventId);
    return IGNORED;
  }
  await touchInbound(link.id);
  const userId = link.userId;
  const sessionKey = sessionKeyFor(msg.channel, msg.externalChatId);

  if (msg.buttonReply) {
    await acknowledgeButton(msg.channel, msg.buttonReply.callbackId);
    if (await inboundHooks.handleButton(userId, msg, eventId)) return null;
    return IGNORED;
  }
  // A code sent again from an already-linked chat.
  if (normalizeLinkCode(msg.text) && msg.text.trim().length < 20) {
    await queueOutbound({
      userId,
      sessionKey,
      text: 'This chat is already linked to your account.',
    });
    return null;
  }
  if (await inboundHooks.handleButton(userId, msg, eventId)) return null;
  if (await inboundHooks.handleText(userId, msg.text, sessionKey)) return null;

  const prepared = await inboundHooks.prepareInbound(userId, msg, eventId);
  const saved = await saveInbound({
    userId,
    channel: msg.channel,
    text: prepared.text,
    media: prepared.media,
    eventId,
    sessionKey,
    externalId: msg.externalMessageId,
  });
  if (saved.status !== 'queued') return null; // already handed to the agent by an earlier attempt
  await runTurn({
    userId,
    deliveryId: eventId,
    kind: 'message',
    sessionKey,
    channel: msg.channel,
    text: saved.text,
    attachments: saved.mediaRef ?? [],
    inboundMessageId: saved.id,
  });
  return null;
}

async function handleUnlinked(msg: InboundMessage, eventId: string): Promise<void> {
  if (msg.buttonReply) return;
  const code = normalizeLinkCode(msg.text);
  if (!code) {
    await queueRawOutbound(msg.channel, msg.externalChatId, linkInstructionsText(), eventId);
    return;
  }
  // Guessing codes: at most 10 tries per chat per hour (wrong codes count).
  const attempt = await hit({
    key: `link:${msg.channel}:${msg.externalChatId}`,
    max: 10,
    windowSeconds: 3600,
  });
  if (!attempt.allowed) {
    await queueRawOutbound(
      msg.channel,
      msg.externalChatId,
      'Too many attempts. Please try again in an hour.',
      eventId,
    );
    return;
  }
  const result = await linkWithCode({
    code,
    channel: msg.channel,
    externalId: msg.externalChatId,
    displayId: msg.displayId,
  });
  if (!result.ok) {
    const text =
      result.reason === 'linked_to_other_user'
        ? 'This chat is already linked to another account. Unlink it there first.'
        : 'That code is invalid or expired. Get a new one in the web app (codes last 10 minutes).';
    await queueRawOutbound(msg.channel, msg.externalChatId, text, eventId);
    return;
  }
  if (!result.alreadyLinked) {
    await audit({
      userId: result.link.userId,
      actor: 'user',
      action: 'channel_linked',
      summary: `Linked ${msg.channel} ${msg.displayId}`,
    });
  }
  await queueOutbound({
    userId: result.link.userId,
    sessionKey: sessionKeyFor(msg.channel, msg.externalChatId),
    text: '✅ Linked! You can chat with your agent right here. What can I do for you?',
  });
}

/**
 * A message the user sends in web chat (POST /v1/messages): the channel must be on, at most 30 a
 * minute, refused at zero credits, saved once per `clientMessageId`, and the turn is queued as an
 * inbound job. Returns at once; the worker runs the turn. Throws the api's errors (403
 * channel_disabled, 429, 402 out_of_credits, 400).
 */
export async function sendWebMessage(
  userId: string,
  input: { text: string; clientMessageId: string; attachmentIds?: string[] },
): Promise<{ message: MessageRow; eventId: string }> {
  if (!isChannelEnabled('web')) throw channelDisabled('web');
  await enforce({ key: `msg:user:${userId}`, max: 30, windowSeconds: 60 });
  if (!(await userHasCredits(userId))) throw outOfCredits();
  const ids = input.attachmentIds ?? [];
  const files = await getUserAttachments(userId, ids);
  if (files.length !== ids.length) throw badRequest('Unknown attachment');
  const { message, created } = await saveWebMessage({
    userId,
    text: input.text,
    clientMessageId: input.clientMessageId,
    media: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, path: f.path })),
  });
  const { eventId } = await ingestEvent({
    source: 'web',
    externalId: `${userId}:${input.clientMessageId}`,
    type: 'message',
    userId,
    payload: { messageId: message.id },
    queue: 'inbound',
    jobName: 'web-message',
    jobData: { messageId: message.id },
  });
  if (created) await setMessageEvent(message.id, eventId);
  return { message, eventId };
}

/** inbound/web-message: a message sent from the web app. */
export async function handleWebMessage(job: Job): Promise<unknown> {
  const { messageId, eventId, userId } = job.data as {
    messageId: string;
    eventId: string;
    userId: string;
  };
  const msg = await getMessageById(messageId);
  if (!msg || msg.userId !== userId) return IGNORED;
  if (msg.status !== 'queued') return null;
  const sessionKey = 'web';
  if (await inboundHooks.handleText(userId, msg.text, sessionKey)) {
    await setMessageStatus(msg.id, 'delivered');
    return null;
  }
  await runTurn({
    userId,
    deliveryId: eventId,
    kind: 'message',
    sessionKey,
    channel: 'web',
    text: msg.text,
    attachments: msg.mediaRef ?? [],
    inboundMessageId: msg.id,
  });
  return null;
}
