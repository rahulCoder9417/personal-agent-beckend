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

/** Source of truth for automations; BullMQ only holds the timers (HLD 0.4). */
export const automations = pgTable(
  'automations',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    kind: text({ enum: ['once', 'repeat', 'event'] }).notNull(),
    title: text().notNull(),
    instruction: text().notNull(),
    runAt: timestamp({ withTimezone: true }),
    cron: text(),
    timezone: text(),
    /** kind=event: the app + trigger, and Composio's trigger instance id. */
    trigger: jsonb().$type<{ app: string; event: string; config?: Record<string, unknown> }>(),
    triggerRef: text(),
    /**
     * `pr_review`: pull-request review for one GitHub repo (HLD 0.8). Only the user can set it,
     * through the REST api; the agent's create_automation tool never does.
     */
    preset: text({ enum: ['pr_review'] }),
    /** Where results are sent. */
    sessionKey: text().notNull(),
    /**
     * The conversation a run replies in (web chat): the one the agent made it in, or, when there
     * was none or it was deleted, the automation's own conversation, started by its first run.
     * Null until one is known. No foreign key: the conversation is the channels module's.
     */
    conversationId: text(),
    enabled: boolean().notNull().default(true),
    pausedReason: text({ enum: ['out_of_credits', 'failures', 'user'] }),
    failCount: integer().notNull().default(0),
    nextRunAt: timestamp({ withTimezone: true }),
    lastRunAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId), index().on(t.triggerRef)],
);

/**
 * One row per reviewed pull-request head commit (HLD 0.8). The unique index is what makes "one
 * review per head commit" true: a re-delivered or repeated event finds the row and does nothing.
 */
export const prReviews = pgTable(
  'pr_reviews',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    automationId: text().notNull(),
    /** Lower-cased: GitHub names don't depend on case. */
    owner: text().notNull(),
    repo: text().notNull(),
    prNumber: integer().notNull(),
    headSha: text().notNull(),
    /** The event that asked for this review. A re-run of that same job goes on with it. */
    eventId: text().notNull(),
    status: text({ enum: ['requested', 'done', 'failed'] })
      .notNull()
      .default('requested'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.userId, t.owner, t.repo, t.prNumber, t.headSha)],
);
