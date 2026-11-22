ALTER TABLE "transcripts" ADD COLUMN "covered" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- what each transcript covers, as spans: [0, covered_sec) for a partly processed video, else the whole video
UPDATE "transcripts" t
SET "covered" = jsonb_build_array(jsonb_build_array(0, coalesce(t."covered_sec", p."duration_sec")))
FROM "projects" p
WHERE p."id" = t."project_id" AND coalesce(t."covered_sec", p."duration_sec") > 0;
