import type { Job } from 'bullmq';
import { db } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { logger } from '../../shared/logger.ts';
import { addJob } from '../events/queues.ts';
import { adapterFor } from './adapters/index.ts';
import { getMessageById, setMessageStatus, toApiMessage, type MessageRow } from './messages.ts';
import { messages } from './schema.ts';
import { publish } from './stream.ts';
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
  template?: OutboundContent['template'];
}

/**
 * Saves an outgoing message and queues it (always via the outbound queue).
 * Buttons/templates travel in the job data.
 */
export async function queueOutbound(input: OutboundInput): Promise<MessageRow> {
  const parsed = parseSessionKey(input.sessionKey);
  if (!parsed) throw new Error(`bad session key ${input.sessionKey}`);
  const [row] = await db()
    .insert(messages)
    .values({
      id: newId('msg'),
      userId: input.userId,
      channel: parsed.channel,
      direction: 'out',
      text: input.text,
      status: 'queued',
      approvalId: input.approvalId ?? null,
      sessionKey: input.sessionKey,
    })
    .returning();
  await publish(input.userId, 'message.created', toApiMessage(row!));
  await addJob(
    'outbound',
    'send-message',
    { messageId: row!.id, buttons: input.buttons ?? null, template: input.template ?? null },
    { jobId: `send-${row!.id}` },
  );
  return row!;
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
  try {
    const content = await transform(msg, {
      text: msg.text,
      ...(data.buttons ? { buttons: data.buttons } : {}),
      ...(data.template ? { template: data.template } : {}),
    });
    const result = await adapterFor(target.channel).send(target.externalChatId ?? '', content);
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
  try {
    await adapterFor(d.channel).send(d.externalChatId, { text: d.text });
  } catch (err) {
    if (err instanceof RecipientBlockedError) return null;
    throw err;
  }
  return null;
}
