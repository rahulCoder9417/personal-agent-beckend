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
     * No longer used: every run now answers in the user's Automations chat (the channels
     * module's). Until 13 October it held the conversation a run replied in. Kept, unread and
     * unwritten, so a server still running the older code during a deploy keeps working; a later
     * migration can drop it.
     */
    conversationId: text(),
    enabled: boolean().notNull().default(true),
    /** `admin`: paused while an admin suspended the account; back when it is unsuspended. */
    pausedReason: text({ enum: ['out_of_credits', 'failures', 'user', 'admin'] }),
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

/**
 * A crew job: a brief the user gave Patch (a review) or Byte (a change), run as one turn of the
 * agent (docs/backend-report.md, "The crew"). The row is the job's state and its claim: a job
 * moves queued → running → done | failed once, so a re-run of its queue job never starts it twice.
 */
export const crewJobs = pgTable(
  'crew_jobs',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    member: text({ enum: ['patch', 'byte'] }).notNull(),
    status: text({ enum: ['queued', 'running', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    /** `app`: given in the web app. `chat`: the lead started it with the start_crew_job tool. */
    source: text({ enum: ['app', 'chat'] }).notNull(),
    owner: text().notNull(),
    repo: text().notNull(),
    pullNumber: integer(),
    branch: text(),
    /** The user's own words (Byte: what to fix or build). */
    instructions: text().notNull().default(''),
    /** Patch only. */
    focus: jsonb().$type<string[]>().notNull().default([]),
    /** Byte only: what to test for. */
    acceptance: text().notNull().default(''),
    commands: text().notNull().default(''),
    /** Byte only: open a pull request, or only push the branch. */
    finish: text({ enum: ['pull_request', 'branch'] }),
    /** The chat the report goes to (`web`, or `telegram:<chat id>`). */
    sessionKey: text().notNull(),
    reportPullRequest: boolean().notNull().default(false),
    reportIssue: boolean().notNull().default(false),
    /**
     * The conversation the report goes to (web chat): the one a chat-started job was asked in,
     * or the job's own, started by its run. No foreign key: the conversation is the channels
     * module's.
     */
    conversationId: text(),
    /** The REST api's idempotency key. Null for a job the lead started from chat. */
    clientRequestId: text(),
    /** The inbound event that runs it: also the turn's delivery id. */
    eventId: text(),
    /** The final report: the agent's final answer of the job's turn. */
    report: text(),
    error: text(),
    /**
     * When the one review the brief allowed (`reportPullRequest`) was posted on the pull request.
     * Set in the same step as the permission check, so it covers one review only.
     */
    postedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId, t.status), uniqueIndex().on(t.userId, t.clientRequestId)],
);
