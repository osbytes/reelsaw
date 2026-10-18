ALTER TABLE "clips" ADD COLUMN "edited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "clips_deleted_idx" ON "clips" USING btree ("deleted_at") WHERE "clips"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "projects_deleted_idx" ON "projects" USING btree ("deleted_at") WHERE "projects"."deleted_at" is not null;