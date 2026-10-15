import type { Job } from 'bullmq';
import { config, isChannelEnabled } from '../../shared/config.ts';
import { redis } from '../../shared/redis.ts';
import { badRequest, channelDisabled, outOfCredits } from '../../shared/errors.ts';
import { enforce, hit } from '../../shared/rate-limit.ts';
import { audit } from '../admin/audit.ts';
import {
  findLink,
  linkCodeOwner,
  linkWithCode,
  normalizeLinkCode,
  touchInbound,
} from '../auth/links.ts';
import { isSuspended } from '../auth/users.ts';
import { getEvent, ingestEvent } from '../events/intake.ts';
import { getUserAttachments } from '../channels/files.ts';
import { acknowledgeButton, parseInbound } from '../channels/inbound.ts';
import {
  getMessageById,
  getWebMessage,
  saveInbound,
  saveWebMessage,
  setMessageEvent,
  setMessageStatus,
  type MessageRow,
} from '../channels/messages.ts';
import { queueOutbound, queueRawOutbound } from '../channels/outbound.ts';
import { sessionKeyFor, type InboundMessage } from '../channels/types.ts';
import { IGNORED } from '../../worker/ignored.ts';
import {
  isNewChatCommand,
  NEW_CHAT_TEXT,
  startNewChat,
  webConversationToWriteIn,
} from './chats.ts';
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
  // The chat wrote: its last-inbound time, and its "blocked" mark is cleared. Nothing before the
  // turn reads them, so the write runs beside the steps below: one round trip to the database
  // fewer before the agent gets the message. The turn starts only once it is saved (an agent's
  // reply checks the blocked mark), and every path waits for it, so a failed write still fails
  // the job, which then runs again (every step is safe to re-run).
  const touched = touchInbound(link.id);
  touched.catch(() => {}); // awaited below, on every path
  let result: unknown;
  try {
    result = await linkedMessage(msg, link.userId, eventId, touched);
  } catch (err) {
    await touched.catch(() => {});
    throw err;
  }
  await touched;
  return result;
}

/** A message from a linked chat: the special cases, else it is saved and goes to the agent. */
async function linkedMessage(
  msg: InboundMessage,
  userId: string,
  eventId: string,
  touched: Promise<void>,
): Promise<unknown> {
  const sessionKey = sessionKeyFor(msg.channel, msg.externalChatId);
  if (await isSuspended(userId)) {
    await holdWhileSuspended(msg, userId, sessionKey, eventId);
    return null;
  }

  if (msg.buttonReply) {
    await acknowledgeButton(msg.channel, msg.buttonReply.callbackId);
    if (await inboundHooks.handleButton(userId, msg, eventId)) return null;
    return IGNORED;
  }
  // A code sent from a chat that is already linked (typed, or `/start <code>` from the deep link).
  const bare = msg.text.trim().replace(/^\/start\s+/i, '');
  const code = normalizeLinkCode(bare);
  if (code && bare.length < 20) {
    await replyToCodeInLinkedChat(msg, userId, code, eventId);
    return null;
  }
  // `/new` (or `/clear`, `/reset`) in Telegram: a new conversation starts in that chat and is its
  // active one from now on. No turn, no credits. The command and the answer are not saved as
  // messages, so they are part of neither conversation.
  if (msg.channel === 'telegram' && isNewChatCommand(msg.text)) {
    await startNewChat(userId, sessionKey, { channel: msg.channel, key: eventId });
    await queueRawOutbound(msg.channel, msg.externalChatId, NEW_CHAT_TEXT, eventId);
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
  await touched;
  await runTurn({
    userId,
    deliveryId: eventId,
    kind: 'message',
    sessionKey,
    channel: msg.channel,
    text: saved.text,
    attachments: saved.mediaRef ?? [],
    inboundMessageId: saved.id,
    conversationId: saved.conversationId,
  });
  return null;
}

/** What a chat of a suspended account is told, at most once a day. */
export const SUSPENDED_TEXT =
  "Your Textcrew account is suspended, so I can't answer messages right now.";
/** One notice a day per chat. */
export const SUSPENDED_NOTICE_SECONDS = 24 * 60 * 60;

/**
 * An admin suspended the account. The message is saved, as it came (no file is downloaded, no
 * voice note is transcribed), and marked handled: it is never answered, also not after the
 * suspension is lifted. A tapped button is only acknowledged. Nothing else runs: no link code, no
 * `/new`, no coupon, no approval. The chat gets one short notice, at most once a day; a job that
 * runs again sends none.
 */
async function holdWhileSuspended(
  msg: InboundMessage,
  userId: string,
  sessionKey: string,
  eventId: string,
): Promise<void> {
  if (msg.buttonReply) {
    await acknowledgeButton(msg.channel, msg.buttonReply.callbackId);
  } else {
    const saved = await saveInbound({
      userId,
      channel: msg.channel,
      text: msg.text,
      media: msg.media,
      eventId,
      sessionKey,
      externalId: msg.externalMessageId,
    });
    if (saved.status === 'queued') await setMessageStatus(saved.id, 'delivered');
  }
  const first = await redis()
    .set(`suspended-notice:${userId}:${sessionKey}`, eventId, 'EX', SUSPENDED_NOTICE_SECONDS, 'NX')
    .catch(() => null);
  if (first === 'OK')
    await queueRawOutbound(msg.channel, msg.externalChatId, SUSPENDED_TEXT, `suspended-${eventId}`);
}

const TOO_MANY_LINK_TRIES = 'Too many attempts. Please try again in an hour.';

function linkedElsewhereText(): string {
  return `This chat is linked to another Textcrew account. Unlink it there first: sign in to that account at ${config().WEB_APP_URL} and remove the chat in Settings → Channels. Then send your code again.`;
}

/** Guessing codes: at most 10 tries per chat per hour, linked or not (wrong codes count). */
async function linkTryAllowed(msg: InboundMessage): Promise<boolean> {
  const attempt = await hit({
    key: `link:${msg.channel}:${msg.externalChatId}`,
    max: 10,
    windowSeconds: 3600,
  });
  return attempt.allowed;
}

/**
 * A code from a chat that is linked already. The code is never used: a linked chat moves to
 * another account only after it is unlinked in the web app. The reply says which case it is and
 * nothing about the other account. One reply per event, even if the job runs again.
 */
async function replyToCodeInLinkedChat(
  msg: InboundMessage,
  userId: string,
  code: string,
  eventId: string,
): Promise<void> {
  let text = TOO_MANY_LINK_TRIES;
  if (await linkTryAllowed(msg)) {
    const owner = await linkCodeOwner(code, msg.channel);
    text =
      owner && owner !== userId
        ? linkedElsewhereText()
        : 'This chat is already linked to your account.';
  }
  await queueRawOutbound(msg.channel, msg.externalChatId, text, eventId);
}

async function handleUnlinked(msg: InboundMessage, eventId: string): Promise<void> {
  if (msg.buttonReply) return;
  const code = normalizeLinkCode(msg.text);
  if (!code) {
    await queueRawOutbound(msg.channel, msg.externalChatId, linkInstructionsText(), eventId);
    return;
  }
  if (!(await linkTryAllowed(msg))) {
    await queueRawOutbound(msg.channel, msg.externalChatId, TOO_MANY_LINK_TRIES, eventId);
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
        ? linkedElsewhereText()
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
 * inbound job. It goes into web chat's active conversation, or into the web conversation named,
 * which becomes the active one first. Returns at once; the worker runs the turn. Throws the api's
 * errors (403 channel_disabled, 429, 402 out_of_credits, 400, and for a named conversation 404 or
 * 409).
 */
export async function sendWebMessage(
  userId: string,
  input: {
    text: string;
    clientMessageId: string;
    attachmentIds?: string[];
    conversationId?: string;
  },
): Promise<{ message: MessageRow; eventId: string }> {
  if (!isChannelEnabled('web')) throw channelDisabled('web');
  await enforce({ key: `msg:user:${userId}`, max: 30, windowSeconds: 60 });
  const ids = input.attachmentIds ?? [];
  // Three reads that don't depend on each other, at once: each is a round trip to the database.
  const [credits, files, sent] = await Promise.all([
    userHasCredits(userId),
    getUserAttachments(userId, ids),
    // The same message sent again changes nothing, not even which conversation is active.
    getWebMessage(userId, input.clientMessageId),
  ]);
  if (!credits) throw outOfCredits();
  if (files.length !== ids.length) throw badRequest('Unknown attachment');
  const conversationId =
    sent?.conversationId ?? (await webConversationToWriteIn(userId, input.conversationId)).id;
  const { message, created } = await saveWebMessage({
    userId,
    text: input.text,
    clientMessageId: input.clientMessageId,
    media: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, path: f.path })),
    conversationId,
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
    // The message's own conversation, also when the user has opened another one since.
    conversationId: msg.conversationId,
  });
  return null;
}
