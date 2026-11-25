/**
 * Ranges against the minutes (docs/specs/range-clipping.md): a project of ranges is admitted whole or refused with
 * the ranges' own wording and the upgrade offer, never cut to its start the way a whole video is.
 * Run: pnpm --filter @reelsaw/server test   (needs `docker compose up`)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  LIMIT_KEYS,
  type InstanceLimits,
  QuotaError,
  QuotaExceededError,
  admitRanges,
  checkRanges,
  recordProjectCreated,
  recordSourceDuration,
} from "../src/quota.js";
import { schema } from "../src/db/index.js";
import { db } from "./helpers.js";

const pool = db();
const orm = drizzle(pool, { schema });
const userId = `ranges-${randomUUID()}`;

/** An instance with only a monthly minutes cap. */
const instance = (perMonth: number) =>
  ({
    ...Object.fromEntries(LIMIT_KEYS.map((k) => [k, 0])),
    MAX_SOURCE_MINUTES_PER_MONTH: perMonth,
    WATERMARK_NON_ADMINS: false,
    WATERMARK_TEXT: "",
  }) as InstanceLimits;

describe("admitRanges", () => {
  before(async () => {
    await pool.query(`insert into "user" (id, name, email, email_verified, created_at, updated_at) values ($1, 'Ranges', $2, true, now(), now())`, [
      userId,
      `${userId}@example.com`,
    ]);
  });
  after(async () => {
    await pool.query(`delete from "user" where id = $1`, [userId]);
    await pool.end();
  });

  it("admits ranges that fit the minutes left", async () => {
    await admitRanges(orm, instance(30), userId, null, 10 * 60, null);
  });

  it("refuses ranges past the minutes whole, worded for ranges, instead of cutting them", async () => {
    await assert.rejects(
      () => admitRanges(orm, instance(30), userId, null, 400 * 60, null),
      (err: unknown) => {
        assert.ok(err instanceof QuotaExceededError);
        assert.match(err.message, /^These ranges are 400 minutes/);
        assert.equal(err.limit, "MAX_SOURCE_MINUTES_PER_MONTH");
        return true;
      },
    );
  });

  it("refuses ranges on a request as a TOO_MANY_REQUESTS QuotaError with the offer, not as an internal error", async () => {
    await assert.rejects(
      () => checkRanges(orm, instance(30), userId, null, 400 * 60, null),
      (err: unknown) => {
        assert.ok(err instanceof QuotaError);
        assert.equal(err.code, "TOO_MANY_REQUESTS");
        assert.match(err.messageId ?? "", /^quota\.ranges_over_/);
        assert.match(err.message, /^These ranges are 400 minutes/);
        assert.equal(err.limit, "MAX_SOURCE_MINUTES_PER_MONTH");
        assert.equal(err.quota?.key, "MAX_SOURCE_MINUTES_PER_MONTH");
        return true;
      },
    );
    await checkRanges(orm, instance(30), userId, null, 10 * 60, null);
  });

  it("counts the minutes other projects used, and not the project being admitted", async () => {
    const projectId = randomUUID();
    await pool.query(`insert into projects (id, user_id, title, source_type, settings) values ($1, $2, 'r', 'url', '{}')`, [projectId, userId]);
    await recordProjectCreated(orm, userId, projectId, new Date());
    await recordSourceDuration(orm, projectId, 25 * 60);
    // 25 of 30 used by that project: 10 more do not fit for another one, but fit when re-admitting that same project
    await assert.rejects(() => admitRanges(orm, instance(30), userId, null, 10 * 60, null), QuotaExceededError);
    await admitRanges(orm, instance(30), userId, projectId, 10 * 60, null);
  });
});
