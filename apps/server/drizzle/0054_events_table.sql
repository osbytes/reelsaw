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
DROP TABLE "admin_events";--> statement-breakpoint
CREATE INDEX "events_account_idx" ON "events" USING btree ("id") WHERE project_id is null;--> statement-breakpoint
-- For processes still on the previous version while an upgrade rolls out (a worker on another machine, a
-- container not yet restarted): the old table names stay readable and writable as views over events, so their
-- jobs neither fail nor lose an event. project_events is a simple view, which Postgres updates in place;
-- admin_events maps its email column into the payload. Drop both once every process runs this version.
CREATE VIEW "project_events" AS SELECT "id", "project_id", "type", "payload", "created_at" FROM "events" WHERE "project_id" IS NOT NULL;--> statement-breakpoint
CREATE VIEW "admin_events" AS
SELECT "id", "type", "actor_id", "user_id", coalesce("payload"->>'email', '') AS "email", "payload" - 'userId' - 'email' AS "payload", "created_at"
FROM "events" WHERE "project_id" IS NULL;--> statement-breakpoint
CREATE FUNCTION "admin_events_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "events" ("type", "user_id", "actor_id", "payload", "created_at")
  VALUES (NEW."type", NEW."user_id", NEW."actor_id",
          coalesce(NEW."payload", '{}'::jsonb) || jsonb_build_object('userId', NEW."user_id", 'email', NEW."email"),
          coalesce(NEW."created_at", now()))
  RETURNING "id" INTO NEW."id";
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "admin_events_insert" INSTEAD OF INSERT ON "admin_events" FOR EACH ROW EXECUTE FUNCTION "admin_events_insert"();
