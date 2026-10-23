CREATE TABLE "library_saves" (
	"user_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "library_saves_user_id_asset_id_pk" PRIMARY KEY("user_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "bumper_assets" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "library_saves" ADD CONSTRAINT "library_saves_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_saves" ADD CONSTRAINT "library_saves_asset_id_bumper_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."bumper_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "library_saves_asset_idx" ON "library_saves" USING btree ("asset_id");