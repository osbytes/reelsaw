CREATE TABLE "asset_refs" (
	"asset_id" text NOT NULL,
	"project_id" text NOT NULL,
	"clip_id" text,
	"role" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bumper_assets" ADD COLUMN "mime" text;--> statement-breakpoint
ALTER TABLE "bumper_assets" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "bumper_assets" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bumper_assets" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "bumper_assets" ADD COLUMN "system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "layers" jsonb;--> statement-breakpoint
ALTER TABLE "asset_refs" ADD CONSTRAINT "asset_refs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_refs" ADD CONSTRAINT "asset_refs_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_refs_asset_idx" ON "asset_refs" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_refs_project_idx" ON "asset_refs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "asset_refs_clip_idx" ON "asset_refs" USING btree ("clip_id");