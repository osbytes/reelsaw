CREATE INDEX "bumper_assets_deleted_idx" ON "bumper_assets" USING btree ("deleted_at") WHERE "bumper_assets"."deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "clips_retention_idx" ON "clips" USING btree ("updated_at") WHERE "clips"."output_key" is not null and "clips"."status" = 'done';--> statement-breakpoint
CREATE INDEX "projects_user_updated_idx" ON "projects" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "projects_status_idx" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "projects_source_retention_idx" ON "projects" USING btree ("updated_at") WHERE "projects"."source_key" is not null and "projects"."source_expired_at" is null;--> statement-breakpoint
CREATE INDEX "uploads_user_id_idx" ON "uploads" USING btree ("user_id");