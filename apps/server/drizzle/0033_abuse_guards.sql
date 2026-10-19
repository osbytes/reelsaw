CREATE TABLE "user_rate" (
	"user_id" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"n" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "user_rate_user_id_bucket_pk" PRIMARY KEY("user_id","bucket")
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "email_key" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "signup_ip" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "flags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- backfill one key per real mailbox (abuse.ts emailKey: lower-case, +tag dropped, gmail dots dropped); when two
-- existing accounts fold to the same key, the older keeps it and the newer stays null (the guard treats null as
-- "no key": it can still sign in, and no third account can take that mailbox)
UPDATE "user" u SET email_key = k.key FROM (
  SELECT id, key FROM (
    SELECT id, key, row_number() OVER (PARTITION BY key ORDER BY created_at, id) AS rn FROM (
      SELECT id, created_at,
        CASE WHEN domain IN ('gmail.com', 'googlemail.com') THEN replace(local, '.', '') || '@gmail.com' ELSE local || '@' || domain END AS key
      FROM (
        SELECT id, created_at,
          regexp_replace(split_part(lower(email), '@', 1), '\+.*$', '') AS local,
          split_part(lower(email), '@', 2) AS domain
        FROM "user"
      ) parts
    ) keyed
  ) ranked WHERE rn = 1
) k WHERE k.id = u.id;--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_key_idx" ON "user" USING btree ("email_key");--> statement-breakpoint
CREATE INDEX "user_signup_ip_idx" ON "user" USING btree ("signup_ip","created_at");