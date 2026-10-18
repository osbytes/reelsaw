/**
 * Concurrent renders share one face detector and one text detector (`svc.faces`, `svc.text`). Sampling
 * two different ranges at the same time must give exactly the samples a sequential run gives: faces,
 * divider probe and text boxes. (A detector that reused one input tensor across calls mixed frames
 * between clips: wrong faces and empty text boxes under load.)
 * Needs the host models (FACE_MODEL_PATH / TEXT_MODEL_PATH from the repo .env), ffmpeg, and the cached
 * fixture media `eval/.cache/media/budgeting-116-158.v2.mp4` (run `pnpm eval framing` once); skips otherwise.
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { dotenv } from "./helpers.js";
import { sampleFaces } from "../src/pipeline/layout.js";
import { sampleClipText } from "../src/pipeline/overlays.js";
import { loadFaceDetector } from "../src/vision/faces.js";
import { loadTextDetector } from "../src/vision/text.js";

const env = { ...dotenv(), ...process.env };
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const media = path.join(repoRoot, "eval/.cache/media/budgeting-116-158.v2.mp4");
const ready = !!env.FACE_MODEL_PATH && !!env.TEXT_MODEL_PATH && fs.existsSync(env.FACE_MODEL_PATH) && fs.existsSync(env.TEXT_MODEL_PATH) && fs.existsSync(media);

describe("sampling under concurrency", { skip: ready ? false : "needs the host models and the cached framing media" }, () => {
  it("two clips sampled at once equal the same clips sampled one after the other", async () => {
    const face = await loadFaceDetector(env.FACE_MODEL_PATH!);
    const text = await loadTextDetector(env.TEXT_MODEL_PATH!);
    try {
      // 0-6 s: the title card with the speaker at the right (text on the left); 14-20 s: speaker centred, no card
      const ranges: Array<[number, number]> = [[0, 6], [14, 20]];
      const one = async ([from, to]: [number, number]) => {
        const faces = await sampleFaces(face, { ffmpegPath: "ffmpeg", source: media, startSec: from, durationSec: to - from, sampleFps: 4 });
        const frames = await sampleClipText({ detector: text, ffmpegPath: "ffmpeg" }, media, from, to - from, 2);
        return { faces, frames };
      };
      const sequential = [];
      for (const r of ranges) sequential.push(await one(r));
      const parallel = await Promise.all(ranges.map(one));
      for (let k = 0; k < ranges.length; k++) {
        const a = sequential[k]!;
        const b = parallel[k]!;
        assert.equal(b.faces.length, a.faces.length);
        assert.equal(b.frames.length, a.frames.length);
        b.faces.forEach((s, i) => {
          const x = a.faces[i]!;
          assert.equal(s.boxes.length, x.boxes.length, `faces at ${s.t}`);
          if (s.box && x.box) assert.ok(Math.abs(s.box.x1 - x.box.x1) < 1e-4, `face x at ${s.t}: ${s.box.x1} vs ${x.box.x1}`);
          assert.deepEqual(s.divider, x.divider, `divider at ${s.t}`);
        });
        b.frames.forEach((f, i) => assert.equal(f.all.length, a.frames[i]!.all.length, `text boxes at ${f.t}`));
      }
      // sanity: the card clip does have text, the centred clip does not
      assert.ok(sequential[0]!.frames.some((f) => f.all.length > 0));
    } finally {
      await face.release();
      await text.release();
    }
  });
});
