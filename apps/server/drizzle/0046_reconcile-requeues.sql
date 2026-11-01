ALTER TABLE "clips" ADD COLUMN "reconcile_requeues" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "reconcile_requeues" integer DEFAULT 0 NOT NULL;