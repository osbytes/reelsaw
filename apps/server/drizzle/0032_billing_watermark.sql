CREATE TABLE "billing_customers" (
	"user_id" text PRIMARY KEY NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_customers_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"subscription_id" text,
	"created" timestamp with time zone NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"user_id" text PRIMARY KEY NOT NULL,
	"stripe_subscription_id" text,
	"stripe_customer_id" text,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"interval" text,
	"price_id" text,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"past_due_since" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "watermark" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "watermark" boolean;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD CONSTRAINT "billing_customers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_events_subscription_idx" ON "billing_events" USING btree ("subscription_id","created");--> statement-breakpoint
CREATE INDEX "billing_events_pending_idx" ON "billing_events" USING btree ("received_at") WHERE processed_at is null;--> statement-breakpoint
CREATE INDEX "billing_subscriptions_customer_idx" ON "billing_subscriptions" USING btree ("stripe_customer_id");