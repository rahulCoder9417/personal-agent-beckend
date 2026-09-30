-- Switched from Dodo Payments to Polar (2026-09-30). No production data yet: plain renames.
ALTER TABLE "payments" RENAME COLUMN "dodo_payment_id" TO "polar_order_id";--> statement-breakpoint
ALTER TABLE "payments" RENAME COLUMN "dodo_subscription_id" TO "polar_subscription_id";--> statement-breakpoint
ALTER TABLE "payments" RENAME CONSTRAINT "payments_dodoPaymentId_unique" TO "payments_polarOrderId_unique";--> statement-breakpoint
ALTER TABLE "subscriptions" RENAME COLUMN "dodo_subscription_id" TO "polar_subscription_id";--> statement-breakpoint
ALTER TABLE "subscriptions" RENAME CONSTRAINT "subscriptions_dodoSubscriptionId_unique" TO "subscriptions_polarSubscriptionId_unique";
