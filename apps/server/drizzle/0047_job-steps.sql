CREATE TABLE "job_steps" (
	"project_id" text NOT NULL,
	"clip_id" text,
	"stage" text NOT NULL,
	"name" text NOT NULL,
	"key" text NOT NULL,
	"status" text NOT NULL,
	"output" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"stage_seq" integer NOT NULL,
	"ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_steps_project_id_stage_name_key_pk" PRIMARY KEY("project_id","stage","name","key")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "stage_detail" jsonb;--> statement-breakpoint
ALTER TABLE "job_steps" ADD CONSTRAINT "job_steps_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_steps_project_stage_idx" ON "job_steps" USING btree ("project_id","stage");