CREATE TABLE "pr_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"automation_id" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer NOT NULL,
	"head_sha" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "preset" text;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_reviews_user_id_owner_repo_pr_number_head_sha_index" ON "pr_reviews" USING btree ("user_id","owner","repo","pr_number","head_sha");