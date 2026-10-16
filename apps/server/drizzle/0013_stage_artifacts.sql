CREATE TABLE "stage_artifacts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"stage" text NOT NULL,
	"kind" text NOT NULL,
	"models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "stage_artifacts" ADD CONSTRAINT "stage_artifacts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stage_artifacts_project_id_idx" ON "stage_artifacts" USING btree ("project_id","id");