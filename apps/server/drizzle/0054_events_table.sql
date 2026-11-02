-- admin_events becomes the shared events table (the outbox for everything that is not a project's own
-- history): a rename, so rows, ids and the admin page's history are kept
ALTER TABLE "admin_events" RENAME TO "events";--> statement-breakpoint
ALTER TABLE "events" RENAME CONSTRAINT "admin_events_pkey" TO "events_pkey";--> statement-breakpoint
ALTER SEQUENCE "admin_events_id_seq" RENAME TO "events_id_seq";--> statement-breakpoint
ALTER INDEX "admin_events_user_id_idx" RENAME TO "events_user_id_idx";
