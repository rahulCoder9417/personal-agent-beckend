import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const auditLog = pgTable(
  'audit_log',
  {
    id: text().primaryKey(),
    userId: text(),
    actor: text({ enum: ['user', 'agent', 'admin', 'system'] }).notNull(),
    action: text().notNull(),
    summary: text().notNull().default(''),
    details: jsonb().$type<Record<string, unknown>>(),
    creditsCharged: integer(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.userId, t.id)],
);
