import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { db } from '../../shared/db/client.ts';
import { newId } from '../../shared/ids.ts';
import { messages, type MediaRef } from './schema.ts';
import { publish } from './stream.ts';
import type { Channel } from './types.ts';

export type MessageRow = typeof messages.$inferSelect;
export type MessageStatus = MessageRow['status'];

export function toApiMessage(m: MessageRow) {
  return {
    id: m.id,
    channel: m.channel,
    direction: m.direction,
    text: m.text,
    attachments: (m.mediaRef ?? []).map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType })),
    status: m.status,
    approvalId: m.approvalId,
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

/** Saves an inbound chat message once per event (safe to re-run). */
export async function saveInbound(input: {
  userId: string;
  channel: Channel;
  text: string;
  media?: MediaRef[];
  eventId: string;
  sessionKey: string;
  externalId?: string;
}): Promise<MessageRow> {
  const [existing] = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.eventId, input.eventId), eq(messages.direction, 'in')));
  if (existing) return existing;
  const [row] = await db()
    .insert(messages)
    .values({
      id: newId('msg'),
      userId: input.userId,
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
  return row!;
}

/** Web message: idempotent on (user, clientMessageId). */
export async function saveWebMessage(input: {
  userId: string;
  text: string;
  clientMessageId: string;
  media?: MediaRef[];
}): Promise<{ message: MessageRow; created: boolean }> {
  const [row] = await db()
    .insert(messages)
    .values({
      id: newId('msg'),
      userId: input.userId,
      channel: 'web',
      direction: 'in',
      text: input.text,
      mediaRef: input.media?.length ? input.media : null,
      status: 'queued',
      clientMessageId: input.clientMessageId,
      sessionKey: 'web',
    })
    .onConflictDoNothing({ target: [messages.userId, messages.clientMessageId] })
    .returning();
  if (row) {
    await publish(input.userId, 'message.created', toApiMessage(row));
    return { message: row, created: true };
  }
  const [existing] = await db()
    .select()
    .from(messages)
    .where(
      and(eq(messages.userId, input.userId), eq(messages.clientMessageId, input.clientMessageId)),
    );
  return { message: existing!, created: false };
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

/** The last messages of one chat, oldest first (context for routing and quick replies). */
export async function recentSessionMessages(
  userId: string,
  sessionKey: string,
  limit: number,
): Promise<MessageRow[]> {
  const rows = await db()
    .select()
    .from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.sessionKey, sessionKey)))
    .orderBy(desc(messages.id))
    .limit(limit);
  return rows.reverse();
}

export async function listMessages(
  userId: string,
  opts: { cursor?: string; limit: number; channel?: Channel },
) {
  const where = [eq(messages.userId, userId)];
  if (opts.cursor) where.push(lt(messages.id, opts.cursor));
  if (opts.channel) where.push(eq(messages.channel, opts.channel));
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

/** Account deletion: remove the user's messages and files. */
export async function deleteUserChannelData(userId: string): Promise<void> {
  const { attachments } = await import('./schema.ts');
  const { rm } = await import('node:fs/promises');
  const files = await db().select().from(attachments).where(eq(attachments.userId, userId));
  for (const f of files) await rm(f.path, { force: true });
  await db().delete(attachments).where(eq(attachments.userId, userId));
  await db().delete(messages).where(eq(messages.userId, userId));
}

/** Chat history retention. */
export async function cleanupMessages(olderThanDays = 365): Promise<number> {
  const rows = await db()
    .delete(messages)
    .where(lt(messages.createdAt, new Date(Date.now() - olderThanDays * 86400_000)))
    .returning({ id: messages.id });
  return rows.length;
}
