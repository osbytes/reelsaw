UPDATE "clips" SET "bumpers" = '{"intro":null,"outro":null}'::jsonb WHERE "bumpers_off" = true;--> statement-breakpoint
ALTER TABLE "clips" DROP COLUMN "bumpers_off";
