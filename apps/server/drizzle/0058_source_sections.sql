CREATE TABLE "source_sections" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"start_sec" real NOT NULL,
	"end_sec" real NOT NULL,
	"offset_sec" real NOT NULL,
	"key" text NOT NULL,
	"bytes" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_sections" ADD CONSTRAINT "source_sections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_sections_project_idx" ON "source_sections" USING btree ("project_id","start_sec");