-- Crew jobs: a brief the user gives Patch or Byte, run as one turn of the agent
-- (docs/backend-report.md, "The crew").
CREATE TABLE "crew_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"member" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"source" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pull_number" integer,
	"branch" text,
	"instructions" text DEFAULT '' NOT NULL,
	"focus" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance" text DEFAULT '' NOT NULL,
	"commands" text DEFAULT '' NOT NULL,
	"finish" text,
	"session_key" text NOT NULL,
	"report_pull_request" boolean DEFAULT false NOT NULL,
	"report_issue" boolean DEFAULT false NOT NULL,
	"conversation_id" text,
	"client_request_id" text,
	"event_id" text,
	"report" text,
	"error" text,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "crew_jobs_user_id_status_index" ON "crew_jobs" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "crew_jobs_user_id_client_request_id_index" ON "crew_jobs" USING btree ("user_id","client_request_id");