CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sandbox_tokens" (
	"user_id" text PRIMARY KEY NOT NULL,
	"mcp_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_tokens_mcpTokenHash_unique" UNIQUE("mcp_token_hash")
);
--> statement-breakpoint
CREATE INDEX "attachments_user_id_index" ON "attachments" USING btree ("user_id");