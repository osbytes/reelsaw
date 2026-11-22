CREATE TABLE "resource_leases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"volume" text NOT NULL,
	"machine" text NOT NULL,
	"worker_id" text NOT NULL,
	"job_id" text,
	"project_id" text,
	"user_id" text,
	"kind" text NOT NULL,
	"mb" integer DEFAULT 0 NOT NULL,
	"cores" integer DEFAULT 0 NOT NULL,
	"mem_mb" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_instances" ADD COLUMN "cores_leased" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "worker_instances" ADD COLUMN "mem_leased_mb" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "resource_leases_volume_idx" ON "resource_leases" USING btree ("volume","expires_at");--> statement-breakpoint
CREATE INDEX "resource_leases_machine_idx" ON "resource_leases" USING btree ("machine","expires_at");--> statement-breakpoint
CREATE INDEX "resource_leases_worker_idx" ON "resource_leases" USING btree ("worker_id");