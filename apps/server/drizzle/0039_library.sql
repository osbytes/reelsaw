ALTER TABLE "bumper_assets" RENAME TO "assets";--> statement-breakpoint
ALTER INDEX "bumper_assets_user_idx" RENAME TO "assets_user_idx";--> statement-breakpoint
ALTER INDEX "bumper_assets_hash_idx" RENAME TO "assets_hash_idx";--> statement-breakpoint
ALTER INDEX "bumper_assets_deleted_idx" RENAME TO "assets_deleted_idx";--> statement-breakpoint
ALTER TABLE "assets" RENAME CONSTRAINT "bumper_assets_user_id_user_id_fk" TO "assets_user_id_user_id_fk";--> statement-breakpoint
CREATE TABLE "asset_refs" (
	"asset_id" text NOT NULL,
	"project_id" text NOT NULL,
	"clip_id" text,
	"role" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "asset_saves" (
	"user_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_saves_user_id_asset_id_pk" PRIMARY KEY("user_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "assets" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "mime" text;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "layers" jsonb;--> statement-breakpoint
ALTER TABLE "asset_refs" ADD CONSTRAINT "asset_refs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_refs" ADD CONSTRAINT "asset_refs_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_saves" ADD CONSTRAINT "asset_saves_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_saves" ADD CONSTRAINT "asset_saves_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_refs_asset_idx" ON "asset_refs" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_refs_project_idx" ON "asset_refs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "asset_refs_clip_idx" ON "asset_refs" USING btree ("clip_id");--> statement-breakpoint
CREATE INDEX "asset_saves_asset_idx" ON "asset_saves" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_shared_source_idx" ON "assets" USING btree (("provenance"->>'provider'),("provenance"->>'externalId'),coalesce("provenance"->>'variant', '')) WHERE "assets"."user_id" is null and "assets"."deleted_at" is null;