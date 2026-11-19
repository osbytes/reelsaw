ALTER TABLE "billing_subscriptions" ADD COLUMN "cancel_at" timestamp with time zone;--> statement-breakpoint
-- rows scheduled before the column existed: Stripe sets cancel_at to the period end with cancel_at_period_end (the next sync rewrites it anyway)
UPDATE "billing_subscriptions" SET "cancel_at" = "period_end" WHERE "cancel_at_period_end" AND "status" IN ('active', 'trialing', 'past_due');
