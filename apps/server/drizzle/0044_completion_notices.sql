CREATE TABLE "completion_notices" (
	"event_id" bigint PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "completion_notices" ADD CONSTRAINT "completion_notices_event_id_project_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."project_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_notices" ADD CONSTRAINT "completion_notices_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "completion_notices_user_unsent_idx" ON "completion_notices" USING btree ("user_id") WHERE "completion_notices"."sent_at" is null;