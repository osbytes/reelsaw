/**
 * A rendered clip whose video track ends before the thumbnail's seek point (a third of the way into the body) failed on
 * every retry: ffmpeg 5.1 exits 0 and writes no file, newer ffmpeg fails with "Nothing was written", and the upload of
 * the missing .jpg threw ENOENT though the clip itself was rendered. The thumbnail now falls back to an earlier frame.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NonRetryableError } from "../src/pipeline/common.js";
import { takeThumbnail, type RunFfmpeg } from "../src/pipeline/thumbnail.js";

const quietLog = () => {
  const warned: unknown[] = [];
  return { warned, log: { warn: (obj: unknown) => warned.push(obj) } as never };
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-thumb-"));
const seekOf = (args: string[]) => (args[0] === "-ss" ? Number(args[1]) : 0);

describe("takeThumbnail (stubbed ffmpeg)", () => {
  // ffmpeg 5.1's behaviour: a seek past the video's end succeeds and writes nothing
  const videoEndsAt =
    (endSec: number): RunFfmpeg =>
    async (args) => {
      if (seekOf(args) < endSec) fs.writeFileSync(String(args.at(-1)), "jpg");
    };

  it("takes the still a third of the way in when the video reaches it", async () => {
    const dir = tmp();
    const { log, warned } = quietLog();
    const seeks: number[] = [];
    const run: RunFfmpeg = async (args) => {
      seeks.push(seekOf(args));
      await videoEndsAt(30)(args);
    };
    await takeThumbnail(run, { input: "in.mp4", output: path.join(dir, "t.jpg"), atSec: 8.4, bodyStartSec: 2, log });
    assert.deepEqual(seeks, [8.4]);
    assert.equal(warned.length, 0);
  });

  it("falls back to the body's first frame when the seek lands past the video", async () => {
    const dir = tmp();
    const { log, warned } = quietLog();
    const out = path.join(dir, "t.jpg");
    await takeThumbnail(videoEndsAt(5), { input: "in.mp4", output: out, atSec: 8.4, bodyStartSec: 2, log });
    assert.ok(fs.statSync(out).size > 0);
    assert.equal(warned.length, 1);
  });

  it("falls back to the file's first frame when the video ends before the body starts", async () => {
    const dir = tmp();
    const { log } = quietLog();
    const out = path.join(dir, "t.jpg");
    await takeThumbnail(videoEndsAt(1), { input: "in.mp4", output: out, atSec: 8.4, bodyStartSec: 2, log });
    assert.ok(fs.statSync(out).size > 0);
  });

  it("a clip with no picture fails at once, not on every retry", async () => {
    const dir = tmp();
    const { log } = quietLog();
    await assert.rejects(
      takeThumbnail(
        async () => {
          throw new Error("Output file does not contain any stream");
        },
        { input: "in.mp4", output: path.join(dir, "t.jpg"), atSec: 8.4, bodyStartSec: 0, log },
      ),
      (err) => err instanceof NonRetryableError && /no picture/.test(err.message) && /does not contain any stream/.test(err.message),
    );
  });

  it("a cancelled job stops instead of trying the next frame", async () => {
    const dir = tmp();
    const { log } = quietLog();
    const ac = new AbortController();
    let calls = 0;
    const run: RunFfmpeg = async () => {
      calls++;
      ac.abort();
      throw new Error("aborted");
    };
    await assert.rejects(
      takeThumbnail(run, { input: "in.mp4", output: path.join(dir, "t.jpg"), atSec: 8.4, bodyStartSec: 2, signal: ac.signal, log }),
      /aborted/,
    );
    assert.equal(calls, 1);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const ffmpegCli: RunFfmpeg = async (args) => {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
};

describe("takeThumbnail (ffmpeg)", { skip: hasFfmpeg ? false : "ffmpeg not on PATH" }, () => {
  it("a clip whose picture ends before its sound still gets a thumbnail", async () => {
    const dir = tmp();
    try {
      const clip = path.join(dir, "clip.mp4");
      // 3 s of picture, 20 s of sound: the old seek (a third of 20 s) lands past the last frame
      execFileSync(
        "ffmpeg",
        ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=d=3:s=320x240:r=30", "-f", "lavfi", "-i", "sine=f=440:d=20"].concat([
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          clip,
        ]),
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      const out = path.join(dir, "thumb.jpg");
      const { log, warned } = quietLog();
      await takeThumbnail(ffmpegCli, { input: clip, output: out, atSec: 20 / 3, bodyStartSec: 0, log });
      assert.ok(fs.statSync(out).size > 0);
      assert.equal(warned.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
