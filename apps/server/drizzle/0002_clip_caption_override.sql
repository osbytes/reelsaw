ALTER TABLE "clips" ADD COLUMN "caption" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "layout_override" text;