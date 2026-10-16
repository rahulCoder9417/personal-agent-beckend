-- Automation drafts (phase 2 of automations on a canvas): an automation the agent proposed and the
-- user has not saved. It never runs. `automations.apps` keeps the apps the agent named in the draft
-- an automation was saved from (empty for every automation already there), and
-- `messages.automation_draft_id` marks the chat message that carries a draft, for its card.
-- Nothing already in the database changes meaning.
CREATE TABLE "automation_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"made_by" text DEFAULT 'agent' NOT NULL,
	"change_of" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"run_at" timestamp with time zone,
	"cron" text,
	"timezone" text NOT NULL,
	"trigger" jsonb,
	"apps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"session_key" text NOT NULL,
	"replaced_by" text,
	"automation_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "automation_draft_id" text;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "apps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_drafts_user_id_status_index" ON "automation_drafts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "automation_drafts_status_expires_at_index" ON "automation_drafts" USING btree ("status","expires_at");