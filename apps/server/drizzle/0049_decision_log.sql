CREATE TABLE "user_decisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"project_id" text NOT NULL,
	"clip_id" text,
	"kind" text NOT NULL,
	"explicit" boolean NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"context" jsonb NOT NULL,
	"models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" jsonb NOT NULL,
	"app_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "learn_from_decisions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "user_decisions" ADD CONSTRAINT "user_decisions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_decisions_user_idx" ON "user_decisions" USING btree ("user_id","id");--> statement-breakpoint
CREATE INDEX "user_decisions_user_kind_idx" ON "user_decisions" USING btree ("user_id","kind","id");--> statement-breakpoint
CREATE INDEX "user_decisions_project_idx" ON "user_decisions" USING btree ("project_id","id");