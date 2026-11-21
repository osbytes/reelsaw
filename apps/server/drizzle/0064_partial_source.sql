DROP INDEX "source_usage_project_idx";--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_limit_sec" real;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "extend_from_sec" real;--> statement-breakpoint
ALTER TABLE "source_usage" ADD COLUMN "part" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "covered_sec" real;--> statement-breakpoint
CREATE UNIQUE INDEX "source_usage_project_part_idx" ON "source_usage" USING btree ("project_id","part");