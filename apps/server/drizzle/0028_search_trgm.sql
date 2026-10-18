CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE INDEX "clips_title_trgm_idx" ON "clips" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clips_hook_trgm_idx" ON "clips" USING gin ("hook" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "clips_caption_trgm_idx" ON "clips" USING gin ("caption" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "projects_title_trgm_idx" ON "projects" USING gin ("title" gin_trgm_ops);