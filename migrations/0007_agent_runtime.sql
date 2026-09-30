CREATE TABLE "agent_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"runtime" text DEFAULT 'hermes' NOT NULL,
	"claude_connected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
