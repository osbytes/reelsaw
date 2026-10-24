/**
 * media.detectScenes over a range: a render asks for one clip's shot changes on the clip's own clock when
 * the project never ran the scenes refine step. A synthetic two-colour video has exactly one hard cut.
 * Needs ffmpeg on PATH (skipped otherwise). Run: node --import tsx --test test/scene-range.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createMediaTools } from "../src/media.js";
import { createLogger } from "../src/log.js";
import type { Config } from "../src/config.js";

const ffmpeg = "ffmpeg";
const haveFfmpeg = spawnSync(ffmpeg, ["-version"], { stdio: "ignore" }).status === 0;

describe("detectScenes with a range", { skip: haveFfmpeg ? false : "ffmpeg not on PATH" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-scenes-"));
  const file = path.join(dir, "two-shots.mp4");
  // 3 s of red, then 3 s of blue: one cut at 3.0 s
  const made = spawnSync(
    ffmpeg,
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x240:r=10:d=3", "-f", "lavfi", "-i", "color=c=blue:s=320x240:r=10:d=3", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0", "-c:v", "libx264", "-pix_fmt", "yuv420p", file],
    { stdio: "inherit" },
  );
  assert.equal(made.status, 0, "ffmpeg could not make the fixture");
  const media = createMediaTools({ FFMPEG_PATH: ffmpeg, FFPROBE_PATH: "ffprobe", YTDLP_PATH: "yt-dlp", FFMPEG_ENCODER: "auto" } as Config, createLogger({ LOG_LEVEL: "error", LOG_FORMAT: "json" }));
  const near = (xs: number[], want: number) => xs.some((x) => Math.abs(x - want) <= 0.15);

  it("finds the cut on the whole file", async () => {
    const cuts = await media.detectScenes(file);
    assert.equal(cuts.length, 1, `cuts ${cuts.join(",")}`);
    assert.ok(near(cuts, 3), `cut at ${cuts[0]}, expected 3.0`);
  });

  it("reports a range's cuts relative to the range start", async () => {
    const cuts = await media.detectScenes(file, undefined, undefined, { start: 2, duration: 3 });
    assert.equal(cuts.length, 1, `cuts ${cuts.join(",")}`);
    assert.ok(near(cuts, 1), `cut at ${cuts[0]}, expected 1.0 (3.0 on the file's clock)`);
  });

  it("finds nothing in a range without a cut", async () => {
    assert.deepEqual(await media.detectScenes(file, undefined, undefined, { start: 3.5, duration: 2 }), []);
  });
});
