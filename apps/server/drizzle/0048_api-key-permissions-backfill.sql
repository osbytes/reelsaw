-- Keys created before permissions existed carry none and were treated as full admin in code. Make that grant explicit
-- (visible and revocable in Settings -> API keys) so a key with no record can mean "no admin" from here on.
UPDATE "apikey" SET "permissions" = '{"admin":["write"]}' WHERE "permissions" IS NULL;
