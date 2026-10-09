import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export type MediaRef = {
  id: string;
  name: string;
  mimeType: string;
  providerId?: string;
  path?: string;
};

const CHANNELS = ['whatsapp', 'telegram', 'imessage', 'web'] as const;

/**
 * A chat is one channel thread, named by its session key (`web`, `telegram:<chat id>`). This is
 * the chat's counter: `epoch` is the highest conversation number given out in it so far, and it
 * only goes up, so a number is never used again (not even after its conversation is deleted: the
 * engine may still hold that number's context). A chat with no row has had no conversation yet.
 */
export const chatEpochs = pgTable(
  'chat_epochs',
  {
    userId: text().notNull(),
    sessionKey: text().notNull(),
    epoch: integer().notNull(),
    /** When the conversation with that number started. */
    startedAt: timestamp({ withTimezone: true }).notNull(),
    /** What started it (a Telegram event id): the same event never starts two. */
    startKey: text(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionKey] })],
);

/**
 * A conversation: one stretch of a chat between two "New chat" actions. Every message belongs to
 * one. `epoch` is its number within the chat; every delivery to the agent carries it, and the
 * engine keeps a context of its own per number.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    sessionKey: text().notNull(),
    channel: text({ enum: CHANNELS }).notNull(),
    epoch: integer().notNull(),
    /** The user's name for it, else the first incoming message's text, cut. Null: "New chat". */
    title: text(),
    /** The one conversation of its chat that the next message goes into. */
    active: boolean().notNull().default(false),
    /** Whole milliseconds, like `lastMessageAt` (the list's cursor is built from it). */
    startedAt: timestamp({ withTimezone: true }).notNull(),
    /** When its newest message was saved; `startedAt` while it has none. */
    lastMessageAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex().on(t.userId, t.sessionKey, t.epoch),
    uniqueIndex('conversations_one_active_per_chat')
      .on(t.userId, t.sessionKey)
      .where(sql`${t.active}`),
    index().on(t.userId, t.lastMessageAt, t.id),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    /** Deleting a conversation deletes its messages. */
    conversationId: text()
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    channel: text({ enum: CHANNELS }).notNull(),
    direction: text({ enum: ['in', 'out'] }).notNull(),
    text: text().notNull().default(''),
    mediaRef: jsonb().$type<MediaRef[]>(),
    status: text({ enum: ['queued', 'processing', 'sent', 'delivered', 'read', 'failed'] })
      .notNull()
      .default('queued'),
    eventId: text(),
    approvalId: text(),
    /** Web idempotency key. */
    clientMessageId: text(),
    /** Provider message id (for status updates). */
    externalId: text(),
    /** Where outbound messages go, e.g. telegram chat id. */
    sessionKey: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.userId, t.id),
    index().on(t.conversationId, t.id),
    uniqueIndex().on(t.userId, t.clientMessageId),
    index().on(t.channel, t.externalId),
  ],
);

/** Files uploaded from the web app (and downloaded channel media). */
export const attachments = pgTable(
  'attachments',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    name: text().notNull(),
    mimeType: text().notNull(),
    sizeBytes: integer().notNull(),
    path: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);
