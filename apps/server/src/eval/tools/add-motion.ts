/**
 * Add the per-frame motion probe (`probeMotion`, saliency.ts) to committed framing fixtures whose
 * samples.json predates it, without touching their face, text, divider, tile or inset data: the same
 * frames are decoded (4 fps, 320x240, the case's range) and `motion` is set on the sample of the same
 * index. With --text, a case whose samples carry no text boxes also gets them (2 fps PP-OCR scan,
 * attached as a render does). Run from apps/server: tsx src/eval/tools/add-motion.ts [--text] <case dir>...
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import pino from "pino";
import { loadConfig } from "../../config.js";
import { rgbFramesToPipe } from "../../media.js";
import { FACE_INPUT_W, FACE_INPUT_H } from "../../vision/faces.js";
import { motionProber } from "../../pipeline/saliency.js";
import type { FaceSample } from "../../pipeline/layout.js";
import { materialize, type EvalContext } from "../framework.js";
import { attachText } from "../../pipeline/content-region.js";
import { sampleClipText } from "../../pipeline/overlays.js";
import { loadTextDetector } from "../../vision/text.js";

const config = loadConfig({ DATABASE_URL: "postgres://eval", BETTER_AUTH_SECRET: "eval-secret-eval-secret-eval-secret", ...process.env });
const root = path.resolve(process.cwd(), "../../eval");
const ctx = { root, cacheDir: path.join(root, ".cache"), offline: false, config: () => config, log: pino({ level: "warn" }) } as unknown as EvalContext;

const withText = process.argv.includes("--text");
for (const dir of process.argv.slice(2).filter((a) => !a.startsWith("--"))) {
  const c = JSON.parse(await fs.readFile(path.join(dir, "case.json"), "utf8"));
  const file = path.join(dir, "samples.json");
  let samples = JSON.parse(await fs.readFile(file, "utf8")) as FaceSample[];
  const media = await materialize(ctx, c.source);
  if (withText && !samples.some((s) => s.text?.length)) {
    const det = await loadTextDetector(config.TEXT_MODEL_PATH);
    const frames = await sampleClipText({ detector: det, ffmpegPath: config.FFMPEG_PATH }, media, c.start, c.end - c.start, 2);
    await det.release();
    const r3 = (v: number) => Number(v.toFixed(3));
    samples = attachText(
      samples,
      frames.map((f) => ({ t: f.t, all: f.all.map((x) => ({ x1: r3(x.x1), y1: r3(x.y1), x2: r3(x.x2), y2: r3(x.y2) })) })),
    );
  }
  const ff = spawn(
    config.FFMPEG_PATH,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-ss",
      Number(c.start).toFixed(3),
      "-t",
      (c.end - c.start).toFixed(3),
      "-i",
      media,
      "-vf",
      `fps=4,scale=${FACE_INPUT_W}:${FACE_INPUT_H}`,
      ...rgbFramesToPipe,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const probe = motionProber(FACE_INPUT_W, FACE_INPUT_H);
  const size = FACE_INPUT_W * FACE_INPUT_H * 3;
  let buf = Buffer.alloc(0);
  let i = 0;
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= size) {
      const m = probe(new Uint8Array(buf.subarray(0, size)));
      buf = buf.subarray(size);
      const s = samples[i];
      if (s && Math.abs(s.t - i / 4) < 1e-6 && m) s.motion = m;
      i++;
    }
  }
  if (Math.abs(i - samples.length) > 1) throw new Error(`${dir}: decoded ${i} frames, samples.json has ${samples.length}`);
  await fs.writeFile(file, JSON.stringify(samples));
  console.log(`${path.basename(dir)}: motion on ${samples.filter((s) => s.motion).length}/${samples.length} samples`);
}
