/**
 * A source whose only picture is a still (an audio file's cover art, a video track of one frame) rendered clips with
 * sound alone: the clip's seek lands past the frame, ffmpeg drops the empty video stream, and the thumbnail of the
 * result fails on every retry. Ingest now makes such a source a real video once (stillVideoArgs).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeInfo } from "../src/media.js";
import { stillVideoArgs } from "../src/pipeline/ingest.js";

describe("probeInfo", () => {
  const audio = { codec_type: "audio" };
  it("cover art is a still", () => {
    const p = probeInfo({
      format: { duration: "60" },
      streams: [audio, { codec_type: "video", width: 640, height: 640, disposition: { attached_pic: 1 } }],
    });
    assert.equal(p.still, true);
    assert.equal(p.width, 640);
  });
  it("a video track of one frame is a still", () => {
    assert.equal(probeInfo({ streams: [audio, { codec_type: "video", width: 1080, height: 1920, nb_frames: "1" }] }).still, true);
  });
  it("a real video wins over cover art listed before it", () => {
    const p = probeInfo({
      streams: [
        { codec_type: "video", width: 300, height: 300, disposition: { attached_pic: 1 } },
        { codec_type: "video", width: 1920, height: 1080, nb_frames: "1800", r_frame_rate: "30/1" },
        audio,
      ],
    });
    assert.equal(p.still, undefined);
    assert.equal(p.width, 1920);
    assert.equal(p.fps, 30);
  });
  it("sound alone has no width and is not a still", () => {
    const p = probeInfo({ streams: [audio] });
    assert.equal(p.width, undefined);
    assert.equal(p.still, undefined);
  });
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const probe = (file: string) =>
  probeInfo(JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { encoding: "utf8" })));
const ffmpeg = (args: string[]) => execFileSync("ffmpeg", ["-v", "error", ...args], { stdio: ["ignore", "ignore", "pipe"] });
// what a clip's render and thumbnail do, reduced: seek into the source, encode the picture and sound, then take a still
const clipAndThumbnail = (src: string, dir: string) => {
  const clip = path.join(dir, "clip.mp4");
  ffmpeg([
    "-y",
    "-ss",
    "10",
    "-t",
    "20",
    "-i",
    src,
    "-filter_complex",
    "[0:v]scale=540:960,setsar=1[v]",
    "-map",
    "[v]",
    "-map",
    "0:a",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-c:a",
    "aac",
    clip,
  ]);
  ffmpeg(["-y", "-ss", "6.70", "-i", clip, "-frames:v", "1", "-vf", "scale=270:-2", path.join(dir, "thumb.jpg")]);
  return clip;
};

describe("stillVideoArgs", { skip: hasFfmpeg ? false : "ffmpeg not on PATH" }, () => {
  it("a cover-art audio file becomes a video whose clips keep their picture", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reelsaw-still-"));
    try {
      const cover = path.join(dir, "cover.png");
      const src = path.join(dir, "source.m4a");
      ffmpeg(["-y", "-f", "lavfi", "-i", "color=red:s=640x640:d=1", "-frames:v", "1", cover]);
      ffmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=f=440:d=60",
        "-i",
        cover,
        "-map",
        "0:a",
        "-map",
        "1:v",
        "-c:a",
        "aac",
        "-c:v",
        "mjpeg",
        "-disposition:v",
        "attached_pic",
        src,
      ]);
      const before = probe(src);
      assert.equal(before.still, true);
      // the failure: the clip has no picture, and its thumbnail cannot be taken
      assert.throws(() => clipAndThumbnail(src, dir));

      const picture = path.join(dir, "still.png");
      const out = path.join(dir, "source.mp4");
      ffmpeg(["-y", "-i", src, "-map", "0:v:0", "-frames:v", "1", picture]);
      ffmpeg(stillVideoArgs(picture, src, before.durationSec, out));
      const after = probe(out);
      assert.equal(after.still, undefined);
      assert.equal(after.width, 640);
      assert.equal(after.hasAudio, true);
      assert.ok(Math.abs(after.durationSec - before.durationSec) < 0.2, `length kept: ${before.durationSec} → ${after.durationSec}`);

      const clip = clipAndThumbnail(out, dir);
      const rendered = probe(clip);
      assert.equal(rendered.width, 540);
      assert.ok(fs.statSync(path.join(dir, "thumb.jpg")).size > 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
