CREATE TABLE "signup_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"pattern" text NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"created_by" text,
	"hits" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "held_by" text;--> statement-breakpoint
CREATE UNIQUE INDEX "signup_rules_pattern_idx" ON "signup_rules" USING btree ("kind","pattern");