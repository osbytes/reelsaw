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
import {
  bumperConcat,
  bumperFrames,
  resolveClipBumpers,
  bumperKind,
  assetKind,
  assetMime,
  ASSET_MIME,
  bumperProblem,
  ensureNormalised,
  ensureRaster,
  isSvgAsset,
  BUMPER_FPS,
  type NormaliseDeps,
} from "../src/pipeline/bumpers.js";
import { svgSize, svgHasExternalRefs, rasterizeSvg } from "../src/pipeline/raster.js";
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
  return JSON.parse(stdout) as {
    format: { duration: string };
    streams: Array<{ codec_type: string; width?: number; height?: number; r_frame_rate?: string; sample_rate?: string; channels?: number }>;
  };
}
async function packets(file: string, stream: "v" | "a") {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    `${stream}:0`,
    "-show_entries",
    "packet=pts_time,dts_time,duration_time",
    "-of",
    "json",
    file,
  ]);
  return (JSON.parse(stdout) as { packets: Array<{ pts_time: string; dts_time: string; duration_time: string }> }).packets;
}

describe("resolveClipBumpers", () => {
  const project = { introAssetId: "pi", outroAssetId: "po" };
  it("inherits the project when the clip has no choice", () => {
    for (const clip of [{}, { bumpers: null }, { bumpers: {} }])
      assert.deepEqual(resolveClipBumpers(project, clip), { introId: "pi", outroId: "po", fromClip: [] });
  });
  it("lets the clip pick a different asset, or none, per slot", () => {
    assert.deepEqual(resolveClipBumpers(project, { bumpers: { intro: "ci" } }), { introId: "ci", outroId: "po", fromClip: ["intro"] });
    assert.deepEqual(resolveClipBumpers(project, { bumpers: { outro: null } }), { introId: "pi", outroId: null, fromClip: ["outro"] });
    assert.deepEqual(resolveClipBumpers(project, { bumpers: { intro: null, outro: null } }), { introId: null, outroId: null, fromClip: ["intro", "outro"] });
  });
  it("resolves seconds: the clip's own for its own pick, else the project's, else left to the asset", () => {
    const p = { introAssetId: "pi", outroAssetId: "po", introSec: 5 };
    assert.deepEqual(resolveClipBumpers(p, {}), { introId: "pi", outroId: "po", introSec: 5, fromClip: [] });
    assert.deepEqual(
      resolveClipBumpers(p, { bumpers: { introSec: 2 } }),
      { introId: "pi", outroId: "po", introSec: 5, fromClip: [] },
      "seconds without a pick do not apply",
    );
    assert.deepEqual(resolveClipBumpers(p, { bumpers: { intro: "ci", introSec: 2, outroSec: 9 } }), {
      introId: "ci",
      outroId: "po",
      introSec: 2,
      fromClip: ["intro"],
    });
    assert.deepEqual(
      resolveClipBumpers(p, { bumpers: { intro: "ci" } }),
      { introId: "ci", outroId: "po", fromClip: ["intro"] },
      "a clip's own asset ignores the project's seconds",
    );
    assert.deepEqual(resolveClipBumpers(p, { bumpers: { intro: null, introSec: 4 } }), { introId: null, outroId: "po", fromClip: ["intro"] });
  });
  it("lets a clip add just one slot when the project has none, and treats project null/unset as none", () => {
    assert.deepEqual(resolveClipBumpers({ introAssetId: null }, { bumpers: { outro: "co" } }), { introId: null, outroId: "co", fromClip: ["outro"] });
    assert.deepEqual(resolveClipBumpers({}, {}), { introId: null, outroId: null, fromClip: [] });
  });
});

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
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=640x360:rate=24:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=44100:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      path.join(dir, "intro.mp4"),
    ]);
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=480x480:rate=25:duration=1.5",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      path.join(dir, "outro.mp4"),
    ]);
    await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=1080x1920:rate=30:duration=5",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=220:sample_rate=44100:duration=5",
      "-ac",
      "1",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      path.join(dir, "body.mp4"),
    ]);
    store.set("bumpers/intro/source.mp4", path.join(dir, "intro.mp4"));
    store.set("bumpers/outro/source.mp4", path.join(dir, "outro.mp4"));
    // a 600x400 PNG logo card (not 9:16, so it gets the blurred fit)
    await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=600x400:rate=1", "-frames:v", "1", path.join(dir, "card.png")]);
    store.set("bumpers/card/source.png", path.join(dir, "card.png"));
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

  for (const [name, withIntro, withOutro] of [
    ["intro + body + outro", true, true],
    ["intro only", true, false],
    ["outro only", false, true],
  ] as const) {
    it(`joins ${name} in one encode: length, streams, seams`, async (t) => {
      const intro = withIntro
        ? await ensureNormalised(deps, { id: "intro", sourceKey: "bumpers/intro/source.mp4", durationSec: 2, hasAudio: true }, canvas)
        : undefined;
      // the silent outro exercises the generated-silence path
      const outro = withOutro
        ? await ensureNormalised(deps, { id: "outro", sourceKey: "bumpers/outro/source.mp4", durationSec: 1.5, hasAudio: false }, canvas)
        : undefined;
      const introSec = intro ? bumperFrames(2) * FRAME : 0;
      const outroSec = outro ? bumperFrames(1.5) * FRAME : 0;
      const bodySec = 5;
      const out = path.join(dir, `out-${name.replace(/\W+/g, "-")}.mp4`);
      const inputs = [...(intro ? ["-i", intro] : []), ...(outro ? ["-i", outro] : [])];
      const graph =
        `[0:v]null[bodyraw];[0:a:0]anull[ca];` +
        bumperConcat({
          introInput: intro ? 1 : undefined,
          outroInput: outro ? (intro ? 2 : 1) : undefined,
          bodyVideo: "[bodyraw]",
          bodyAudio: "[ca]",
          bodySec,
        });
      await ffmpeg([
        "-i",
        path.join(dir, "body.mp4"),
        ...inputs,
        "-filter_complex",
        graph,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "21",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        out,
      ]);

      const info = await probe(out);
      const expected = introSec + bodySec + outroSec;
      assert.ok(Math.abs(Number(info.format.duration) - expected) <= FRAME, `duration ${info.format.duration} vs ${expected}`);
      assert.equal(info.streams.filter((s) => s.codec_type === "video").length, 1);
      assert.equal(info.streams.filter((s) => s.codec_type === "audio").length, 1);
      assert.equal(info.streams.length, 2);

      // timestamps never go backwards, and no gap or overlap at the seams
      const vp = await packets(out, "v");
      const vDts = vp.map((p) => Number(p.dts_time));
      assert.ok(
        vDts.every((t, i) => i === 0 || t > vDts[i - 1]!),
        "video dts strictly increasing",
      );
      const vPts = vp.map((p) => Number(p.pts_time)).sort((a, b) => a - b);
      const maxVideoGap = Math.max(...vPts.slice(1).map((t, i) => t - vPts[i]!));
      assert.ok(maxVideoGap < FRAME * 1.5, `video frame gap ${maxVideoGap}`);
      const ap = (await packets(out, "a")).map((p) => Number(p.pts_time));
      assert.ok(
        ap.every((t, i) => i === 0 || t > ap[i - 1]!),
        "audio pts strictly increasing",
      );
      const maxAudioGap = Math.max(...ap.slice(1).map((t, i) => t - ap[i]!));
      assert.ok(maxAudioGap < 0.03, `audio packet gap ${maxAudioGap}`); // AAC frames are 21.3 ms
      // audio ends with the picture (within one AAC frame)
      t.diagnostic(
        `duration ${info.format.duration} (expected ${expected.toFixed(4)}); video ${vp.length} packets, max gap ${maxVideoGap.toFixed(4)} s; audio ${ap.length} packets, max gap ${maxAudioGap.toFixed(4)} s; audio ends ${ap[ap.length - 1]}`,
      );
      assert.ok(Math.abs(ap[ap.length - 1]! - (expected - 0.0213)) < 0.05, `audio ends ${ap[ap.length - 1]} vs ${expected}`);
    });
  }

  for (const seconds of [3, 1, 2.5]) {
    it(`turns an image into a ${seconds} s video with silence and joins it as an outro`, async (t) => {
      const asset = { id: `card-${seconds}`, sourceKey: "bumpers/card/source.png", durationSec: seconds, hasAudio: false, kind: "image" as const };
      const file = await ensureNormalised(deps, asset, canvas);
      const info = await probe(file);
      const v = info.streams.find((x) => x.codec_type === "video")!;
      assert.deepEqual([v.width, v.height, v.r_frame_rate], [1080, 1920, "30/1"]);
      assert.equal(info.streams.filter((x) => x.codec_type === "video").length, 1);
      assert.equal(info.streams.filter((x) => x.codec_type === "audio").length, 1);
      assert.ok(Math.abs(Number(info.format.duration) - seconds) <= FRAME, `duration ${info.format.duration} vs ${seconds}`);
      // joined after the body in one encode
      const out = path.join(dir, `img-${seconds}.mp4`);
      const graph = `[0:v]null[bodyraw];[0:a:0]anull[ca];` + bumperConcat({ outroInput: 1, bodyVideo: "[bodyraw]", bodyAudio: "[ca]", bodySec: 5 });
      await ffmpeg([
        "-i",
        path.join(dir, "body.mp4"),
        "-i",
        file,
        "-filter_complex",
        graph,
        "-map",
        "[v]",
        "-map",
        "[a]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        out,
      ]);
      const joined = await probe(out);
      t.diagnostic(`image ${seconds} s -> normalised ${info.format.duration}, joined ${joined.format.duration} (expected ${5 + seconds})`);
      assert.ok(Math.abs(Number(joined.format.duration) - (5 + seconds)) <= FRAME * 1.5, `joined ${joined.format.duration}`);
      assert.equal(joined.streams.length, 2);
    });
  }

  it("refuses unusable images with a sentence", () => {
    assert.equal(bumperProblem(undefined, { ext: ".png", sizeBytes: 1e6 }, { durationSec: 0, width: 1200, height: 800 }), null);
    assert.match(bumperProblem(undefined, { ext: ".png", sizeBytes: 21 * 1024 * 1024 }, { durationSec: 0, width: 1200, height: 800 })!, /at most 20 MB/);
    assert.match(bumperProblem(undefined, { ext: ".jpg", sizeBytes: 1e5 }, { durationSec: 0, width: 9000, height: 800 })!, /8192 px/);
    assert.match(bumperProblem(undefined, { ext: ".jpg", sizeBytes: 1e5 }, { durationSec: 0, width: 20, height: 800 })!, /at least 64 px/);
    assert.equal(bumperKind(".jpeg"), "image");
    assert.equal(bumperKind(".mov"), "video");
    assert.equal(bumperKind(".bmp"), null);
  });

  it("decides GIF and WebP from the probe: animated is a silent video, a still is an image", () => {
    assert.equal(assetKind(".gif", { durationSec: 1, frames: 10 }), "video");
    assert.equal(assetKind(".gif", { durationSec: 0.1, frames: 1 }), "image");
    assert.equal(assetKind(".gif", { durationSec: 0 }), "image");
    assert.equal(assetKind(".GIF", { durationSec: 2 }), "video");
    assert.equal(assetKind(".webp", { durationSec: 0, frames: 24 }), "video");
    assert.equal(assetKind(".webp", { durationSec: 0, frames: 1 }), "image");
    assert.equal(assetKind(".svg", { durationSec: 0 }), "image");
    assert.equal(assetKind(".svg", { durationSec: 5, frames: 3 }), "image");
    assert.equal(assetKind(".mp4", { durationSec: 0 }), "video");
    assert.equal(assetKind(".mp3", { durationSec: 0 }), "audio");
    assert.equal(assetKind(".bmp", { durationSec: 0 }), null);
  });

  it("accepts SVG, GIF and WebP with the limits of their kind", () => {
    assert.equal(bumperProblem(undefined, { ext: ".svg", sizeBytes: 5e4 }, { durationSec: 0, width: 512, height: 512 }), null);
    assert.equal(bumperProblem(undefined, { ext: ".webp", sizeBytes: 5e4 }, { durationSec: 0, width: 512, height: 512 }), null);
    assert.equal(bumperProblem(undefined, { ext: ".gif", sizeBytes: 5e4 }, { durationSec: 0.1, frames: 1, width: 300, height: 300 }), null);
    assert.equal(bumperProblem(undefined, { ext: ".gif", sizeBytes: 5e6 }, { durationSec: 2, frames: 40, width: 300, height: 300 }), null);
    assert.match(bumperProblem(undefined, { ext: ".gif", sizeBytes: 5e6 }, { durationSec: 14, frames: 400, width: 300, height: 300 })!, /at most 10 s/);
    assert.match(bumperProblem(undefined, { ext: ".svg", sizeBytes: 21 * 1024 * 1024 }, { durationSec: 0, width: 512, height: 512 })!, /at most 20 MB/);
    assert.match(bumperProblem(undefined, { ext: ".webp", sizeBytes: 5e4 }, { durationSec: 0, width: 0, height: 0 })!, /animated/);
  });

  it("stores the exact format of each accepted type", () => {
    assert.equal(ASSET_MIME[".svg"], "image/svg+xml");
    assert.equal(ASSET_MIME[".gif"], "image/gif");
    assert.equal(ASSET_MIME[".webp"], "image/webp");
    assert.equal(assetMime(".SVG"), "image/svg+xml");
    assert.equal(assetMime(".bmp"), null);
  });

  it("refuses unusable files with a sentence", () => {
    const ok = { durationSec: 4, width: 1280, height: 720 };
    assert.equal(bumperProblem("intro", { ext: ".mp4", sizeBytes: 1e6 }, ok), null);
    assert.equal(bumperProblem("intro", { ext: ".mp4", sizeBytes: 1e6 }, { ...ok, durationSec: 14 }), "This video is 14 s long. Intros can be at most 10 s.");
    assert.match(bumperProblem("outro", { ext: ".mp4", sizeBytes: 60 * 1024 * 1024 }, ok)!, /Outros can be at most 50 MB/);
    assert.match(bumperProblem("intro", { ext: ".bmp", sizeBytes: 1e5 }, ok)!, /MP4, MOV or WebM video; a PNG, JPG, WebP, GIF or SVG image/);
    assert.match(bumperProblem("intro", { ext: ".mp4", sizeBytes: 1e5 }, { durationSec: 3 })!, /no video/);
  });
});

describe("SVG assets (resvg)", () => {
  const logo = path.join(import.meta.dirname, "fixtures", "logo.svg");

  it("sizes an SVG from its viewBox, or its width and height", () => {
    assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100"/></svg>'), {
      width: 200,
      height: 100,
    });
    assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"/>'), { width: 40, height: 20 });
    assert.deepEqual(svgSize('<svg xmlns="http://www.w3.org/2000/svg"/>'), { width: 100, height: 100 }, "resvg's own default for an empty drawing");
    assert.equal(svgSize("not an svg"), null);
  });

  it("rasterises to a PNG of the requested width with the aspect kept", async () => {
    const png = rasterizeSvg(await fs.readFile(logo), 1080);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), 1080, "width");
    assert.equal(png.readUInt32BE(20), 540, "height");
  });

  it("refuses an SVG that links to other files, allows internal and embedded references", () => {
    assert.equal(svgHasExternalRefs('<svg><image href="file:///etc/passwd"/></svg>'), true);
    assert.equal(svgHasExternalRefs("<svg><use xlink:href='other.svg#a'/></svg>"), true);
    assert.equal(svgHasExternalRefs('<svg><use href="#a"/><image href="data:image/png;base64,AAAA"/></svg>'), false);
    assert.throws(
      () => rasterizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><image href="/etc/hosts"/></svg>', 100),
      /links to other files/,
    );
  });

  it("builds the raster once per width and reuses it", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "raster-"));
    try {
      const stored = new Map<string, string>();
      let puts = 0;
      const storage = {
        exists: async (k: string) => stored.has(k),
        ensureLocal: async (k: string, dest: string) => {
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.copyFile(stored.get(k) ?? logo, dest);
          return dest;
        },
        putFile: async (k: string, f: string) => {
          puts++;
          const copy = path.join(dir, `stored-${puts}.bin`);
          await fs.copyFile(f, copy);
          stored.set(k, copy);
        },
      };
      const asset = { id: "svg1", sourceKey: "assets/svg1/source.svg" };
      const a = await ensureRaster({ storage, dir: path.join(dir, "cache") }, asset, 1080);
      assert.ok(a.endsWith("raster.v1.1080.png"));
      assert.equal(await ensureRaster({ storage, dir: path.join(dir, "cache") }, asset, 1080), a);
      assert.equal(puts, 1, "stored once");
      // a fresh machine takes it from storage instead of rendering again
      const b = await ensureRaster({ storage, dir: path.join(dir, "cache2") }, asset, 1080);
      assert.equal(puts, 1);
      assert.equal((await fs.stat(b)).size, (await fs.stat(a)).size);
      assert.ok(
        isSvgAsset({ mime: "image/svg+xml", sourceKey: "x" }) &&
          isSvgAsset({ sourceKey: "a/source.svg" }) &&
          !isSvgAsset({ mime: "image/png", sourceKey: "a/source.svg" }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
