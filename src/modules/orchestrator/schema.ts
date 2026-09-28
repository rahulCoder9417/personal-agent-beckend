import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Maps a container's Platform MCP token (sha256 hex, from CreateSandbox) to its user.
 * The `sandboxes` table itself belongs to the vm-manager; we never read it directly.
 */
export const sandboxTokens = pgTable('sandbox_tokens', {
  userId: text().primaryKey(),
  mcpTokenHash: text().notNull().unique(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
