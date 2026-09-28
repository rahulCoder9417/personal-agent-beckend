import { boolean, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** A user's Composio connected account for one app. */
export const connections = pgTable(
  'connections',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    app: text().notNull(),
    composioAccountId: text().notNull(),
    status: text({ enum: ['pending', 'active', 'expired', 'error'] })
      .notNull()
      .default('pending'),
    accountLabel: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.composioAccountId), index().on(t.userId)],
);

/** The user's own MCP servers (Max plan). Their domains go on the egress allowlist. */
export const userMcpServers = pgTable(
  'user_mcp_servers',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    name: text().notNull(),
    url: text().notNull(),
    domain: text().notNull(),
    authHeaderName: text(),
    /** Encrypted (AES-GCM). */
    authSecret: text(),
    enabled: boolean().notNull().default(true),
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);

/** Composio trigger instances we created (app-event automations). */
export const composioTriggers = pgTable(
  'composio_triggers',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    composioTriggerId: text().notNull().unique(),
    triggerSlug: text().notNull(),
    config: jsonb().$type<Record<string, unknown>>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId)],
);
