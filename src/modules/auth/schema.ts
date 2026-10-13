import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = () => timestamp({ withTimezone: true });

export const users = pgTable('users', {
  id: text().primaryKey(),
  clerkId: text().notNull().unique(),
  email: text().notNull().default(''),
  emailVerified: boolean().notNull().default(false),
  name: text().notNull().default(''),
  timezone: text().notNull().default('UTC'),
  /**
   * Someone set the time zone (the user, or the web app once from the browser). While false the
   * account still has the default above, and the web app may set it from the browser.
   */
  timezoneSet: boolean().notNull().default(false),
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

/** People waiting for access (before they have an account). Keeps request data for abuse monitoring. */
export const waitlistEntries = pgTable(
  'waitlist_entries',
  {
    id: text().primaryKey(),
    email: text().notNull(),
    /** Lowercased; Gmail dots and +tags removed, so aliases of one inbox collapse into one entry. */
    emailNormalized: text().notNull().unique(),
    name: text(),
    referralSource: text(),
    useCase: text(),
    utm: jsonb().$type<Record<string, string>>(),
    status: text({ enum: ['pending', 'invited', 'rejected'] })
      .notNull()
      .default('pending'),
    flagged: boolean().notNull().default(false),
    flagReasons: jsonb().$type<string[]>().notNull().default([]),
    // Request data at first sign-up (every later attempt is in waitlist_attempts).
    ip: text().notNull(),
    forwardedFor: text(),
    userAgent: text(),
    acceptLanguage: text(),
    referer: text(),
    origin: text(),
    submitCount: integer().notNull().default(1),
    createdAt: ts().notNull().defaultNow(),
    lastSeenAt: ts().notNull().defaultNow(),
    /** When the waitlist offer (50% off the first paid month) was used. Once per entry. */
    offerUsedAt: ts(),
  },
  (t) => [index().on(t.ip, t.createdAt), index().on(t.status), index().on(t.flagged)],
);

/** Every waitlist submission, including duplicates, honeypot hits and rate-limited ones. */
export const waitlistAttempts = pgTable(
  'waitlist_attempts',
  {
    id: text().primaryKey(),
    entryId: text(),
    emailNormalized: text(),
    ip: text().notNull(),
    userAgent: text(),
    outcome: text({ enum: ['created', 'duplicate', 'honeypot', 'rate_limited'] }).notNull(),
    createdAt: ts().notNull().defaultNow(),
  },
  (t) => [index().on(t.ip, t.createdAt), index().on(t.createdAt)],
);
