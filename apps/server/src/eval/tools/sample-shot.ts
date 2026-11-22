/**
 * Sample a stretch of a video the way a render does (faces, motion and text at 4 / 2 fps, scene cuts)
 * and print how it segments: for finding and labelling framing cases.
 *   tsx src/eval/tools/sample-shot.ts <media.mp4> <start> <end> [samples.json] [--cuts]
 * With a samples.json that exists, it is read instead of decoding (re-judge after a rule change).
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import pino from "pino";
import { loadConfig } from "../../config.js";
import { createMediaTools } from "../../media.js";
import { sampleFaces, segmentLayouts, dropStaticFaces, type FaceSample } from "../../pipeline/layout.js";
import { attachText } from "../../pipeline/content-region.js";
import { sampleClipText } from "../../pipeline/overlays.js";
import { loadFaceDetector } from "../../vision/faces.js";
import { loadTextDetector } from "../../vision/text.js";
import { subjectFraming } from "../../pipeline/saliency.js";

const [media, a, b, out] = process.argv.slice(2).filter((x) => !x.startsWith("--"));
if (!media || !a || !b) throw new Error("usage: sample-shot <media> <start> <end> [samples.json]");
const start = Number(a);
const end = Number(b);
const config = loadConfig({ DATABASE_URL: "postgres://eval", BETTER_AUTH_SECRET: "eval-secret-eval-secret-eval-secret", ...process.env });
let samples: FaceSample[];
let cuts: number[] = [];
const cutsFile = out ? out.replace(/\.json$/, ".cuts.json") : undefined;
if (out && existsSync(out)) {
  samples = JSON.parse(await fs.readFile(out, "utf8"));
  if (cutsFile && existsSync(cutsFile)) cuts = JSON.parse(await fs.readFile(cutsFile, "utf8"));
} else {
  const det = await loadFaceDetector(config.FACE_MODEL_PATH);
  samples = await sampleFaces(det, {
    ffmpegPath: config.FFMPEG_PATH,
    source: media,
    startSec: start,
    durationSec: end - start,
    sampleFps: 4,
    srcAspect: 16 / 9,
  });
  await det.release();
  const text = await loadTextDetector(config.TEXT_MODEL_PATH);
  const frames = await sampleClipText({ detector: text, ffmpegPath: config.FFMPEG_PATH }, media, start, end - start, 2);
  await text.release();
  const r3 = (v: number) => Number(v.toFixed(3));
  samples = attachText(
    samples,
    frames.map((f) => ({ t: f.t, all: f.all.map((x) => ({ x1: r3(x.x1), y1: r3(x.y1), x2: r3(x.x2), y2: r3(x.y2) })) })),
  );
  const tools = createMediaTools(config, pino({ level: "warn" }));
  cuts = await tools.detectScenes(media, undefined, undefined, { start, duration: end - start });
  if (out) {
    await fs.writeFile(out, JSON.stringify(samples));
    await fs.writeFile(cutsFile!, JSON.stringify(cuts));
  }
}
const segs = segmentLayouts(dropStaticFaces(samples).samples, { ...config, srcAspect: 16 / 9 }, cuts, end - start);
console.log(`cuts: ${cuts.map((c) => c.toFixed(2)).join(", ")}`);
for (const sg of segs)
  console.log(
    `${(sg.start + start).toFixed(1)}-${(sg.end + start).toFixed(1)} ${sg.decision.layout}${sg.decision.focus ? "/subject" : ""}${sg.decision.inset ? "/inset" : ""} x=${sg.decision.track[0]?.x ?? "-"} ${sg.decision.reason}`,
  );
for (const sg of segs) {
  if (sg.decision.layout !== "fit") continue;
  const inside = samples.filter((s) => s.t >= sg.start && s.t < sg.end);
  const f = subjectFraming(
    inside,
    cuts.filter((c) => c > sg.start && c < sg.end),
    0.316,
  );
  console.log(`  fit ${(sg.start + start).toFixed(1)}: ${f.ok ? "ok" : f.rejected} votes ${f.votes}/${f.active}/${f.frames}`);
}
