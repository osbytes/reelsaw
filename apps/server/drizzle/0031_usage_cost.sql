CREATE TABLE "stt_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" text,
	"project_id" text,
	"stage" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"audio_sec" real DEFAULT 0 NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	"ok" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clips" ADD COLUMN "output_bytes" bigint;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "cost_usd" numeric(14, 8);--> statement-breakpoint
CREATE INDEX "stt_usage_user_id_idx" ON "stt_usage" USING btree ("user_id","created_at");