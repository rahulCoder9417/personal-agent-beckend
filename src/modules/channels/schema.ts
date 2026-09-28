import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export type MediaRef = {
  id: string;
  name: string;
  mimeType: string;
  providerId?: string;
  path?: string;
};

export const messages = pgTable(
  'messages',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    channel: text({ enum: ['whatsapp', 'telegram', 'imessage', 'web'] }).notNull(),
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
