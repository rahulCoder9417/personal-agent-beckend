CREATE TABLE "coupon_redeemer_marks" (
	"coupon_id" text NOT NULL,
	"mark" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coupon_redeemer_marks_coupon_id_mark_pk" PRIMARY KEY("coupon_id","mark")
);
--> statement-breakpoint
CREATE TABLE "signup_email_marks" (
	"mark" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coupon_redeemer_marks" ADD CONSTRAINT "coupon_redeemer_marks_coupon_id_coupons_id_fk" FOREIGN KEY ("coupon_id") REFERENCES "public"."coupons"("id") ON DELETE no action ON UPDATE no action;