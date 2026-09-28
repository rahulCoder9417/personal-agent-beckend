import { boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

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
    /** Where results are sent. */
    sessionKey: text().notNull(),
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
