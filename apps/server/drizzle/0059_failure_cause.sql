ALTER TABLE "clips" ADD COLUMN "failure_cause" text;--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "failure_dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "failure_cause" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "failure_dismissed_at" timestamp with time zone;--> statement-breakpoint
-- Rows that failed before the cause was kept: the refusals and source problems the pipeline already treated as
-- non-retryable, by their recorded wording; everything else is the platform's.
UPDATE "projects" SET "failure_cause" = CASE
  WHEN "error" LIKE 'This video is % minutes%' THEN 'quota'
  WHEN "error" LIKE 'Source has no audio track%'
    OR "error" LIKE 'Transcription returned no words%'
    OR "error" LIKE 'Could not download: the link no longer exists%'
    OR "error" LIKE 'Could not download: no usable video%'
    OR "error" LIKE 'Could not download: the video is %'
    OR "error" LIKE 'This link is a live stream%'
    OR "error" LIKE 'Uploaded source file is missing%'
  THEN 'input'
  ELSE 'platform' END
WHERE "status" = 'failed';
--> statement-breakpoint
UPDATE "clips" SET "failure_cause" = 'platform' WHERE "status" = 'failed';
