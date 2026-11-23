CREATE TABLE "project_ranges" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"start_sec" real NOT NULL,
	"end_sec" real NOT NULL,
	"mode" text DEFAULT 'find' NOT NULL,
	"origin" text NOT NULL,
	"label" text,
	"ref" text,
	"billed_sec" real NOT NULL,
	"picked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "range_id" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "covered" jsonb;--> statement-breakpoint
ALTER TABLE "project_ranges" ADD CONSTRAINT "project_ranges_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_ranges_project_idx" ON "project_ranges" USING btree ("project_id","start_sec");--> statement-breakpoint
ALTER TABLE "clips" ADD CONSTRAINT "clips_range_id_project_ranges_id_fk" FOREIGN KEY ("range_id") REFERENCES "public"."project_ranges"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- every project whose length is known gets its one "whole" range: the video, or the start a partly processed one covers;
-- picked already when moments were picked in it (a later run then picks only in ranges added after this)
INSERT INTO "project_ranges" ("id", "project_id", "start_sec", "end_sec", "mode", "origin", "billed_sec", "picked_at")
SELECT gen_random_uuid()::text, p."id", 0, least(coalesce(p."source_limit_sec", p."duration_sec"), p."duration_sec"), 'find', 'whole',
       least(coalesce(p."source_limit_sec", p."duration_sec"), p."duration_sec"),
       CASE WHEN EXISTS (SELECT 1 FROM "clips" c WHERE c."project_id" = p."id" AND c."origin" = 'ai') THEN now() END
FROM "projects" p
WHERE p."duration_sec" > 0;--> statement-breakpoint
UPDATE "clips" c SET "range_id" = r."id"
FROM "project_ranges" r
WHERE r."project_id" = c."project_id" AND c."start_sec" >= r."start_sec" AND c."start_sec" < r."end_sec";
--> statement-breakpoint
-- a partly processed video's transcript covers [0, covered_sec); null (every other transcript) is the whole video
UPDATE "transcripts" SET "covered" = jsonb_build_array(jsonb_build_array(0, "covered_sec")) WHERE "covered_sec" IS NOT NULL;
