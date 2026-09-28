CREATE TABLE "automations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"instruction" text NOT NULL,
	"run_at" timestamp with time zone,
	"cron" text,
	"timezone" text,
	"trigger" jsonb,
	"trigger_ref" text,
	"session_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"paused_reason" text,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "automations_user_id_index" ON "automations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "automations_trigger_ref_index" ON "automations" USING btree ("trigger_ref");