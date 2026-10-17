/**
 * Intro/outro joining on a generated fixture: normalise each bumper once, concat it around a body in
 * one encode, then check length, streams and packet timestamps with ffprobe.
 * Needs ffmpeg and ffprobe on the PATH, not the stack (skipped without them).
 * Run: node --import tsx --test test/bumpers.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bumperConcat, bumperFrames, bumperProblem, ensureNormalised, BUMPER_FPS, type NormaliseDeps } from "../src/pipeline/bumpers.js";
import { FIT_CHAIN } from "../src/pipeline/render.js";

const run = promisify(execFile);
const have = (bin: string) => {
  try {
    execFileSync(bin, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const available = have("ffmpeg") && have("ffprobe");
const FRAME = 1 / BUMPER_FPS;
const canvas = { width: 1080, height: 1920, fitChain: FIT_CHAIN(1080, 1920) };

const ffmpeg = (args: string[]) => run("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", ...args]);
async function probe(file: string) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file]);
  return JSON.parse(stdout) as { format: { duration: string }; streams: Array<{ codec_type: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number }> };
}
async function packets(file: string, stream: "v" | "a") {
  const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", `${stream}:0`, "-show_entries", "packet=pts_time,dts_time,duration_time", "-of", "json", file]);
  return (JSON.parse(stdout) as { packets: Array<{ pts_time: string; dts_time: string; duration_time: string }> }).packets;
}

describe("bumpers", { skip: !available && "ffmpeg/ffprobe not installed" }, () => {
  let dir: string;
  const store = new Map<string, string>();
  let deps: NormaliseDeps;
  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bumpers-test-"));
    // in-memory "storage": keys map to files under dir/store
    deps = {
      ffmpeg: (args, o) => ffmpeg(args).then(() => o),
      dir: path.join(dir, "cache"),
      storage: {
        exists: async (k) => store.has(k),
        ensureLocal: async (k, to) => {
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.copyFile(store.get(k)!, to);
          return to;
        },
        putFile: async (k, from) => {
          const dest = path.join(dir, "store", k.replace(/\//g, "_"));
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(from, dest);
          store.set(k, dest);
        },
      },
    };
    // 2 s landscape bumper with sound, 1.5 s square bumper with no audio, 5 s vertical body (mono 44.1 kHz)
    await ffmpeg(["-f", "lavfi", "-i", "testsrc=size=640x360:rate=24:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "intro.mp4")]);
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=480x480:rate=25:duration=1.5", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", path.join(dir, "outro.mp4")]);
    await ffmpeg(["-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=30:duration=5", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100:duration=5", "-ac", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "body.mp4")]);
    store.set("bumpers/intro/source.mp4", path.join(dir, "intro.mp4"));
    store.set("bumpers/outro/source.mp4", path.join(dir, "outro.mp4"));
  });
  after(() => fs.rm(dir, { recursive: true, force: true }));

  it("normalises a bumper to the canvas once and reuses it", async () => {
    const a = await ensureNormalised(deps, { id: "intro", sourceKey: "bumpers/intro/source.mp4", durationSec: 2, hasAudio: true }, canvas);
    const info = await probe(a);
    const v = info.streams.find((s) => s.codec_type === "video")!;
    assert.deepEqual([v.width, v.height, v.r_frame_rate], [1080, 1920, "30/1"]);
    const au = info.streams.find((s) => s.codec_type === "audio")!;
    assert.deepEqual([au.sample_rate, au.channels], ["48000", 2]);
    assert.equal(info.streams.length, 2);
    assert.ok(Math.abs(Number(info.format.duration) - bumperFrames(2) * FRAME) < FRAME * 1.5, `duration ${info.format.duration}`);
    const before = (await fs.stat(a)).mtimeMs;
    assert.equal(await ensureNormalised(deps, { id: "intro", sourceKey: "bumpers/intro/source.mp4", durationSec: 2, hasAudio: true }, canvas), a);
    assert.equal((await fs.stat(a)).mtimeMs, before, "second call reuses the cached file");
    // a cold node (no local cache) takes it from storage instead of re-encoding
    await fs.rm(path.join(deps.dir, "intro"), { recursive: true });
    const again = await ensureNormalised(deps, { id: "intro", sourceKey: "bumpers/intro/source.mp4", durationSec: 2, hasAudio: true }, canvas);
    assert.ok((await fs.stat(again)).size > 0);
  });

  for (const [name, withIntro, withOutro] of [["intro + body + outro", true, true], ["intro only", true, false], ["outro only", false, true]] as const) {
    it(`joins ${name} in one encode: length, streams, seams`, async (t) => {
      const intro = withIntro ? await ensureNormalised(deps, { id: "intro", sourceKey: "bumpers/intro/source.mp4", durationSec: 2, hasAudio: true }, canvas) : undefined;
      // the silent outro exercises the generated-silence path
      const outro = withOutro ? await ensureNormalised(deps, { id: "outro", sourceKey: "bumpers/outro/source.mp4", durationSec: 1.5, hasAudio: false }, canvas) : undefined;
      const introSec = intro ? bumperFrames(2) * FRAME : 0;
      const outroSec = outro ? bumperFrames(1.5) * FRAME : 0;
      const bodySec = 5;
      const out = path.join(dir, `out-${name.replace(/\W+/g, "-")}.mp4`);
      const inputs = [...(intro ? ["-i", intro] : []), ...(outro ? ["-i", outro] : [])];
      const graph =
        `[0:v]null[bodyraw];[0:a:0]anull[ca];` +
        bumperConcat({ introInput: intro ? 1 : undefined, outroInput: outro ? (intro ? 2 : 1) : undefined, bodyVideo: "[bodyraw]", bodyAudio: "[ca]", bodySec });
      await ffmpeg(["-i", path.join(dir, "body.mp4"), ...inputs, "-filter_complex", graph, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", out]);

      const info = await probe(out);
      const expected = introSec + bodySec + outroSec;
      assert.ok(Math.abs(Number(info.format.duration) - expected) <= FRAME, `duration ${info.format.duration} vs ${expected}`);
      assert.equal(info.streams.filter((s) => s.codec_type === "video").length, 1);
      assert.equal(info.streams.filter((s) => s.codec_type === "audio").length, 1);
      assert.equal(info.streams.length, 2);

      // timestamps never go backwards, and no gap or overlap at the seams
      const vp = await packets(out, "v");
      const vDts = vp.map((p) => Number(p.dts_time));
      assert.ok(vDts.every((t, i) => i === 0 || t > vDts[i - 1]!), "video dts strictly increasing");
      const vPts = vp.map((p) => Number(p.pts_time)).sort((a, b) => a - b);
      const maxVideoGap = Math.max(...vPts.slice(1).map((t, i) => t - vPts[i]!));
      assert.ok(maxVideoGap < FRAME * 1.5, `video frame gap ${maxVideoGap}`);
      const ap = (await packets(out, "a")).map((p) => Number(p.pts_time));
      assert.ok(ap.every((t, i) => i === 0 || t > ap[i - 1]!), "audio pts strictly increasing");
      const maxAudioGap = Math.max(...ap.slice(1).map((t, i) => t - ap[i]!));
      assert.ok(maxAudioGap < 0.03, `audio packet gap ${maxAudioGap}`); // AAC frames are 21.3 ms
      // audio ends with the picture (within one AAC frame)
      t.diagnostic(`duration ${info.format.duration} (expected ${expected.toFixed(4)}); video ${vp.length} packets, max gap ${maxVideoGap.toFixed(4)} s; audio ${ap.length} packets, max gap ${maxAudioGap.toFixed(4)} s; audio ends ${ap[ap.length - 1]}`);
      assert.ok(Math.abs(ap[ap.length - 1]! - (expected - 0.0213)) < 0.05, `audio ends ${ap[ap.length - 1]} vs ${expected}`);
    });
  }

  it("refuses unusable files with a sentence", () => {
    const ok = { durationSec: 4, width: 1280, height: 720 };
    assert.equal(bumperProblem("intro", { ext: ".mp4", sizeBytes: 1e6 }, ok), null);
    assert.equal(bumperProblem("intro", { ext: ".mp4", sizeBytes: 1e6 }, { ...ok, durationSec: 14 }), "This video is 14 s long. Intros can be at most 10 s.");
    assert.match(bumperProblem("outro", { ext: ".mp4", sizeBytes: 60 * 1024 * 1024 }, ok)!, /Outros can be at most 50 MB/);
    assert.match(bumperProblem("intro", { ext: ".gif", sizeBytes: 1e5 }, ok)!, /MP4, MOV or WebM/);
    assert.match(bumperProblem("intro", { ext: ".mp4", sizeBytes: 1e5 }, { durationSec: 3 })!, /no video/);
  });
});
