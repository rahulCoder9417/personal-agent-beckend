ALTER TABLE "automation_drafts" ADD COLUMN "ask_first" text DEFAULT 'risky' NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "ask_first" text DEFAULT 'risky' NOT NULL;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "client_request_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "automations_user_id_client_request_id_index" ON "automations" USING btree ("user_id","client_request_id");