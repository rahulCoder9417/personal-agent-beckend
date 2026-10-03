-- Browser time gets its own number (HLD 7.4). Until now `tool_credits` held browser credits only
-- (no paid tool existed), so the old values move over.
ALTER TABLE "usage_periods" ADD COLUMN "browser_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "usage_periods" SET "browser_credits" = "tool_credits", "tool_credits" = 0 WHERE "tool_credits" <> 0;--> statement-breakpoint
-- The user may choose Textcrew AI over their own key or Claude plan (HLD 7.1).
ALTER TABLE "agent_settings" ADD COLUMN "ai_preference" text DEFAULT 'auto' NOT NULL;
