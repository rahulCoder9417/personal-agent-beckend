CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"details" jsonb,
	"credits_charged" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"external_id" text NOT NULL,
	"display_id" text DEFAULT '' NOT NULL,
	"last_inbound_at" timestamp with time zone,
	"blocked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "link_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "link_codes_codeHash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"clerk_id" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_clerkId_unique" UNIQUE("clerk_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"media_ref" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"event_id" text,
	"approval_id" text,
	"client_message_id" text,
	"external_id" text,
	"session_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"user_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"queue" text,
	"job_name" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channel_links" ADD CONSTRAINT "channel_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "link_codes" ADD CONSTRAINT "link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_user_id_id_index" ON "audit_log" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_links_channel_external_id_index" ON "channel_links" USING btree ("channel","external_id");--> statement-breakpoint
CREATE INDEX "channel_links_user_id_index" ON "channel_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "link_codes_user_id_index" ON "link_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_user_id_id_index" ON "messages" USING btree ("user_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_user_id_client_message_id_index" ON "messages" USING btree ("user_id","client_message_id");--> statement-breakpoint
CREATE INDEX "messages_channel_external_id_index" ON "messages" USING btree ("channel","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "events_source_external_id_index" ON "events" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "events_status_created_at_index" ON "events" USING btree ("status","created_at");