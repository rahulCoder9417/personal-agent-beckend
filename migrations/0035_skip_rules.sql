CREATE TABLE "skip_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"app" text NOT NULL,
	"action" text NOT NULL,
	"scope" text NOT NULL,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_via" text NOT NULL,
	"approval_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "auto_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "skip_rules_user_id_action_scope_index" ON "skip_rules" USING btree ("user_id","action","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_user_id_auto_key_index" ON "approvals" USING btree ("user_id","auto_key");