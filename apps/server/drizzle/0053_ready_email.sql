CREATE TABLE "email_topic_prefs" (
	"user_id" text NOT NULL,
	"topic" text NOT NULL,
	"enabled" boolean NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_topic_prefs_user_id_topic_pk" PRIMARY KEY("user_id","topic")
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "ready_mailed_through" bigint;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_topic_prefs" ADD CONSTRAINT "email_topic_prefs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
