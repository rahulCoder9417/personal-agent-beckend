import type { Job } from 'bullmq';
import { config, isChannelEnabled } from '../../shared/config.ts';
import { redis } from '../../shared/redis.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
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
import { acknowledgeButton, isApprovalButton, parseInbound } from '../channels/inbound.ts';
import {
  getMessageById,
  getWebMessage,
  insertWebMessage,
  saveInbound,
  setMessageEvent,
  setMessageStatus,
  toApiMessage,
  type MessageRow,
} from '../channels/messages.ts';
import { noteMessage } from '../channels/conversations.ts';
import { publish } from '../channels/stream.ts';
import { queueOutbound, queueRawOutbound } from '../channels/outbound.ts';
import { sessionKeyFor, type InboundMessage } from '../channels/types.ts';
import { whileTyping } from '../channels/typing.ts';
import { IGNORED } from '../../worker/ignored.ts';
import {
  isNewChatCommand,
  NEW_CHAT_TEXT,
  readWebConversation,
  settleWebConversation,
  startNewChat,
} from './chats.ts';
import { helpText, isHelpCommand, linkedText } from './help-command.ts';
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

/** The web app's Integrations page, where the user links and unlinks chats (the Chat apps tab). */
export function integrationsPageUrl(): string {
  return `${config().WEB_APP_URL.replace(/\/+$/, '')}/integrations`;
}

export function linkInstructionsText(): string {
  return `Hi! This chat isn't linked to an account yet. Open Integrations at ${integrationsPageUrl()} and send me the code you get there.`;
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
  return processInbound(msg, eventId);
}

/**
 * system/approval-button: a tap on an approval's ✅ / ❌ button in a chat app. It runs no turn, so
 * it does not wait for the user's lock (which inbound jobs take): the answer, and an approved app
 * action with it, goes through while Tex is busy with another message. Anything that is not such a
 * tap is never handled here (it would run a turn without the lock).
 */
export async function handleApprovalButton(job: Job): Promise<unknown> {
  const { eventId } = job.data as { eventId: string };
  const event = await getEvent(eventId);
  const msg = event ? parseInbound(event.source, event.payload) : null;
  if (!msg || !isApprovalButton(msg)) return IGNORED;
  return processInbound(msg, eventId);
}

async function processInbound(msg: InboundMessage, eventId: string): Promise<unknown> {
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
  // `/help` in Telegram: our short answer with the commands and the Help page. The same rules.
  if (msg.channel === 'telegram' && isHelpCommand(msg.text)) {
    await queueRawOutbound(msg.channel, msg.externalChatId, helpText(), eventId);
    return null;
  }
  if (await inboundHooks.handleButton(userId, msg, eventId)) return null;
  if (await inboundHooks.handleText(userId, msg.text, sessionKey)) return null;

  // From here the message is for the agent: the chat shows "typing…" (Telegram) until the turn
  // is over, also while a file is downloaded or a voice note turned into text.
  return whileTyping(sessionKey, async () => {
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
  });
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
  return `This chat is linked to another Textcrew account. Unlink it there first: sign in to that account at ${integrationsPageUrl()} and unlink the chat in Integrations. Then send your code again.`;
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
    text: linkedText(msg.channel),
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
  // Every read at once, one round trip to the database (each about 0.26 s on Neon): the credits,
  // the files, whether this message was sent before, and the conversation it goes in. That last
  // one's answer is kept aside: its 404 or 409 comes after the checks above it, and a message sent
  // again does not depend on it.
  const [credits, files, sent, target] = await Promise.all([
    userHasCredits(userId),
    getUserAttachments(userId, ids),
    getWebMessage(userId, input.clientMessageId),
    readWebConversation(userId, input.conversationId).then(
      (row) => ({ row }),
      (error: unknown) => ({ error }),
    ),
  ]);
  if (!credits) throw outOfCredits();
  if (files.length !== ids.length) throw badRequest('Unknown attachment');
  // The same message sent again changes nothing, not even which conversation is active.
  if (sent) return { message: sent, eventId: await queueSavedWebMessage(userId, sent) };
  if ('error' in target) throw target.error;
  // Writes only when the conversation named is not the active one yet, or web chat has none.
  const conversation = await settleWebConversation(userId, input.conversationId, target.row);
  // The message first, then its event: an event (so a turn) only ever exists for a message saved.
  // The event's id is made here, so the message is saved with it (no third write to link them).
  const eventId = newId('evt');
  const message = await insertWebMessage({
    userId,
    text: input.text,
    clientMessageId: input.clientMessageId,
    conversationId: conversation.id,
    media: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, path: f.path })),
    eventId,
  });
  if (!message) {
    // The same message, sent twice at once, was saved by the other request a moment ago.
    const other = (await getWebMessage(userId, input.clientMessageId))!;
    return { message: other, eventId: await queueSavedWebMessage(userId, other) };
  }
  await publish(userId, 'message.created', toApiMessage(message));
  // The event and its job, and beside them the conversation's last message time and title (the
  // order of the chat list), which nothing in the turn waits for: a failure there is logged and
  // never fails a message that is on its way.
  const [queued] = await Promise.all([
    ingestEvent({ ...webMessageEvent(userId, message), id: eventId, markLater: true }),
    noteMessage(message).catch((err: unknown) =>
      logger().error({ userId, messageId: message.id, err: String(err) }, 'conversation not noted'),
    ),
  ]);
  // An event of an earlier try of this send was there already: the message points to that one.
  if (queued.eventId !== eventId) await setMessageEvent(message.id, queued.eventId);
  return { message: { ...message, eventId: queued.eventId }, eventId: queued.eventId };
}

/** The event (and inbound job) of a web message. */
function webMessageEvent(userId: string, message: MessageRow) {
  return {
    source: 'web',
    externalId: `${userId}:${message.clientMessageId}`,
    type: 'message',
    userId,
    payload: { messageId: message.id },
    queue: 'inbound' as const,
    jobName: 'web-message',
    jobData: { messageId: message.id },
  };
}

/**
 * A web message saved before (sent again): its event, made if it is missing and queued again if it
 * never was (the job's id keeps it from running twice), and the message pointed to it.
 */
async function queueSavedWebMessage(userId: string, message: MessageRow): Promise<string> {
  const { eventId } = await ingestEvent(webMessageEvent(userId, message));
  if (message.eventId !== eventId) await setMessageEvent(message.id, eventId);
  return eventId;
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
