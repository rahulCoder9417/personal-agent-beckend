-- The web app's first-run marks on a user row: when the welcome steps were finished or skipped,
-- and when the "Getting started" checklist was closed (docs/backend-report.md, "Sign-up and the
-- first container"). No backfill on purpose: every existing row stays null, so the accounts made
-- before this change see the welcome steps on their next visit, exactly like a new account.
ALTER TABLE "users" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "getting_started_dismissed_at" timestamp with time zone;
