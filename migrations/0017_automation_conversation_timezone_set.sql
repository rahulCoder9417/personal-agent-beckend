-- An automation remembers the conversation its runs reply in, and a user row says whether its
-- time zone was ever set (docs/backend-report.md, "Reminders and automations").
ALTER TABLE "users" ADD COLUMN "timezone_set" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A time zone other than the default was set by someone: keep it, the web app must not replace it.
UPDATE "users" SET "timezone_set" = true WHERE "timezone" <> 'UTC';--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "conversation_id" text;
