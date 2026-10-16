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
    /**
     * When the platform last heard from Composio about this account: a check that got an answer,
     * Composio's webhook, or an admin's recheck. Null if never. Shown to admins only.
     */
    checkedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex().on(t.composioAccountId), index().on(t.userId)],
);

/**
 * Composio setups (auth configs) the server made itself, with Composio's shared sign-in, the first
 * time someone connected an app named in COMPOSIO_MANAGED_APPS. One per app; not per user.
 * A setup named in COMPOSIO_AUTH_CONFIGS wins over the one here.
 */
export const composioAuthConfigs = pgTable('composio_auth_configs', {
  app: text().primaryKey(),
  authConfigId: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

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

/**
 * Branches the agent made on GitHub through the git gateway: the push that created the branch went
 * through it. A later push to such a branch that only adds commits needs no approval; a push to any
 * other branch that already existed, and a force push, need the user's yes (docs/backend-report.md,
 * "The git gateway"). Owner and repo are stored in lower case.
 */
export const gitCreatedBranches = pgTable(
  'git_created_branches',
  {
    userId: text().notNull(),
    owner: text().notNull(),
    repo: text().notNull(),
    branch: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.userId, t.owner, t.repo, t.branch)],
);
