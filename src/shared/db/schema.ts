// Every module's tables, for Drizzle (queries + drizzle-kit). Each module owns its own tables;
// other modules must go through that module's exported functions (CLAUDE.md).
export * from '../../modules/admin/schema.ts';
export * from '../../modules/auth/schema.ts';
export * from '../../modules/channels/schema.ts';
export * from '../../modules/events/schema.ts';
export * from '../../modules/orchestrator/schema.ts';
