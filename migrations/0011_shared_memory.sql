CREATE TABLE "chat_engines" (
	"user_id" text NOT NULL,
	"session_key" text NOT NULL,
	"runtime" text NOT NULL,
	"last_turn_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_engines_user_id_session_key_runtime_pk" PRIMARY KEY("user_id","session_key","runtime")
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text DEFAULT 'fact' NOT NULL,
	"content" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "memories_user_id_id_index" ON "memories" USING btree ("user_id","id");