CREATE TABLE "admin_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"actor_id" text,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "role" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "banned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "ban_reason" text;--> statement-breakpoint
CREATE INDEX "admin_events_user_id_idx" ON "admin_events" USING btree ("user_id","id");--> statement-breakpoint
-- existing accounts keep working: everyone already here is approved, the oldest account administers the box
UPDATE "user" SET "approved_at" = "created_at" WHERE "approved_at" IS NULL;--> statement-breakpoint
UPDATE "user" SET "role" = 'admin' WHERE "id" = (SELECT "id" FROM "user" ORDER BY "created_at" LIMIT 1) AND NOT EXISTS (SELECT 1 FROM "user" WHERE "role" = 'admin');
