CREATE TABLE "worker_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"hostname" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"version" text NOT NULL,
	"commit" text NOT NULL,
	"pid" integer NOT NULL,
	"cpus" integer NOT NULL,
	"mem_total_mb" integer NOT NULL,
	"gpu" jsonb,
	"renders" jsonb NOT NULL,
	"queues" text[] DEFAULT '{}'::text[] NOT NULL,
	"processing" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "worker_instances_last_seen_idx" ON "worker_instances" USING btree ("last_seen_at");
