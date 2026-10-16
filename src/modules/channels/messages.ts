import { and, desc, eq, gt, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import {
  activeConversation,
  cleanupEmptyConversations,
  deleteUserConversations,
  findActiveConversation,
  noteMessage,
} from './conversations.ts';
import { messages, type MediaRef } from './schema.ts';
import { publish } from './stream.ts';
import type { Channel } from './types.ts';

export type MessageRow = typeof messages.$inferSelect;
export type MessageStatus = MessageRow['status'];

export function toApiMessage(m: MessageRow) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    channel: m.channel,
    direction: m.direction,
    text: m.text,
    attachments: (m.mediaRef ?? []).map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType })),
    status: m.status,
    approvalId: m.approvalId,
    automationDraftId: m.automationDraftId ?? null,
    // Only the web app's own messages have one: it matches its optimistic bubble to the saved one.
    ...(m.clientMessageId ? { clientMessageId: m.clientMessageId } : {}),
    createdAt: m.createdAt.toISOString(),
  };
}

export async function getMessage(userId: string, id: string): Promise<MessageRow | undefined> {
  const [row] = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.id, id)));
  return row;
}

export async function getMessageById(id: string): Promise<MessageRow | undefined> {
  const [row] = await db().select().from(messages).where(eq(messages.id, id));
  return row;
}

/**
 * Saves an inbound chat message once per event (safe to re-run), in the chat's active
 * conversation.
 */
export async function saveInbound(input: {
  userId: string;
  channel: Channel;
  text: string;
  media?: MediaRef[];
  eventId: string;
  sessionKey: string;
  externalId?: string;
}): Promise<MessageRow> {
  // Two reads at once (one round trip, not two): whether an earlier attempt saved it already, and
  // the chat's active conversation. Both only read; a chat with no conversation yet gets one below.
  const [[existing], active] = await Promise.all([
    db()
      .select()
      .from(messages)
      .where(and(eq(messages.eventId, input.eventId), eq(messages.direction, 'in'))),
    findActiveConversation(input.userId, input.sessionKey),
  ]);
  if (existing) return existing;
  const conversation = active ?? (await activeConversation(input.userId, input.sessionKey));
  const [row] = await db()
    .insert(messages)
    .values({
      id: newId('msg'),
      userId: input.userId,
      conversationId: conversation.id,
      channel: input.channel,
      direction: 'in',
      text: input.text,
      mediaRef: input.media?.length ? input.media : null,
      status: 'queued',
      eventId: input.eventId,
      sessionKey: input.sessionKey,
      externalId: input.externalId ?? null,
    })
    .returning();
  await publish(input.userId, 'message.created', toApiMessage(row!));
  await noteMessage(row!);
  return row!;
}

/** The web message already saved for a `clientMessageId`, if any. */
export async function getWebMessage(
  userId: string,
  clientMessageId: string,
): Promise<MessageRow | undefined> {
  const [row] = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.clientMessageId, clientMessageId)));
  return row;
}

/**
 * Web message: idempotent on (user, clientMessageId). It is saved in `conversationId` (a web
 * conversation of this user: the caller checked), or in web chat's active one.
 */
export async function saveWebMessage(input: {
  userId: string;
  text: string;
  clientMessageId: string;
  media?: MediaRef[];
  conversationId?: string;
}): Promise<{ message: MessageRow; created: boolean }> {
  const conversationId = input.conversationId ?? (await activeConversation(input.userId, 'web')).id;
  const row = await insertWebMessage({ ...input, conversationId });
  if (row) {
    await announceWebMessage(row);
    return { message: row, created: true };
  }
  const existing = await getWebMessage(input.userId, input.clientMessageId);
  return { message: existing!, created: false };
}

/**
 * A web message's row, unless the user has one with this clientMessageId already (then
 * undefined). `id` and `eventId`: made by the caller, so the message and its event can be saved
 * without waiting for each other. Nothing is published: see announceWebMessage.
 */
export async function insertWebMessage(input: {
  userId: string;
  text: string;
  clientMessageId: string;
  conversationId: string;
  media?: MediaRef[];
  id?: string;
  eventId?: string;
}): Promise<MessageRow | undefined> {
  const [row] = await db()
    .insert(messages)
    .values({
      id: input.id ?? newId('msg'),
      userId: input.userId,
      conversationId: input.conversationId,
      channel: 'web',
      direction: 'in',
      text: input.text,
      mediaRef: input.media?.length ? input.media : null,
      status: 'queued',
      clientMessageId: input.clientMessageId,
      sessionKey: 'web',
      ...(input.eventId ? { eventId: input.eventId } : {}),
    })
    .onConflictDoNothing({ target: [messages.userId, messages.clientMessageId] })
    .returning();
  return row;
}

/** A new web message on the live stream, and its conversation's last message time and title. */
export async function announceWebMessage(row: MessageRow): Promise<void> {
  await publish(row.userId, 'message.created', toApiMessage(row));
  await noteMessage(row);
}

export async function setMessageEvent(id: string, eventId: string): Promise<void> {
  await db().update(messages).set({ eventId }).where(eq(messages.id, id));
}

export async function setMessageStatus(
  id: string,
  status: MessageStatus,
  externalId?: string,
): Promise<MessageRow | undefined> {
  const [row] = await db()
    .update(messages)
    .set({ status, ...(externalId ? { externalId } : {}) })
    .where(eq(messages.id, id))
    .returning();
  if (row) await publish(row.userId, 'message.status', toApiMessage(row));
  return row;
}

/** Statuses a receipt may move a message from (receipts arrive out of order; never go back). */
const ADVANCE_FROM: Record<'sent' | 'delivered' | 'read' | 'failed', MessageStatus[]> = {
  sent: ['queued', 'processing'],
  delivered: ['queued', 'processing', 'sent'],
  read: ['queued', 'processing', 'sent', 'delivered'],
  failed: ['queued', 'processing', 'sent'],
};

/**
 * Provider status callbacks (sent/delivered/read/failed) by provider message id. Only moves a
 * status forward, so a late "delivered" never overwrites "read". Returns the updated rows.
 */
export async function setStatusByExternalId(
  channel: Channel,
  externalId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
): Promise<MessageRow[]> {
  const rows = await db()
    .update(messages)
    .set({ status })
    .where(
      and(
        eq(messages.channel, channel),
        eq(messages.externalId, externalId),
        eq(messages.direction, 'out'),
        inArray(messages.status, ADVANCE_FROM[status]),
      ),
    )
    .returning();
  for (const row of rows) await publish(row.userId, 'message.status', toApiMessage(row));
  return rows;
}

/** The inbound message already saved for an event, if any. */
export async function getInboundByEvent(eventId: string): Promise<MessageRow | undefined> {
  const [row] = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.eventId, eventId), eq(messages.direction, 'in')));
  return row;
}

/**
 * The last messages of one chat, oldest first, whichever conversations they are in. `after`: only
 * messages saved after that time. A copy of a message kept elsewhere (an automation's answer sent
 * to Telegram) is left out: it is not part of this chat's context.
 */
export async function recentSessionMessages(
  userId: string,
  sessionKey: string,
  limit: number,
  after?: Date | null,
): Promise<MessageRow[]> {
  const rows = await db()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.sessionKey, sessionKey),
        isNull(messages.copyOf),
        ...(after ? [gt(messages.createdAt, after)] : []),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(limit);
  return rows.reverse();
}

/**
 * The last messages of one conversation, oldest first (the context for routing, and the recap a
 * new engine gets). `after`: only messages saved after that time. A copy of a message kept
 * elsewhere (an automation's answer sent to Telegram) is left out: the agent never had it in this
 * conversation, and the user follows it up in the Automations chat.
 */
export async function recentConversationMessages(
  userId: string,
  conversationId: string,
  limit: number,
  after?: Date | null,
): Promise<MessageRow[]> {
  const rows = await db()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.conversationId, conversationId),
        isNull(messages.copyOf),
        ...(after ? [gt(messages.createdAt, after)] : []),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(limit);
  return rows.reverse();
}

/**
 * A turn's reply: the last message saved with the turn's id (its delivery id) that is not an
 * approval's question, nor a draft the agent proposed. The agent's answer when the turn ended well
 * (the Bridge sends it once, at the end), else what the platform said instead (out of credits, the
 * turn failed).
 */
export async function turnReply(userId: string, turnId: string): Promise<MessageRow | undefined> {
  const [row] = await db()
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.eventId, turnId),
        eq(messages.direction, 'out'),
        isNull(messages.approvalId),
        isNull(messages.automationDraftId),
        isNull(messages.copyOf),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(1);
  return row;
}

/** The conversation the approval's question was asked in, while that message exists. */
export async function conversationOfApproval(
  userId: string,
  approvalId: string,
): Promise<string | undefined> {
  const [row] = await db()
    .select({ conversationId: messages.conversationId })
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.approvalId, approvalId)))
    .orderBy(desc(messages.id))
    .limit(1);
  return row?.conversationId;
}

/**
 * What the user themself wrote lately, newest first: the text of their own inbound messages on
 * any chat. Nothing the agent sent, and nothing from automations or app events (those are not
 * saved as inbound messages).
 */
export async function recentInboundTexts(
  userId: string,
  since: Date,
  limit: number,
): Promise<string[]> {
  const rows = await db()
    .select({ text: messages.text })
    .from(messages)
    .where(
      and(
        eq(messages.userId, userId),
        eq(messages.direction, 'in'),
        gte(messages.createdAt, since),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(limit);
  return rows.map((r) => r.text).filter(Boolean);
}

/** The user's messages, newest first: all of them, or one channel's, or one conversation's. */
export async function listMessages(
  userId: string,
  opts: { cursor?: string; limit: number; channel?: Channel; conversationId?: string },
) {
  const where = [eq(messages.userId, userId)];
  if (opts.cursor) where.push(lt(messages.id, opts.cursor));
  if (opts.channel) where.push(eq(messages.channel, opts.channel));
  if (opts.conversationId) where.push(eq(messages.conversationId, opts.conversationId));
  const rows = await db()
    .select()
    .from(messages)
    .where(and(...where))
    .orderBy(desc(messages.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  return { items: page, nextCursor: rows.length > opts.limit ? page[page.length - 1]!.id : null };
}

/** The session the user last wrote from (default target for agent replies). */
export async function lastInboundSession(userId: string): Promise<string | null> {
  const [row] = await db()
    .select({ sessionKey: messages.sessionKey })
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.direction, 'in')))
    .orderBy(desc(messages.id))
    .limit(1);
  return row?.sessionKey ?? null;
}

/** Account deletion: remove the user's messages and files, then their conversations. */
export async function deleteUserChannelData(userId: string): Promise<void> {
  const { attachments } = await import('./schema.ts');
  const { rm } = await import('node:fs/promises');
  const files = await db().select().from(attachments).where(eq(attachments.userId, userId));
  for (const f of files) await rm(f.path, { force: true });
  await db().delete(attachments).where(eq(attachments.userId, userId));
  await db().delete(messages).where(eq(messages.userId, userId));
  await deleteUserConversations(userId);
}

/**
 * Chat history retention: messages older than a year go, and with them the conversations that
 * are not active and have nothing left (never the Automations chat). Returns the number of
 * messages removed.
 */
export async function cleanupMessages(olderThanDays = 365): Promise<number> {
  const before = new Date(Date.now() - olderThanDays * 86400_000);
  const rows = await db()
    .delete(messages)
    .where(lt(messages.createdAt, before))
    .returning({ id: messages.id });
  await cleanupEmptyConversations(before);
  return rows.length;
}

// --- admin reads: when, never what ------------------------------------------------------------

/** Admin: when each user last sent a message, on any channel. Users with none are left out. */
export async function lastInboundAtFor(userIds: string[]): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (!userIds.length) return out;
  const rows = await db()
    .select({
      userId: messages.userId,
      at: sql<Date | string>`max(${messages.createdAt})`,
    })
    .from(messages)
    .where(and(inArray(messages.userId, userIds), eq(messages.direction, 'in')))
    .groupBy(messages.userId);
  for (const r of rows) out.set(r.userId, new Date(r.at));
  return out;
}

/** Admin overview: how many users sent at least one message since `since`, on any channel. */
export async function activeUserCount(since: Date): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(distinct ${messages.userId})`.mapWith(Number) })
    .from(messages)
    .where(and(eq(messages.direction, 'in'), gte(messages.createdAt, since)));
  return row?.n ?? 0;
}
