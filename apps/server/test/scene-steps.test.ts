/**
 * Scene cuts as durable steps: detectScenes answers [] only when the detector ran and found nothing (an ffmpeg failure
 * throws, so it is never stored as "no cuts"), and a text-scan abort after the cuts were saved resumes with the cuts step
 * reused. Stack-free: ffmpeg is a stub script, the step table is in memory.
 * Run: node --import tsx --test test/scene-steps.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { createMediaTools } from "../src/media.js";
import { StageTimeoutError, StaleJobError } from "../src/pipeline/common.js";
import { StepRunner, type StepStore, type StepWrite, type StoredStep } from "../src/pipeline/steps.js";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, trace() {}, child() { return quiet; } } as never;

function mediaWith(ffmpegPath: string) {
  return createMediaTools({ FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: "ffprobe", YTDLP_PATH: "yt-dlp", FFMPEG_ENCODER: "auto" } as Config, createLogger({ LOG_LEVEL: "error", LOG_FORMAT: "json" }));
}

function stub(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe("detectScenes failure handling", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-scene-stub-"));

  it("throws when ffmpeg exits with an error, instead of answering no cuts", async () => {
    const media = mediaWith(stub(dir, "ffmpeg-fail", "echo 'moov atom not found' >&2\nexit 1"));
    await assert.rejects(media.detectScenes("/nope.mp4"), /Shot-change detection failed/);
  });

  it("throws when ffmpeg cannot be started", async () => {
    const media = mediaWith(path.join(dir, "does-not-exist"));
    await assert.rejects(media.detectScenes("/nope.mp4"), /Shot-change detection failed/);
  });

  it("answers [] when the detector ran cleanly and found no cut", async () => {
    const media = mediaWith(stub(dir, "ffmpeg-empty", "exit 0"));
    assert.deepEqual(await media.detectScenes("/still.mp4"), []);
  });

  it("rethrows the abort of a stopped job", async () => {
    const media = mediaWith(stub(dir, "ffmpeg-slow", "sleep 5"));
    const ctl = new AbortController();
    const p = media.detectScenes("/slow.mp4", undefined, ctl.signal);
    setTimeout(() => ctl.abort(new Error("job cancelled")), 50);
    await assert.rejects(p, /cancelled|abort/i);
  });
});

class MemoryStore implements StepStore {
  rows = new Map<string, StoredStep>();
  async read(name: string, key: string) {
    return this.rows.get(`${name}|${key}`);
  }
  async write(w: StepWrite) {
    this.rows.set(`${w.name}|${w.key}`, { status: w.status, output: w.output });
    return true;
  }
}

function attempt(store: StepStore) {
  const ctl = new AbortController();
  const r = new StepRunner({
    stage: "refine",
    store,
    signal: ctl.signal,
    log: quiet,
    progress: async () => {},
    idleMs: () => 0,
    timeoutError: (info) => new StageTimeoutError({ stage: "refine", ...info }),
    onIdle: (e) => ctl.abort(e),
    stale: () => new StaleJobError("p1", 1),
  });
  return { r, ctl };
}

describe("refine.scenes steps", () => {
  it("a text-scan abort after the cuts were saved resumes with the cuts step reused", async () => {
    const store = new MemoryStore();
    const saved: { cuts: number[] | null } = { cuts: null }; // transcripts.sceneCuts
    let detections = 0;
    let scans = 0;
    const keyOf = (cuts: number[]) => ({ cuts: { input: "source-key", model: "ffmpeg-scene", promptVersion: "scenes-1", params: { floor: 0.1, width: 320 } }, scan: { input: { source: "source-key", cuts }, model: "text-detector", promptVersion: "text-scan-1" } });

    const run = async (a: ReturnType<typeof attempt>, failScan: boolean) => {
      const cuts = z.number();
      await a.r.step("scene-cuts", keyOf([]).cuts, async () => {
        detections++;
        saved.cuts = [3, 9.5];
        return saved.cuts.length;
      }, { schema: cuts, timeoutMs: 1000 });
      const have = saved.cuts ?? [];
      return a.r.step("text-scan", keyOf(have).scan, async (signal) => {
        scans++;
        if (failScan) {
          a.ctl.abort(new Error("stage idle"));
          signal.throwIfAborted();
        }
        return { overlays: [] as number[] };
      }, { schema: z.object({ overlays: z.array(z.number()) }), timeoutMs: 1000 });
    };

    const first = attempt(store);
    await assert.rejects(run(first, true));
    assert.deepEqual(saved.cuts, [3, 9.5], "the cuts are saved although the scan was stopped");
    assert.equal(detections, 1);

    const second = attempt(store);
    assert.deepEqual(await run(second, false), { overlays: [] });
    assert.equal(detections, 1, "the cuts step was reused, not detected again");
    assert.equal(scans, 2);
    assert.equal(second.r.completed, 1, "only the text scan ran in the second attempt");
  });

  it("a failed cuts step is recorded failed, not done, so it runs again", async () => {
    const store = new MemoryStore();
    const a = attempt(store);
    await assert.rejects(a.r.step("scene-cuts", { input: "s", model: "m", promptVersion: "v" }, async () => { throw new Error("Shot-change detection failed: boom"); }, { schema: z.number(), timeoutMs: 1000 }));
    assert.ok([...store.rows.values()].every((r) => r.status === "failed"));
    let ran = 0;
    await attempt(store).r.step("scene-cuts", { input: "s", model: "m", promptVersion: "v" }, async () => (ran++, 0), { schema: z.number(), timeoutMs: 1000 });
    assert.equal(ran, 1);
  });
});

