ALTER TABLE "users" ADD COLUMN "notify_automation_approvals" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "automation_id" text;--> statement-breakpoint
ALTER TABLE "crew_jobs" ADD COLUMN "automation_id" text;