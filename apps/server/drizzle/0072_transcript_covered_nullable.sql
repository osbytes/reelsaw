ALTER TABLE "transcripts" ALTER COLUMN "covered" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "transcripts" ALTER COLUMN "covered" DROP NOT NULL;--> statement-breakpoint
-- null = the whole video (coverageOf); an empty list left by 0071's default was a transcript written whole
UPDATE "transcripts" SET "covered" = NULL WHERE "covered" = '[]'::jsonb;
