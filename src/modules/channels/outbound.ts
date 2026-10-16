import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { isChannelEnabled } from '../../shared/config.ts';
import { db } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { addJob } from '../events/queues.ts';
import { sendToChat } from './adapters/index.ts';
import { conversationFor, noteMessage, type ConversationRow } from './conversations.ts';
import { getMessageById, setMessageStatus, toApiMessage, type MessageRow } from './messages.ts';
import { messages } from './schema.ts';
import { publish } from './stream.ts';
import { inQuietHours } from './notify.ts';
import { noteSendingToChat } from './typing.ts';
import {
  parseSessionKey,
  RecipientBlockedError,
  type Button,
  type OutboundContent,
} from './types.ts';

export interface OutboundInput {
  userId: string;
  /** e.g. `telegram:12345` or `web`. */
  sessionKey: string;
  text: string;
  buttons?: Button[];
  approvalId?: string;
  /** The message carries a draft the agent proposed (the automations module's). */
  automationDraftId?: string;
  template?: OutboundContent['template'];
  /**
   * The conversation to save it in: the turn's own, when the message is written during a turn.
   * Left out (or no longer there): the chat's active one.
   */
  conversationId?: string | null;
  /**
   * `conversationId` is the Automations chat: when it is gone (the user deleted it during a run),
   * a new Automations chat rather than the chat's active conversation.
   */
  inAutomationsChat?: boolean;
  /**
   * The row of `conversationId`, read already by the caller (undefined there: it is gone), so it
   * is not read again. Left out: it is read here.
   */
  knownConversation?: ConversationRow | null;
  /** The turn it is written in (its delivery id): saved with it, so the turn's reply is found. */
  turnId?: string | null;
  /**
   * It is a copy of that message, which is kept in another conversation. Saved and sent once:
   * asked again, the copy already made is returned and nothing is sent twice. A copy never
   * becomes part of the agent's context in its conversation.
   */
  copyOf?: string;
}

const sendJob = (row: MessageRow, input: Pick<OutboundInput, 'buttons' | 'template'>) =>
  addJob(
    'outbound',
    'send-message',
    { messageId: row.id, buttons: input.buttons ?? null, template: input.template ?? null },
    { jobId: `send-${row.id}` },
  );

/**
 * Saves an outgoing message in its conversation and queues it (always via the outbound queue).
 * Buttons/templates travel in the job data.
 */
export async function queueOutbound(input: OutboundInput): Promise<MessageRow> {
  const parsed = parseSessionKey(input.sessionKey);
  if (!parsed) throw new Error(`bad session key ${input.sessionKey}`);
  const conversation = await conversationFor(input.userId, input.sessionKey, input.conversationId, {
    automations: input.inAutomationsChat === true,
    ...(input.knownConversation !== undefined ? { known: input.knownConversation } : {}),
  });
  const [row] = await db()
    .insert(messages)
    .values({
      id: newId('msg'),
      userId: input.userId,
      conversationId: conversation.id,
      channel: parsed.channel,
      direction: 'out',
      text: input.text,
      status: 'queued',
      approvalId: input.approvalId ?? null,
      automationDraftId: input.automationDraftId ?? null,
      sessionKey: input.sessionKey,
      eventId: input.turnId ?? null,
      copyOf: input.copyOf ?? null,
    })
    .onConflictDoNothing({ target: [messages.userId, messages.copyOf] })
    .returning();
  if (!row) {
    // A copy made before (the job ran again). Its send is queued again only while it is still
    // waiting to go: the queue knows the job by the message's id, and a sent one is skipped.
    const [made] = await db()
      .select()
      .from(messages)
      .where(and(eq(messages.userId, input.userId), eq(messages.copyOf, input.copyOf!)));
    if (made?.status === 'queued') await sendJob(made, input);
    return made!;
  }
  await publish(input.userId, 'message.created', toApiMessage(row));
  // The send is queued first: it is what the user waits for. The conversation's last-message time
  // (the order of the chat list) comes after it and never fails the message, which is saved and on
  // its way already: a caller that saw an error here would send it again, and the user would get
  // it twice.
  await sendJob(row, input);
  await noteMessage(row).catch((err: unknown) =>
    logger().warn(
      { userId: input.userId, messageId: row.id, err: String(err) },
      "conversation's last message time not updated",
    ),
  );
  return row;
}

/** Sends to a chat that isn't linked to anyone (link instructions). No message row. */
export async function queueRawOutbound(
  channel: 'telegram' | 'whatsapp' | 'imessage',
  externalChatId: string,
  text: string,
  dedupeKey: string,
) {
  await addJob(
    'outbound',
    'send-raw',
    { channel, externalChatId, text },
    { jobId: `raw-${dedupeKey}` },
  );
}

export type BlockedHandler = (userId: string, sessionKey: string) => Promise<void>;
let onBlocked: BlockedHandler = async () => {};
export function setBlockedHandler(fn: BlockedHandler): void {
  onBlocked = fn;
}
/** A provider receipt says the recipient can't be reached (e.g. WhatsApp 131026). */
export function reportBlocked(userId: string, sessionKey: string): Promise<void> {
  return onBlocked(userId, sessionKey);
}

export type ContentTransformer = (
  msg: MessageRow,
  content: OutboundContent,
) => Promise<OutboundContent>;
let transform: ContentTransformer = async (_m, c) => c;
/** WhatsApp's 24-hour rule plugs in here (template outside the window). */
export function setContentTransformer(fn: ContentTransformer): void {
  transform = fn;
}

/** outbound/send-message. Safe to re-run: a message already sent is skipped. */
export async function handleSendMessage(job: Job): Promise<unknown> {
  const data = job.data as {
    messageId: string;
    buttons: Button[] | null;
    template: OutboundContent['template'] | null;
  };
  const msg = await getMessageById(data.messageId);
  if (!msg || msg.status !== 'queued') return null;
  const target = parseSessionKey(msg.sessionKey ?? '');
  if (!target) {
    await setMessageStatus(msg.id, 'failed');
    return null;
  }
  // Nothing is ever sent to a channel that is switched off (HLD 0.3).
  if (!isChannelEnabled(target.channel)) {
    logger().warn({ userId: msg.userId, channel: target.channel }, 'channel is switched off');
    await setMessageStatus(msg.id, 'failed');
    return null;
  }
  try {
    const content = await transform(msg, {
      text: msg.text,
      ...(data.buttons ? { buttons: data.buttons } : {}),
      ...(data.template ? { template: data.template } : {}),
    });
    // The user's quiet hours: a Telegram message still goes now, without a sound.
    if (target.channel === 'telegram' && (await inQuietHours(msg.userId))) content.silent = true;
    // The saved message keeps the text as it was written; a chat app gets it as plain text.
    // "typing…" in that chat pauses first, so it can't come back under this message.
    await noteSendingToChat(target.channel, target.externalChatId ?? '');
    const result = await sendToChat(target.channel, target.externalChatId ?? '', content);
    await setMessageStatus(msg.id, 'sent', result.externalId);
  } catch (err) {
    if (err instanceof RecipientBlockedError) {
      logger().warn({ userId: msg.userId, channel: target.channel }, 'recipient blocked us');
      await setMessageStatus(msg.id, 'failed');
      await onBlocked(msg.userId, msg.sessionKey!);
      return null;
    }
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) await setMessageStatus(msg.id, 'failed');
    throw err;
  }
  return null;
}

/** outbound/send-raw */
export async function handleSendRaw(job: Job): Promise<unknown> {
  const d = job.data as {
    channel: 'telegram' | 'whatsapp' | 'imessage';
    externalChatId: string;
    text: string;
  };
  if (!isChannelEnabled(d.channel)) return null;
  try {
    await noteSendingToChat(d.channel, d.externalChatId);
    await sendToChat(d.channel, d.externalChatId, { text: d.text });
  } catch (err) {
    if (err instanceof RecipientBlockedError) return null;
    throw err;
  }
  return null;
}
