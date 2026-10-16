CREATE TABLE "automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"automation_id" text NOT NULL,
	"event_id" text NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"current_step_id" text,
	"plan" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"app_calls" integer DEFAULT 0 NOT NULL,
	"stop_reason" text,
	"turn_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"results_removed_at" timestamp with time zone,
	CONSTRAINT "automation_runs_eventId_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "automation_run_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "automation_step_id" text;--> statement-breakpoint
ALTER TABLE "automation_drafts" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "automation_runs_user_id_automation_id_started_at_index" ON "automation_runs" USING btree ("user_id","automation_id","started_at");--> statement-breakpoint
CREATE INDEX "automation_runs_state_index" ON "automation_runs" USING btree ("state");