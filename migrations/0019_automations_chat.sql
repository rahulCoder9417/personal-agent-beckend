-- The Automations chat: every run of every automation answers in one conversation of its own
-- (`kind` = 'automations', at most one per user). A copy of a run's answer sent to a Telegram
-- chat points at the message it copies (`copy_of`, once per message), and a turn's messages are
-- found by its id (`event_id`). Only adds: `automations.conversation_id` stays, unused.
ALTER TABLE "conversations" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "copy_of" text;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_automations_chat" ON "conversations" USING btree ("user_id") WHERE "conversations"."kind" = 'automations';--> statement-breakpoint
CREATE UNIQUE INDEX "messages_user_id_copy_of_index" ON "messages" USING btree ("user_id","copy_of");--> statement-breakpoint
CREATE INDEX "messages_user_id_event_id_index" ON "messages" USING btree ("user_id","event_id");