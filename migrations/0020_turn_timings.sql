CREATE TABLE "turn_timings" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"channel" text NOT NULL,
	"route" text,
	"engine" text,
	"wake" text,
	"outcome" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"stages" jsonb NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "turn_timings_user_id_started_at_index" ON "turn_timings" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "turn_timings_created_at_index" ON "turn_timings" USING btree ("created_at");