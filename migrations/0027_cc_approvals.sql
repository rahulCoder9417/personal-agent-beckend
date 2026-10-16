-- Approvals for the agent's own actions (Claude Code's commands, git pushes). git_created_branches
-- remembers the branches the agent made through the git gateway: a later push that only adds
-- commits to one of them needs no approval. crew_jobs.blocked lists what a crew job's run was
-- refused because its brief does not cover it; crew_jobs.approved and rerun_of mark a job run again
-- after the user approved those. Nothing already in the database changes meaning.
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