ALTER TABLE "transcripts" ADD COLUMN "raw_words" jsonb;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "flags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "entities" jsonb DEFAULT '[]'::jsonb NOT NULL;