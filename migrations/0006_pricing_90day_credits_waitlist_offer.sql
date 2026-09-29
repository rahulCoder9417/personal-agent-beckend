ALTER TABLE "coupons" ALTER COLUMN "credit_expiry_days" SET DEFAULT 90;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD COLUMN "offer_used_at" timestamp with time zone;