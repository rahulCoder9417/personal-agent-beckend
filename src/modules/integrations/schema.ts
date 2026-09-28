import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

const ts = () => timestamp({ withTimezone: true });

/** The user's own AI provider keys (HLD 7.1 "bring your own key"). Encrypted at rest. */
export const byokKeys = pgTable(
  'byok_keys',
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    provider: text({ enum: ['anthropic', 'openai', 'openrouter'] }).notNull(),
    keyEncrypted: text().notNull(),
    last4: text().notNull(),
    model: text(),
    createdAt: ts().notNull().defaultNow(),
    updatedAt: ts().notNull().defaultNow(),
  },
  (t) => [uniqueIndex().on(t.userId, t.provider)],
);
