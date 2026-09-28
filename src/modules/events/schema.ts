import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** The permanent record of everything that came in (HLD 0.2). */
export const events = pgTable(
  'events',
  {
    id: text().primaryKey(),
    source: text().notNull(),
    externalId: text().notNull(),
    type: text().notNull(),
    userId: text(),
    payload: jsonb().notNull().$type<Record<string, unknown>>(),
    /** received → queued → done | failed | ignored */
    status: text({ enum: ['received', 'queued', 'done', 'failed', 'ignored'] })
      .notNull()
      .default('received'),
    queue: text(),
    jobName: text(),
    error: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex().on(t.source, t.externalId), index().on(t.status, t.createdAt)],
);
