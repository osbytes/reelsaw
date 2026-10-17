CREATE TABLE "bumper_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text DEFAULT 'video' NOT NULL,
	"name" text NOT NULL,
	"duration_sec" real NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"has_audio" boolean NOT NULL,
	"source_key" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bumper_assets" ADD CONSTRAINT "bumper_assets_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bumper_assets_user_idx" ON "bumper_assets" USING btree ("user_id");