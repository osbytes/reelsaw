/**
 * Pure units of the storage cleanup: which scratch paths a sweep removes given a listing and a
 * view of the database, and how duplicate sources are measured. No stack needed:
 * node --import tsx --test test/sweep.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planSweep, parseClipFile, bumperPurgeable, BUMPER_PURGE_MS, SWEEP_GRACE_MS, HEAR_TMP_MAX_AGE_MS, type DbView, type ScratchProject } from "../src/storage/sweep.js";
import { chunk, mapLimit, keysetLoop, deadlineIn } from "../src/lib/batch.js";
import { duplicateSourceBytes, videoIdentity, youtubeId } from "../src/storage/usage.js";

const NOW = 1_800_000_000_000;
const OLD = NOW - 3 * SWEEP_GRACE_MS;
const FRESH = NOW - 60_000;
const f = (rel: string, mtimeMs = OLD, bytes = 100) => ({ rel, bytes, mtimeMs });

function view(over: Partial<DbView> = {}): DbView {
  return {
    projects: new Map([["p1", { busy: false }]]),
    clips: new Map([["c1", { projectId: "p1", renderGen: 2, referenced: new Set(["c1.2.mp4", "c1.2.jpg"]) }]]),
    ...over,
  };
}
const plan = (projects: ScratchProject[], db = view(), tmp: Array<{ name: string; bytes: number; mtimeMs: number }> = []) => planSweep({ projects, tmp, db, now: NOW });

describe("parseClipFile", () => {
  it("reads clip id and generation, gen 0 has no number", () => {
    assert.deepEqual(parseClipFile("clips/abc.mp4"), { clipId: "abc", gen: 0, name: "abc.mp4" });
    assert.deepEqual(parseClipFile("clips/abc.12.jpg"), { clipId: "abc", gen: 12, name: "abc.12.jpg" });
  });
  it("ignores subtitle files, temp renders and other directories", () => {
    for (const rel of ["clips/abc.ass", "clips/abc.2.mp4.tmp.mp4", "source.mp4", "chunks/abc.mp4", "clips/x/abc.mp4"]) assert.equal(parseClipFile(rel), null, rel);
  });
});

describe("planSweep", () => {
  it("removes older generations and keeps the current one", () => {
    const r = plan([{ id: "p1", files: [f("clips/c1.mp4"), f("clips/c1.1.mp4"), f("clips/c1.1.jpg"), f("clips/c1.2.mp4"), f("clips/c1.2.jpg")] }]);
    assert.deepEqual(r.map((x) => x.path).sort(), ["projects/p1/clips/c1.1.jpg", "projects/p1/clips/c1.1.mp4", "projects/p1/clips/c1.mp4"]);
    assert.ok(r.every((x) => x.kind === "stale-generation" && x.storageKeys?.length === 1));
    assert.equal(r.find((x) => x.path.endsWith("c1.1.jpg"))!.storageKeys![0], "projects/p1/clips/c1.1.jpg");
  });
  it("never removes a generation newer than the row knows, or one the row still names", () => {
    const db = view({ clips: new Map([["c1", { projectId: "p1", renderGen: 1, referenced: new Set(["c1.mp4"]) }]]) });
    const r = plan([{ id: "p1", files: [f("clips/c1.mp4"), f("clips/c1.1.mp4"), f("clips/c1.2.mp4")] }], db);
    assert.deepEqual(r, []);
  });
  it("leaves fresh files alone", () => {
    assert.deepEqual(plan([{ id: "p1", files: [f("clips/c1.1.mp4", FRESH)] }]), []);
  });
  it("skips a project with a live job or an unfinished status", () => {
    const db = view({ projects: new Map([["p1", { busy: true }]]) });
    assert.deepEqual(plan([{ id: "p1", files: [f("clips/c1.1.mp4"), f("clips/gone.mp4")] }], db), []);
  });
  it("removes files of clips that no longer exist or belong to another project", () => {
    const db = view({ clips: new Map([["c1", { projectId: "other", renderGen: 0, referenced: new Set() }]]) });
    const r = plan([{ id: "p1", files: [f("clips/gone.3.mp4"), f("clips/c1.mp4")] }], db);
    assert.deepEqual(r.map((x) => [x.kind, x.clipId]), [["clip-gone", "gone"], ["clip-gone", "c1"]]);
  });
  it("removes the whole directory of a project that no longer exists, sized, once nothing is fresh", () => {
    const r = plan([{ id: "dead", files: [f("source.mp4", OLD, 1000), f("clips/c9.mp4", OLD, 50)] }]);
    assert.deepEqual(r, [{ kind: "project-gone", path: "projects/dead", bytes: 1050, projectId: "dead" }]);
    assert.deepEqual(plan([{ id: "dead", files: [f("source.mp4"), f("clips/c9.mp4", FRESH)] }]), []);
  });
  it("never touches non-clip files of a live project (source, audio, subtitles)", () => {
    assert.deepEqual(plan([{ id: "p1", files: [f("source.mp4"), f("audio.mp3"), f("clips/c1.ass"), f("chunks/0.mp3")] }]), []);
  });
  it("removes hear-* scratch older than a day and nothing else in tmp", () => {
    const tmp = [
      { name: "hear-a.mp4", bytes: 5, mtimeMs: NOW - HEAR_TMP_MAX_AGE_MS - 1 },
      { name: "hear-b.mp4", bytes: 5, mtimeMs: NOW - 1000 },
      { name: "export-x.zip", bytes: 5, mtimeMs: 0 },
    ];
    assert.deepEqual(plan([], view(), tmp).map((x) => x.path), ["tmp/hear-a.mp4"]);
  });
});

describe("duplicate sources", () => {
  it("finds the YouTube id across URL shapes", () => {
    for (const u of ["https://www.youtube.com/watch?v=nCpr5SBD8CQ&t=3", "https://youtu.be/nCpr5SBD8CQ?si=x", "https://m.youtube.com/shorts/nCpr5SBD8CQ"]) assert.equal(youtubeId(u), "nCpr5SBD8CQ", u);
    assert.equal(youtubeId("https://example.com/v.mp4"), null);
    assert.equal(youtubeId("not a url"), null);
    assert.equal(videoIdentity("https://example.com/v.mp4"), "url:https://example.com/v.mp4");
    assert.equal(videoIdentity(null), null);
  });
  it("counts every copy beyond the largest of each video", () => {
    const r = duplicateSourceBytes([
      { identity: "youtube:a", bytes: 144 },
      { identity: "youtube:a", bytes: 144 },
      { identity: "youtube:a", bytes: 144 },
      { identity: "youtube:b", bytes: 96 },
      { identity: "youtube:b", bytes: 95 },
      { identity: "youtube:c", bytes: 500 },
      { identity: null, bytes: 70 },
      { identity: null, bytes: 70 },
    ]);
    assert.deepEqual(r, { bytes: 288 + 95, groups: 2 });
  });
});

describe("bumperPurgeable", () => {
  const gone = (days: number) => ({ deletedAt: new Date(NOW - days * 24 * 3600_000) });
  it("purges an unreferenced asset removed over 30 days ago", () => {
    assert.ok(bumperPurgeable(gone(31), false, NOW));
  });
  it("keeps recent removals, live assets and anything still referenced", () => {
    assert.ok(!bumperPurgeable(gone(29), false, NOW));
    assert.ok(!bumperPurgeable({ deletedAt: new Date(NOW - BUMPER_PURGE_MS) }, false, NOW), "exactly 30 days is not yet over");
    assert.ok(!bumperPurgeable({ deletedAt: null }, false, NOW));
    assert.ok(!bumperPurgeable(gone(400), true, NOW));
  });
});

describe("planSweep with a partial listing", () => {
  it("never removes a whole directory from a listing that was cut short, but still judges single files", () => {
    const gone: ScratchProject = { id: "p9", files: [f("source.mp4"), f("clips/x.1.mp4")], partial: true };
    assert.deepEqual(plan([gone]), []);
    assert.equal(plan([{ ...gone, partial: false }]).length, 1);
    const known = plan([{ id: "p1", files: [f("clips/c1.1.mp4")], partial: true }]);
    assert.equal(known.length, 1); // a stale generation is stale whatever else is unlisted
  });
});

describe("chunk / mapLimit / keysetLoop", () => {
  it("chunks 2,500 ids into 1,000 / 1,000 / 500", () => {
    const sizes = chunk(Array.from({ length: 2500 }, (_, i) => i), 1000).map((c) => c.length);
    assert.deepEqual(sizes, [1000, 1000, 500]);
    assert.deepEqual(chunk([], 1000), []);
  });
  it("mapLimit never runs more than the limit at once and keeps order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit(Array.from({ length: 100 }, (_, i) => i), 16, async (i) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return i * 2;
    });
    assert.ok(peak <= 16 && peak > 1, `peak ${peak}`);
    assert.deepEqual(out.slice(0, 3), [0, 2, 4]);
  });
  it("keysetLoop walks batches until a short one", async () => {
    const all = Array.from({ length: 450 }, (_, i) => i + 1);
    const seen: number[] = [];
    const r = await keysetLoop<number, number>({
      size: 200,
      start: null,
      fetch: async (c, n) => all.filter((x) => x > (c ?? 0)).slice(0, n),
      cursorOf: (x) => x,
      handle: async (rows) => void seen.push(rows.length),
    });
    assert.deepEqual(seen, [200, 200, 50]);
    assert.equal(r.complete, true);
    assert.equal(r.cursor, 450);
  });
  it("keysetLoop stops at the deadline and returns the cursor to resume from", async () => {
    const r = await keysetLoop<number, number>({
      size: 10,
      deadline: deadlineIn(1),
      start: 5,
      fetch: async (c, n) => {
        await new Promise((res) => setTimeout(res, 5));
        return Array.from({ length: n }, (_, i) => (c ?? 0) + i + 1);
      },
      cursorOf: (x) => x,
      handle: async () => {},
    });
    assert.equal(r.complete, false);
    assert.equal(r.cursor, 15); // one batch ran, then the budget was gone
  });
  it("rows the query already excluded (still referenced) cannot use up a batch: the loop reaches those behind them", async () => {
    const purgeable = Array.from({ length: 450 }, (_, i) => 1000 + i);
    const seen: number[] = [];
    await keysetLoop<number, number>({ size: 200, start: null, fetch: async (c, n) => purgeable.filter((x) => x > (c ?? -1)).slice(0, n), cursorOf: (x) => x, handle: async (r) => void seen.push(...r) });
    assert.equal(seen.length, 450);
  });
});
