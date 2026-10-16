CREATE TABLE "git_created_branches" (
	"user_id" text NOT NULL,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"branch" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crew_jobs" ADD COLUMN "blocked" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crew_jobs" ADD COLUMN "approved" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crew_jobs" ADD COLUMN "rerun_of" text;--> statement-breakpoint
CREATE UNIQUE INDEX "git_created_branches_user_id_owner_repo_branch_index" ON "git_created_branches" USING btree ("user_id","owner","repo","branch");