CREATE TABLE "provider_settings" (
	"provider" text PRIMARY KEY NOT NULL,
	"api_key_enc" text,
	"api_key_hint" text,
	"base_url" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
