ALTER TABLE "worker_instances" ADD COLUMN "disk_free_mb" integer DEFAULT -1 NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_instances" ADD COLUMN "disk_total_mb" integer DEFAULT 0 NOT NULL;