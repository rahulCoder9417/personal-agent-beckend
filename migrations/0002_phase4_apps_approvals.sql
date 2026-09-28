CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"summary" text NOT NULL,
	"app" text,
	"action" text,
	"arguments" jsonb,
	"details" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"session_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_via" text,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "composio_triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"composio_trigger_id" text NOT NULL,
	"trigger_slug" text NOT NULL,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "composio_triggers_composioTriggerId_unique" UNIQUE("composio_trigger_id")
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"app" text NOT NULL,
	"composio_account_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"account_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_mcp_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"domain" text NOT NULL,
	"auth_header_name" text,
	"auth_secret" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "approvals_user_id_id_index" ON "approvals" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "approvals_status_expires_at_index" ON "approvals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "composio_triggers_user_id_index" ON "composio_triggers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_composio_account_id_index" ON "connections" USING btree ("composio_account_id");--> statement-breakpoint
CREATE INDEX "connections_user_id_index" ON "connections" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_mcp_servers_user_id_index" ON "user_mcp_servers" USING btree ("user_id");