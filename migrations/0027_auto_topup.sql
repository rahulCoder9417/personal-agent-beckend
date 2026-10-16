CREATE TABLE "auto_topup_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"top_up_id" text NOT NULL,
	"credits" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"polar_order_id" text,
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_topup_attempts_idempotencyKey_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "auto_topup_attempts_polarOrderId_unique" UNIQUE("polar_order_id")
);
--> statement-breakpoint
CREATE TABLE "auto_topup_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"threshold_credits" integer NOT NULL,
	"top_up_id" text NOT NULL,
	"monthly_cap" integer NOT NULL,
	"consented_at" timestamp with time zone,
	"card_brand" text,
	"card_last4" text,
	"declines_in_row" integer DEFAULT 0 NOT NULL,
	"turned_off_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auto_topup_attempts_user_id_created_at_index" ON "auto_topup_attempts" USING btree ("user_id","created_at");