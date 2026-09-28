import { boolean, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const ts = () => timestamp({ withTimezone: true });

export const users = pgTable('users', {
  id: text().primaryKey(),
  clerkId: text().notNull().unique(),
  email: text().notNull().default(''),
  emailVerified: boolean().notNull().default(false),
  name: text().notNull().default(''),
  timezone: text().notNull().default('UTC'),
  plan: text({ enum: ['free', 'pro', 'max'] })
    .notNull()
    .default('free'),
  role: text({ enum: ['user', 'admin'] })
    .notNull()
    .default('user'),
  /** Set on a chargeback (HLD 7.6). */
  flagged: boolean().notNull().default(false),
  createdAt: ts().notNull().defaultNow(),
  deletedAt: ts(),
});

export const linkCodes = pgTable(
  'link_codes',
  {
    id: text().primaryKey(),
    codeHash: text().notNull().unique(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text({ enum: ['whatsapp', 'telegram', 'imessage', 'web'] }).notNull(),
    expiresAt: ts().notNull(),
    usedAt: ts(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);

export const channelLinks = pgTable(
  'channel_links',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: text({ enum: ['whatsapp', 'telegram', 'imessage'] }).notNull(),
    /** Chat id / phone number on the channel. */
    externalId: text().notNull(),
    displayId: text().notNull().default(''),
    /** For the WhatsApp 24-hour rule. */
    lastInboundAt: ts(),
    /** The user blocked us; use the web app instead. */
    blocked: boolean().notNull().default(false),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.channel, t.externalId), index().on(t.userId)],
);
