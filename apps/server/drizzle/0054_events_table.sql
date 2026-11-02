-- One events table for every event (u.emit): project_events becomes events, keeping its ids (webhook deliveries,
-- completion notices and live-stream resumes point at them); admin_events' rows move in with new ids.
ALTER TABLE "project_events" RENAME TO "events";--> statement-breakpoint
ALTER TABLE "events" RENAME CONSTRAINT "project_events_pkey" TO "events_pkey";--> statement-breakpoint
ALTER SEQUENCE "project_events_id_seq" RENAME TO "events_id_seq";--> statement-breakpoint
ALTER INDEX "project_events_project_id_idx" RENAME TO "events_project_id_idx";--> statement-breakpoint
-- a project's events outlive "Delete forever", like its decisions; they are forgotten with them (decisions/service.ts)
ALTER TABLE "events" DROP CONSTRAINT "project_events_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "events" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "actor_id" text;--> statement-breakpoint
-- a project event's account is its project's owner
UPDATE "events" e SET "user_id" = p."user_id" FROM "projects" p WHERE p."id" = e."project_id";--> statement-breakpoint
CREATE INDEX "events_user_id_idx" ON "events" USING btree ("user_id","id");--> statement-breakpoint
-- account events: the account and its address move into the payload, where every account event schema has them
INSERT INTO "events" ("type", "user_id", "actor_id", "payload", "created_at")
SELECT "type", "user_id", "actor_id", "payload" || jsonb_build_object('userId', "user_id", 'email', "email"), "created_at"
FROM "admin_events" ORDER BY "id";--> statement-breakpoint
DROP TABLE "admin_events";
