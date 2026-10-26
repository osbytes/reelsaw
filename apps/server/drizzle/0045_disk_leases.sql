CREATE TABLE "disk_leases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"volume" text NOT NULL,
	"worker_id" text NOT NULL,
	"job_id" text,
	"project_id" text,
	"kind" text NOT NULL,
	"mb" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_instances" ADD COLUMN "volume" text;--> statement-breakpoint
ALTER TABLE "worker_instances" ADD COLUMN "disk_leased_mb" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "disk_leases_volume_idx" ON "disk_leases" USING btree ("volume","expires_at");--> statement-breakpoint
CREATE INDEX "disk_leases_worker_idx" ON "disk_leases" USING btree ("worker_id");