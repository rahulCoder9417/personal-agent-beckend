CREATE TABLE "waitlist_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"entry_id" text,
	"email_normalized" text,
	"ip" text NOT NULL,
	"user_agent" text,
	"outcome" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_normalized" text NOT NULL,
	"name" text,
	"referral_source" text,
	"use_case" text,
	"utm" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"flag_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ip" text NOT NULL,
	"forwarded_for" text,
	"user_agent" text,
	"accept_language" text,
	"referer" text,
	"origin" text,
	"submit_count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_entries_emailNormalized_unique" UNIQUE("email_normalized")
);
--> statement-breakpoint
CREATE INDEX "waitlist_attempts_ip_created_at_index" ON "waitlist_attempts" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "waitlist_attempts_created_at_index" ON "waitlist_attempts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "waitlist_entries_ip_created_at_index" ON "waitlist_entries" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "waitlist_entries_status_index" ON "waitlist_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "waitlist_entries_flagged_index" ON "waitlist_entries" USING btree ("flagged");