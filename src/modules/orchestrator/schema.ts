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
    /**
     * The exact arguments that were approved. For an app action they were checked against the
     * action's inputs when asked, and run_app_action runs exactly these.
     */
    arguments: jsonb().$type<Record<string, unknown>>(),
    details: jsonb().$type<Record<string, unknown>>(),
    /**
     * `replaced`: the agent asked again for the same action with corrected arguments, naming this
     * one (request_approval's replaces_approval_id). It can no longer be answered or run.
     */
    status: text({ enum: ['pending', 'approved', 'rejected', 'expired', 'replaced'] })
      .notNull()
      .default('pending'),
    sessionKey: text().notNull(),
    /**
     * The automation whose work asked: its run, the turn after an answer to one of its approvals,
     * or a crew job its run started. Null: the user's own chat asked (web or Telegram). Only an
     * automation's approval is copied to Telegram (the user's switch). No foreign key: the
     * automation is the automations module's, and may be deleted meanwhile.
     */
    automationId: text(),
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
 * Which engine last finished a turn in each conversation (HLD 0.9). A conversation is named here
 * by its chat (the session key) and its number in that chat (`epoch`), the two things a delivery
 * carries. An engine keeps one session per conversation, so a turn on another engine than the
 * conversation's previous one gets a recap of the conversation.
 */
export const chatEngines = pgTable(
  'chat_engines',
  {
    userId: text().notNull(),
    sessionKey: text().notNull(),
    epoch: integer().notNull().default(0),
    runtime: text({ enum: ['hermes', 'claude_code'] }).notNull(),
    lastTurnAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionKey, t.epoch, t.runtime] })],
);

/**
 * Where each turn's time went (docs/backend-report.md, "Where a turn's time goes"): one row per
 * turn, written once when the turn ends; a retried job writes it again. Only stage names, times,
 * ids and counts: never the message, the answer or anything else the user or the agent wrote.
 * `stages`: each stage's moment in milliseconds after `startedAt` (the moment the job was queued).
 * `details`: how the route was decided, how the wake went, and the Bridge's own report.
 */
export const turnTimings = pgTable(
  'turn_timings',
  {
    /** The turn's delivery id (the event id for a message). */
    deliveryId: text().primaryKey(),
    userId: text().notNull(),
    kind: text().notNull(),
    channel: text().notNull(),
    /** task, simple, spam, out_of_credits or connect_ai; null when the turn ended before routing. */
    route: text(),
    engine: text({ enum: ['hermes', 'claude_code'] }),
    /** warm, cold, capacity (another container was stopped first) or recreated; null: no wake. */
    wake: text(),
    /** done, error, simple, spam, out_of_credits, retry (the job will try again) or failed. */
    outcome: text().notNull(),
    attempt: integer().notNull().default(1),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    stages: jsonb().$type<Record<string, number>>().notNull(),
    details: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.startedAt), index().on(t.createdAt)],
);
