ALTER TABLE "bumper_assets" ADD COLUMN "content_hash" text;--> statement-breakpoint
CREATE INDEX "bumper_assets_hash_idx" ON "bumper_assets" USING btree ("user_id","content_hash");