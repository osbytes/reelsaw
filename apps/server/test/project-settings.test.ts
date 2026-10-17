/**
 * How a new project's intro/outro are resolved: absent keys snapshot the user's defaults, an explicit
 * null means none, an explicit id is used, and an id the caller names that is not the user's live asset is rejected; a stale saved default is dropped.
 * Run: node --import tsx --test test/project-settings.test.ts   (needs `docker compose up` for Postgres)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "../src/db/index.js";
import { resolveProjectSettings } from "../src/pipeline/settings.js";
import { db as pool, signUp } from "./helpers.js";

describe("project intro/outro resolution", () => {
  const p = pool();
  const db = drizzle(p, { schema });
  let me: Awaited<ReturnType<typeof signUp>>;
  let other: Awaited<ReturnType<typeof signUp>>;
  const asset = (userId: string, kind: "video" | "image" = "image") => ({ id: randomUUID(), userId, kind, name: "x", durationSec: 3, width: 1080, height: 1920, hasAudio: false, sourceKey: "k", sizeBytes: 1 });
  let dflt: string, picked: string, removed: string, foreign: string;

  before(async () => {
    me = await signUp();
    other = await signUp();
    const rows = [asset(me.userId), asset(me.userId), { ...asset(me.userId), deletedAt: new Date() }, asset(other.userId)];
    await db.insert(schema.bumperAssets).values(rows);
    [dflt, picked, removed, foreign] = rows.map((r) => r.id) as [string, string, string, string];
    await db.insert(schema.userSettings).values({ userId: me.userId, projectDefaults: { introAssetId: dflt, outroAssetId: dflt } });
  });
  after(async () => {
    await p.query(`delete from "user" where id = any($1)`, [[me.userId, other.userId]]);
    await p.end();
  });

  it("snapshots the defaults when the keys are absent", async () => {
    const s = await resolveProjectSettings(db, me.userId, {});
    assert.equal(s.introAssetId, dflt);
    assert.equal(s.outroAssetId, dflt);
  });
  it("honours an explicit null as none, and drops its seconds", async () => {
    const s = await resolveProjectSettings(db, me.userId, { introAssetId: null, introSec: 4 });
    assert.equal(s.introAssetId, null);
    assert.equal(s.introSec, undefined);
    assert.equal(s.outroAssetId, dflt);
  });
  it("uses an explicit id with its seconds", async () => {
    const s = await resolveProjectSettings(db, me.userId, { outroAssetId: picked, outroSec: 2.5 });
    assert.equal(s.outroAssetId, picked);
    assert.equal(s.outroSec, 2.5);
  });
  it("rejects another user's or a removed asset when the caller names it", async () => {
    await assert.rejects(() => resolveProjectSettings(db, me.userId, { introAssetId: foreign }), /not in your library/);
    await assert.rejects(() => resolveProjectSettings(db, me.userId, { outroAssetId: removed, outroSec: 2 }), /not in your library/);
  });
});
