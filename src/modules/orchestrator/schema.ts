import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

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

/** Claude Code's thinking effort levels (its `--effort` flag), lowest first. */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

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
  /** The Claude model Claude Code uses (an id from CLAUDE_MODELS); null = Claude Code's default. */
  claudeModel: text(),
  /** Claude Code's thinking effort; null = Claude Code's default. */
  claudeEffort: text({ enum: CLAUDE_EFFORTS }),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const MEMORY_KINDS = ['preference', 'person', 'project', 'instruction', 'fact'] as const;

/**
 * Shared memory (HLD 0.9): short facts about the user that every engine gets. One line of text
 * each. This is the only place a memory's text is kept: the audit log holds ids, never the text.
 */
export const memories = pgTable(
  'memories',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    kind: text({ enum: MEMORY_KINDS }).notNull().default('fact'),
    content: text().notNull(),
    /** Last saved, saved again or corrected by the agent. */
    confirmedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Last returned by a `recall` search; with `useCount`, what "most used" means. */
    lastUsedAt: timestamp({ withTimezone: true }),
    useCount: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** When the text last changed. */
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.id)],
);

/**
 * Which engine last finished a turn in each chat (HLD 0.9). An engine keeps one session per chat,
 * so a turn on another engine than the chat's previous one gets a recap of the chat.
 */
export const chatEngines = pgTable(
  'chat_engines',
  {
    userId: text().notNull(),
    sessionKey: text().notNull(),
    runtime: text({ enum: ['hermes', 'claude_code'] }).notNull(),
    lastTurnAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionKey, t.runtime] })],
);

/**
 * The chat epoch: a number per chat (session key), 0 until the user first starts a new chat.
 * Starting one adds 1 and records when. Every delivery carries the number, so the engine starts a
 * fresh conversation for that chat; the recap leaves out what was said before `startedAt`.
 * No row means epoch 0, never started.
 */
export const chatEpochs = pgTable(
  'chat_epochs',
  {
    userId: text().notNull(),
    sessionKey: text().notNull(),
    epoch: integer().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    /** What started the latest one (a Telegram event id): the same event never starts two. */
    startKey: text(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionKey] })],
);
