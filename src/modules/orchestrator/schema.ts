import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Maps a container's Platform MCP token (sha256 hex, from CreateSandbox) to its user.
 * The `sandboxes` table itself belongs to the vm-manager; we never read it directly.
 */
export const sandboxTokens = pgTable('sandbox_tokens', {
  userId: text().primaryKey(),
  mcpTokenHash: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/** Risky actions wait for the user's ✅ / ❌ (HLD 0.5: approvals never block a turn). */
export const approvals = pgTable(
  'approvals',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    summary: text().notNull(),
    app: text(),
    action: text(),
    /** The exact arguments that were approved (run_app_action must match them). */
    arguments: jsonb().$type<Record<string, unknown>>(),
    details: jsonb().$type<Record<string, unknown>>(),
    status: text({ enum: ['pending', 'approved', 'rejected', 'expired'] })
      .notNull()
      .default('pending'),
    sessionKey: text().notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    decidedAt: timestamp({ withTimezone: true }),
    decidedVia: text(),
    /** Set when run_app_action consumed it (single use). */
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.id), index().on(t.status, t.expiresAt)],
);

/**
 * Which agent runs for the user: Hermes (API key / platform credits) or Claude Code (the user's
 * own Claude plan). We only store WHEN a Claude plan was connected: never a credential or token.
 */
export const agentSettings = pgTable('agent_settings', {
  userId: text().primaryKey(),
  runtime: text({ enum: ['hermes', 'claude_code'] })
    .notNull()
    .default('hermes'),
  /**
   * `platform`: the user chose Textcrew AI (paid in credits) although they have a key or a Claude
   * plan. `auto`: their own AI when they have one (HLD 7.1).
   */
  aiPreference: text({ enum: ['auto', 'platform'] })
    .notNull()
    .default('auto'),
  /** Set when the in-container Claude Code sign-in succeeded; null = not connected. */
  claudeConnectedAt: timestamp({ withTimezone: true }),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
