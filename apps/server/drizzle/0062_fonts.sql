CREATE TABLE "fonts" (
	"id" text PRIMARY KEY NOT NULL,
	"family" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "fonts_family_idx" ON "fonts" USING btree (lower("family"));