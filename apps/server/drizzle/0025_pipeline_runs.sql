ALTER TABLE "projects" ADD COLUMN "run_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "run_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "run_reason" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "stage_started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "projects" SET "run_seq" = 1, "run_started_at" = "created_at", "run_reason" = 'created';
