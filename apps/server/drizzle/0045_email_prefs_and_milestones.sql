CREATE TABLE "finished_projects" (
	"project_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"first_event_id" bigint NOT NULL,
	"first_done_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "ready_email" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "finished_projects" ADD CONSTRAINT "finished_projects_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finished_projects_user_id_idx" ON "finished_projects" USING btree ("user_id");--> statement-breakpoint
-- every project that already finished (the first project.done per project still in the log)
INSERT INTO "finished_projects" ("project_id", "user_id", "first_event_id", "first_done_at")
SELECT e."project_id", p."user_id", min(e."id"), min(e."created_at")
FROM "project_events" e JOIN "projects" p ON p."id" = e."project_id"
WHERE e."type" = 'project.done'
GROUP BY e."project_id", p."user_id";