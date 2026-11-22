ALTER TABLE "resource_leases" ADD COLUMN "reserved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "resources" jsonb;--> statement-breakpoint
CREATE INDEX "resource_leases_user_idx" ON "resource_leases" USING btree ("user_id","expires_at");