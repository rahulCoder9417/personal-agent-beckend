CREATE TABLE "coupon_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"coupon_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"code_prefix" text NOT NULL,
	"max_redemptions" integer NOT NULL,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_codes_codeHash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "coupon_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"coupon_id" text NOT NULL,
	"code_id" text NOT NULL,
	"user_id" text NOT NULL,
	"ip" text,
	"grant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coupons" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign" text NOT NULL,
	"code_prefix" text NOT NULL,
	"credits" integer NOT NULL,
	"max_redemptions" integer NOT NULL,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"code_count" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"credit_expiry_days" integer DEFAULT 30 NOT NULL,
	"cheap_model_only" boolean DEFAULT true NOT NULL,
	"new_users_only" boolean DEFAULT false NOT NULL,
	"plans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"amount" integer NOT NULL,
	"remaining" integer NOT NULL,
	"expires_at" timestamp with time zone,
	"cheap_model_only" boolean DEFAULT false NOT NULL,
	"ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"grant_id" text,
	"delta" integer NOT NULL,
	"reason" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_ledger_idempotencyKey_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "litellm_keys" (
	"user_id" text PRIMARY KEY NOT NULL,
	"key_encrypted" text NOT NULL,
	"key_alias" text NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_budget_micro_usd" bigint,
	"synced_spend_micro_usd" bigint DEFAULT 0 NOT NULL,
	"synced_model_spend" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"dodo_payment_id" text NOT NULL,
	"dodo_subscription_id" text,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"credits" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_dodoPaymentId_unique" UNIQUE("dodo_payment_id")
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"plan" text NOT NULL,
	"dodo_subscription_id" text NOT NULL,
	"status" text NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_dodoSubscriptionId_unique" UNIQUE("dodo_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "usage_periods" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"ai_cost_micro_usd" bigint DEFAULT 0 NOT NULL,
	"ai_credits" integer DEFAULT 0 NOT NULL,
	"awake_seconds" integer DEFAULT 0 NOT NULL,
	"awake_credits" integer DEFAULT 0 NOT NULL,
	"browser_seconds" integer DEFAULT 0 NOT NULL,
	"tool_credits" integer DEFAULT 0 NOT NULL,
	"credits_charged" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "byok_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"key_encrypted" text NOT NULL,
	"last4" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coupon_codes" ADD CONSTRAINT "coupon_codes_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coupon_codes_coupon_id_index" ON "coupon_codes" USING btree ("coupon_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coupon_redemptions_coupon_id_user_id_index" ON "coupon_redemptions" USING btree ("coupon_id","user_id");--> statement-breakpoint
CREATE INDEX "coupon_redemptions_ip_created_at_index" ON "coupon_redemptions" USING btree ("ip","created_at");--> statement-breakpoint
CREATE INDEX "credit_grants_user_id_expires_at_index" ON "credit_grants" USING btree ("user_id","expires_at");--> statement-breakpoint
CREATE INDEX "credit_grants_source_created_at_index" ON "credit_grants" USING btree ("source","created_at");--> statement-breakpoint
CREATE INDEX "credit_grants_ref_index" ON "credit_grants" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_id_id_index" ON "credit_ledger" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "credit_ledger_grant_id_index" ON "credit_ledger" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "payments_user_id_index" ON "payments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscriptions_user_id_index" ON "subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "subscriptions_status_period_end_index" ON "subscriptions" USING btree ("status","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "usage_periods_user_id_period_start_index" ON "usage_periods" USING btree ("user_id","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "byok_keys_user_id_provider_index" ON "byok_keys" USING btree ("user_id","provider");--> statement-breakpoint
-- The credit ledger is append-only: rows are never edited (deletes stay possible for account deletion).
CREATE FUNCTION credit_ledger_no_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'credit_ledger is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE ON "credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION credit_ledger_no_update();
