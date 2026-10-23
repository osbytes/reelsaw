CREATE TABLE "asset_refs" (
	"asset_id" text NOT NULL,
	"project_id" text NOT NULL,
	"clip_id" text,
	"role" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_saves" (
	"user_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_saves_user_id_asset_id_pk" PRIMARY KEY("user_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "bumper_assets" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bumper_assets" ADD COLUMN "mime" text;--> statement-breakpoint
ALTER TABLE "bumper_assets" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bumper_assets" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "bumper_assets" ADD COLUMN "system" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "layers" jsonb;--> statement-breakpoint
ALTER TABLE "asset_refs" ADD CONSTRAINT "asset_refs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_refs" ADD CONSTRAINT "asset_refs_clip_id_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_saves" ADD CONSTRAINT "library_saves_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_saves" ADD CONSTRAINT "library_saves_asset_id_bumper_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."bumper_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_refs_asset_idx" ON "asset_refs" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "asset_refs_project_idx" ON "asset_refs" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "asset_refs_clip_idx" ON "asset_refs" USING btree ("clip_id");--> statement-breakpoint
CREATE INDEX "library_saves_asset_idx" ON "library_saves" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bumper_assets_shared_source_idx" ON "bumper_assets" USING btree (("provenance"->>'provider'),("provenance"->>'externalId'),coalesce("provenance"->>'variant', '')) WHERE "bumper_assets"."user_id" is null and "bumper_assets"."deleted_at" is null;