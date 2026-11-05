CREATE TABLE "email_topic_prefs" (
	"user_id" text NOT NULL,
	"topic" text NOT NULL,
	"enabled" boolean NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_topic_prefs_user_id_topic_pk" PRIMARY KEY("user_id","topic")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ready_mailed_through" bigint;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_topic_prefs" ADD CONSTRAINT "email_topic_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- what already finished is not news: the first ready note after the upgrade covers only finishes after it
UPDATE "projects" p SET "ready_mailed_through" = d."last_done"
FROM (SELECT "project_id", max("id") AS "last_done" FROM "project_events" WHERE "type" = 'project.done' GROUP BY "project_id") d
WHERE d."project_id" = p."id";--> statement-breakpoint
ALTER TABLE "source_usage" ADD COLUMN "first_done_event_id" bigint;--> statement-breakpoint
-- each project's first finish still in the log, for the ready email's milestones
UPDATE "source_usage" su SET "first_done_event_id" = d."first_done"
FROM (SELECT "project_id", min("id") AS "first_done" FROM "project_events" WHERE "type" = 'project.done' GROUP BY "project_id") d
WHERE d."project_id" = su."project_id";
