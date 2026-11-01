CREATE TABLE "completion_notices" (
	"event_id" bigint PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_topic_prefs" (
	"user_id" text NOT NULL,
	"topic" text NOT NULL,
	"enabled" boolean NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_topic_prefs_user_id_topic_pk" PRIMARY KEY("user_id","topic")
);
--> statement-breakpoint
CREATE TABLE "finished_projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"first_event_id" bigint NOT NULL,
	"first_done_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "completion_notices" ADD CONSTRAINT "completion_notices_event_id_project_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."project_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_notices" ADD CONSTRAINT "completion_notices_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_topic_prefs" ADD CONSTRAINT "email_topic_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "finished_projects" ADD CONSTRAINT "finished_projects_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "completion_notices_user_id_idx" ON "completion_notices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "finished_projects_user_id_idx" ON "finished_projects" USING btree ("user_id");--> statement-breakpoint
-- every project that already finished (the first project.done per project still in the log)
INSERT INTO "finished_projects" ("project_id", "user_id", "first_event_id", "first_done_at")
SELECT e."project_id", p."user_id", min(e."id"), min(e."created_at")
FROM "project_events" e JOIN "projects" p ON p."id" = e."project_id"
WHERE e."type" = 'project.done'
GROUP BY e."project_id", p."user_id";
