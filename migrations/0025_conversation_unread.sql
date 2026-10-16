-- Unread conversations: when the agent's newest message in a conversation was saved
-- (`last_agent_message_at`) and up to when the user has seen it (`last_read_at`). A conversation
-- is unread while the first is later than the second. Each conversation already in the database
-- gets the time of the agent's newest message in it for both, so what was said before this change
-- counts as read and no old conversation shows as unread.
ALTER TABLE "conversations" ADD COLUMN "last_agent_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_read_at" timestamp with time zone;--> statement-breakpoint
UPDATE "conversations" SET "last_agent_message_at" = "newest"."at", "last_read_at" = "newest"."at"
FROM (
  SELECT "conversation_id", max("created_at") AS "at" FROM "messages"
  WHERE "direction" = 'out' GROUP BY "conversation_id"
) AS "newest"
WHERE "newest"."conversation_id" = "conversations"."id";
