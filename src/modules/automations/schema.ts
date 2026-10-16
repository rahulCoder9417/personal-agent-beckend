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

/**
 * When a step runs ("only if"), checked on the result of the step before it (docs/backend-report.md,
 * "Automations with steps"). A false one stops the run there.
 */
export type StepCondition =
  | { kind: 'always' }
  | { kind: 'found' }
  | { kind: 'mentions'; words: string[] }
  | { kind: 'tex'; question: string };

/**
 * One step of an automation: an app action (one named action, with the inputs the user fixed) or
 * a Tex instruction (words; it may read the apps it names, never change them).
 */
export interface AutomationStep {
  /** Short, unique in the automation: it names the step's results, so reordering mixes nothing up. */
  id: string;
  type: 'action' | 'tex';
  title: string;
  /** `action`: the app slug. */
  app: string | null;
  /** `action`: the Composio action slug. */
  action: string | null;
  /** `action`: the inputs the user fixed; Tex fills the rest. */
  inputs: Record<string, unknown>;
  /** `tex`: what Tex does in this step. */
  instruction: string | null;
  /** `tex`: the apps Tex may read in this step (app slugs). */
  readApps: string[];
  /** `action`: wait for the user's yes before it runs (always, for a risky action). */
  askFirst: boolean;
  onlyIf: StepCondition;
  /** "Show me this": its result also goes into the run's answer. */
  showResult: boolean;
}

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
     * through the REST api; no agent tool does.
     */
    preset: text({ enum: ['pr_review'] }),
    /**
     * The apps its runs may use (app slugs): named by the agent in the draft it was saved from, or
     * by the user on the canvas. A limit: a run may use only these and the trigger's app
     * (platform-mcp run_app_action). Empty: none named (older automations), any connected app.
     */
    apps: jsonb().$type<string[]>().notNull().default([]),
    /**
     * When a run stops for the user's yes. `risky`: before sending, deleting or paying (the
     * platform's rule). `changes`: stricter, before any app action that changes something.
     */
    askFirst: text({ enum: ['risky', 'changes'] })
      .notNull()
      .default('risky'),
    /**
     * Up to 6 steps a run follows one at a time (steps.ts). Empty, as for every automation made
     * before steps: one instruction. With steps, `instruction` is the purpose in one line and
     * `apps` every app the steps name.
     */
    steps: jsonb().$type<AutomationStep[]>().notNull().default([]),
    /** The REST api's idempotency key for one made by hand (POST /v1/automations). */
    clientRequestId: text(),
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
    /**
     * Why it is paused. `admin`: by Textcrew support for this automation (admin tools); adding credits
     * does not resume it, the user or an admin can. `suspended`: an admin suspended the account; it
     * comes back when the account is unsuspended.
     */
    pausedReason: text({ enum: ['out_of_credits', 'failures', 'user', 'admin', 'suspended'] }),
    failCount: integer().notNull().default(0),
    nextRunAt: timestamp({ withTimezone: true }),
    lastRunAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.userId),
    index().on(t.triggerRef),
    uniqueIndex().on(t.userId, t.clientRequestId),
  ],
);

/** The parts of an automation, as a draft keeps them until it is saved. */
export type DraftTrigger = { app: string; event: string; config?: Record<string, unknown> };

/**
 * A draft: an automation the agent proposed (propose_automation) that the user has not saved
 * (docs/backend-report.md, "Drafts"). It never runs: no timer, no watch at Composio. Only the
 * user's Save makes the automation (drafts.ts, saveDraft). Open for 7 days, at most 20 open per
 * user; removed after 30 days.
 */
export const automationDrafts = pgTable(
  'automation_drafts',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    status: text({ enum: ['open', 'saved', 'discarded', 'replaced', 'expired'] })
      .notNull()
      .default('open'),
    /** `agent`: proposed by the agent. `user`: the user's own version from the canvas, for the agent to change. */
    madeBy: text({ enum: ['agent', 'user'] })
      .notNull()
      .default('agent'),
    /** The automation it would change: saving makes the new one, then removes that one. */
    changeOf: text(),
    kind: text({ enum: ['once', 'repeat', 'event'] }).notNull(),
    title: text().notNull(),
    instruction: text().notNull(),
    runAt: timestamp({ withTimezone: true }),
    cron: text(),
    /** The time zone it runs in: the one the agent named, else the user's own then. */
    timezone: text().notNull(),
    trigger: jsonb().$type<DraftTrigger>(),
    /** The apps its runs may use, as app slugs. */
    apps: jsonb().$type<string[]>().notNull().default([]),
    /** See `automations.askFirst`. */
    askFirst: text({ enum: ['risky', 'changes'] })
      .notNull()
      .default('risky'),
    /** See `automations.steps`. */
    steps: jsonb().$type<AutomationStep[]>().notNull().default([]),
    /** The chat it was proposed in: its card was posted there, and a copy of each answer goes there. */
    sessionKey: text().notNull(),
    /** `replaced`: the newer draft. */
    replacedBy: text(),
    /** `saved`: the automation it made. */
    automationId: text(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** When it was saved, discarded, replaced or expired. */
    decidedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.status), index().on(t.status, t.expiresAt)],
);

/** One step of a run: how far it got, its short result, and why it stopped. */
export interface RunStep {
  stepId: string;
  state: 'pending' | 'running' | 'done' | 'skipped' | 'failed' | 'waiting';
  /** Its short result (at most 4,000 characters). Removed 2 days after the run ended. */
  result: string | null;
  /** Tex said it found nothing (finish_step `found: false`). */
  found?: boolean;
  /** Why it failed or was skipped, or Tex's line for a "Tex decides" condition. */
  reason: string | null;
  /** `tex` condition: Tex's answer, once given. */
  conditionMet?: boolean;
  /** How many times its own action was tried (a second failure fails the step). */
  tries: number;
  /** App calls made during this step. */
  calls: number;
  /** `waiting`: the approval it waits for. */
  approvalId: string | null;
  /** When it started waiting for the user's OK. */
  waitingSince?: string;
}

/**
 * One run of an automation with steps (docs/backend-report.md, "Automations with steps"): which
 * step it is on, and each step's result. One per event (unique), so a job that runs again never
 * starts it twice; it carries on from the first step not done. The steps are copied in at the
 * start, so a change while it waits never mixes old and new.
 */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    automationId: text().notNull(),
    /** The event that started it (a timer's, an app event's, or "Run once now"). */
    eventId: text().notNull().unique(),
    state: text({ enum: ['running', 'waiting', 'done', 'stopped', 'failed', 'superseded'] })
      .notNull()
      .default('running'),
    /** "Run once now". */
    test: boolean().notNull().default(false),
    /** The step it is on; null once it ended. */
    currentStepId: text(),
    /** The automation's steps when the run started. */
    plan: jsonb().$type<AutomationStep[]>().notNull(),
    steps: jsonb().$type<RunStep[]>().notNull(),
    /** App calls in the whole run (at most 30). */
    appCalls: integer().notNull().default(0),
    /** Why it stopped or failed, in words for the user. */
    stopReason: text(),
    /** The turn now running it (its delivery id): the first one's, then the one after a yes. */
    turnId: text(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp({ withTimezone: true }),
    /** When the steps' results were removed (2 days after the end). */
    resultsRemovedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId, t.automationId, t.startedAt), index().on(t.state)],
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
/**
 * One thing a crew job's run was refused, as the user is shown it. `command`: a command or a file
 * change (`tool` is Claude Code's tool, `target` the command or the file). `git_push`: a push to a
 * branch that already existed, `force` when it rewrites the branch's history.
 */
export type CrewJobItem =
  | { kind: 'command'; tool: string; target: string; why: string }
  | { kind: 'git_push'; owner: string; repo: string; branch: string; force: boolean };

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
    /**
     * What the job's run was refused because the brief does not cover it (a command that needs the
     * user's OK, a push to a branch that already existed): listed for the user after the run, with
     * an Approve button that runs the job again with exactly these allowed.
     */
    blocked: jsonb().$type<CrewJobItem[]>().notNull().default([]),
    /** A run again of an earlier job: the items the user approved for it, each usable once. */
    approved: jsonb().$type<CrewJobItem[]>().notNull().default([]),
    /** The job this one runs again (after the user approved what the earlier run was refused). */
    rerunOf: text(),
    /**
     * The automation whose run started this job (or the earlier job, for a run again). Null: the
     * user asked for it, in the web app or a chat. Its approvals follow the automation's rule for
     * Telegram copies.
     */
    automationId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.userId, t.status), uniqueIndex().on(t.userId, t.clientRequestId)],
);
