CREATE TABLE "source_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"duration_sec" real,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "source_usage_project_idx" ON "source_usage" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "source_usage_user_id_idx" ON "source_usage" USING btree ("user_id","created_at");--> statement-breakpoint
INSERT INTO "source_usage" ("user_id", "project_id", "duration_sec", "created_at")
SELECT "user_id", "id", "duration_sec", "created_at" FROM "projects";