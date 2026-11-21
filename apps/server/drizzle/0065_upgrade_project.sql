ALTER TABLE "user_settings" ADD COLUMN "upgrade_project_id" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "upgrade_project_at" timestamp with time zone;