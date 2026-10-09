-- Conversations: every message belongs to one (docs/backend-report.md, "Conversations").
-- The tables first, then what is already stored is put into conversations, then the rules that
-- need every row filled in.
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_key" text NOT NULL,
	"channel" text NOT NULL,
	"epoch" integer NOT NULL,
	"title" text,
	"active" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "chat_engines" ADD COLUMN "epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- Which engine last ran: kept per conversation from now on. In a chat where the user started a
-- new chat, a record from before that start belongs to the conversation before it.
UPDATE "chat_engines" g
SET "epoch" = CASE WHEN g."last_turn_at" >= e."started_at" THEN e."epoch" ELSE e."epoch" - 1 END
FROM "chat_epochs" e
WHERE e."user_id" = g."user_id" AND e."session_key" = g."session_key" AND e."epoch" > 0;--> statement-breakpoint
ALTER TABLE "chat_engines" DROP CONSTRAINT "chat_engines_user_id_session_key_runtime_pk";--> statement-breakpoint
ALTER TABLE "chat_engines" ADD CONSTRAINT "chat_engines_user_id_session_key_epoch_runtime_pk" PRIMARY KEY("user_id","session_key","epoch","runtime");--> statement-breakpoint

-- 1. A chat where the user started a new chat (it has a counter row): its current conversation,
--    with the chat's current number, from the time of the latest start.
INSERT INTO "conversations" ("id", "user_id", "session_key", "channel", "epoch", "active", "started_at", "last_message_at")
SELECT 'cnv_' || replace(gen_random_uuid()::text, '-', ''), e."user_id", e."session_key",
       split_part(e."session_key", ':', 1), e."epoch", true,
       date_trunc('milliseconds', e."started_at"), date_trunc('milliseconds', e."started_at")
FROM "chat_epochs" e;--> statement-breakpoint

-- 2. What was said in such a chat before its latest start: one conversation, numbered one below
--    the current one (earlier starts were not recorded, so everything before is kept together).
--    A message with no session key (very old rows) is grouped by its channel.
INSERT INTO "conversations" ("id", "user_id", "session_key", "channel", "epoch", "active", "started_at", "last_message_at")
SELECT 'cnv_' || replace(gen_random_uuid()::text, '-', ''), m."user_id", e."session_key",
       min(m."channel"), e."epoch" - 1, false,
       date_trunc('milliseconds', min(m."created_at")), date_trunc('milliseconds', max(m."created_at"))
FROM "messages" m
JOIN "chat_epochs" e
  ON e."user_id" = m."user_id" AND e."session_key" = coalesce(m."session_key", m."channel")
WHERE e."epoch" > 0 AND m."created_at" < e."started_at"
GROUP BY m."user_id", e."session_key", e."epoch";--> statement-breakpoint

-- 3. A chat with messages and no counter row never had a new chat: one conversation, number 0,
--    with all of its messages.
INSERT INTO "conversations" ("id", "user_id", "session_key", "channel", "epoch", "active", "started_at", "last_message_at")
SELECT 'cnv_' || replace(gen_random_uuid()::text, '-', ''), m."user_id", coalesce(m."session_key", m."channel"),
       min(m."channel"), 0, true,
       date_trunc('milliseconds', min(m."created_at")), date_trunc('milliseconds', max(m."created_at"))
FROM "messages" m
WHERE NOT EXISTS (
  SELECT 1 FROM "chat_epochs" e
  WHERE e."user_id" = m."user_id" AND e."session_key" = coalesce(m."session_key", m."channel")
)
GROUP BY m."user_id", coalesce(m."session_key", m."channel");--> statement-breakpoint

-- Every message gets its conversation: the earlier one when it was saved before the chat's latest
-- start, else the chat's current one.
UPDATE "messages" m
SET "conversation_id" = c."id"
FROM "conversations" c
JOIN "chat_epochs" e ON e."user_id" = c."user_id" AND e."session_key" = c."session_key"
WHERE c."user_id" = m."user_id" AND c."session_key" = coalesce(m."session_key", m."channel")
  AND NOT c."active" AND m."created_at" < e."started_at";--> statement-breakpoint
UPDATE "messages" m
SET "conversation_id" = c."id"
FROM "conversations" c
WHERE m."conversation_id" IS NULL
  AND c."user_id" = m."user_id" AND c."session_key" = coalesce(m."session_key", m."channel")
  AND c."active";--> statement-breakpoint

-- When each conversation's newest message was saved.
UPDATE "conversations" c
SET "last_message_at" = s."last"
FROM (
  SELECT "conversation_id", date_trunc('milliseconds', max("created_at")) AS "last"
  FROM "messages" GROUP BY "conversation_id"
) s
WHERE s."conversation_id" = c."id";--> statement-breakpoint

-- The title: the first incoming message's text, its whitespace made single spaces, cut to 60
-- characters at a word (the same cut as titleFromText in channels/conversations.ts).
UPDATE "conversations" c
SET "title" = CASE
  WHEN length(f."t") <= 60 THEN f."t"
  ELSE coalesce(nullif(substring(left(f."t", 61) from '^(.*)\s'), ''), left(f."t", 60))
END
FROM (
  SELECT DISTINCT ON ("conversation_id") "conversation_id",
         btrim(regexp_replace("text", '\s+', ' ', 'g')) AS "t"
  FROM "messages"
  WHERE "direction" = 'in' AND btrim(regexp_replace("text", '\s+', ' ', 'g')) <> ''
  ORDER BY "conversation_id", "id"
) f
WHERE f."conversation_id" = c."id";--> statement-breakpoint

-- Every chat that has a conversation has a counter row from now on: the highest number given out
-- in it. A number is never given out twice.
INSERT INTO "chat_epochs" ("user_id", "session_key", "epoch", "started_at")
SELECT c."user_id", c."session_key", c."epoch", c."started_at"
FROM "conversations" c
WHERE c."active" AND NOT EXISTS (
  SELECT 1 FROM "chat_epochs" e
  WHERE e."user_id" = c."user_id" AND e."session_key" = c."session_key"
);--> statement-breakpoint

ALTER TABLE "messages" ALTER COLUMN "conversation_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_user_id_session_key_epoch_index" ON "conversations" USING btree ("user_id","session_key","epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_active_per_chat" ON "conversations" USING btree ("user_id","session_key") WHERE "conversations"."active";--> statement-breakpoint
CREATE INDEX "conversations_user_id_last_message_at_id_index" ON "conversations" USING btree ("user_id","last_message_at","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "messages_conversation_id_id_index" ON "messages" USING btree ("conversation_id","id");
