/**
 * overlays: burned-in text detection.
 *  - frame cases (offline, needs the text model file): the PP-OCR detector must find the labelled
 *    captions / handle / logo on hand-labelled frames (union of boxes covers ≥ 50% of each label).
 *    Scene text is reported but not required.
 *  - aggregate cases (needs media): `detectOverlays` over a real video section must cover every
 *    expected overlay and must NOT cover scene text (cap logos, wall signs) or the speakers.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadTextDetector, TEXT_INPUT_W, TEXT_INPUT_H, type TextDetector } from "../../vision/text.js";
import { detectOverlays, growOverlays } from "../../pipeline/overlays.js";
import { sourceVideo } from "../../pipeline/render.js";
import type { SourceOverlay } from "@reelsaw/shared";
import { materialize, type CaseResult, type MediaSource, type Suite, type EvalContext } from "../framework.js";

type Box = [number, number, number, number];
interface Labels {
  frames: Array<{ file: string; t: number; labels: Array<{ name: string; kind: "caption" | "watermark" | "scene"; box: Box; required?: boolean }> }>;
  aggregate: Array<{ id: string; source: MediaSource; sceneCuts: number[]; expectOverlays: Array<{ name: string; box: Box }>; mustNotCover: Array<{ name: string; box: Box }> }>;
}

/** Fraction of `target` covered by the union of `boxes` (grid sampling, exact enough for grading). */
export function unionCoverage(target: Box, boxes: Box[]): number {
  const N = 40;
  let hit = 0;
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      const x = target[0] + ((i + 0.5) / N) * (target[2] - target[0]);
      const y = target[1] + ((j + 0.5) / N) * (target[3] - target[1]);
      if (boxes.some((b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])) hit++;
    }
  return hit / (N * N);
}

let detector: TextDetector | undefined;
async function getDetector(ctx: EvalContext) {
  return (detector ??= await loadTextDetector(ctx.config().TEXT_MODEL_PATH));
}

export const overlaysSuite: Suite = {
  name: "overlays",
  description: "burned-in captions/watermarks: per-frame detection recall and whole-video aggregation (no scene text)",
  needs: ["media"],
  async run(ctx) {
    const dir = ctx.fixtures("overlays");
    const spec = JSON.parse(await fs.readFile(path.join(dir, "labels.json"), "utf8")) as Labels;
    const cfg = ctx.config();
    const out: CaseResult[] = [];
    let det: TextDetector;
    try {
      det = await getDetector(ctx);
    } catch (err) {
      return [{ id: "(model)", pass: false, skipped: `text model unavailable: ${(err as Error).message.slice(0, 120)} (pnpm models:download)` }];
    }
    const allBoxes: Box[] = [];
    for (const f of spec.frames) {
      const rgb = await ctx.exec(cfg.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-i", path.join(dir, f.file), "-vf", `scale=${TEXT_INPUT_W}:${TEXT_INPUT_H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
      const boxes = (await det.detect(new Uint8Array(rgb))).map((b) => [b.x1, b.y1, b.x2, b.y2] as Box);
      const want = f.labels.filter((l) => l.kind !== "scene" && l.required !== false);
      const cov = Object.fromEntries(f.labels.map((l) => [l.name, Number(unionCoverage(l.box, boxes).toFixed(2))]));
      const missed = want.filter((l) => cov[l.name]! < 0.5).map((l) => l.name);
      out.push({ id: `frame-${f.t}s`, pass: missed.length === 0, metrics: { boxes: boxes.length, ...cov }, notes: missed.length ? `missed ${missed.join(", ")}` : "" });
      allBoxes.push(...boxes);
    }
    // mask residual: a narrow band core (what the frequency grid finds) grown from the boxes actually
    // seen, then the renderer's blur mask applied to every frame: no labelled caption/handle text may
    // remain detectable. Regression for "captions visible outside the blur" (long lines, 2nd lines).
    {
      const core: SourceOverlay = { x1: 0.3, x2: 0.7, y1: 0.67, y2: 0.74, kind: "caption", coverage: 0.9 };
      const grown = growOverlays([core], allBoxes.map(([x1, y1, x2, y2]) => ({ x1, y1, x2, y2 })), { quantile: 1 });
      const mask = sourceVideo(grown, TEXT_INPUT_W, TEXT_INPUT_H, 1);
      let residual = 0;
      const leaks: string[] = [];
      for (const f of spec.frames) {
        const graph = `[0:v]scale=${TEXT_INPUT_W}:${TEXT_INPUT_H}[s];${mask.prefix.replace("[0:v]", "[s]")}${mask.labels[0]}null[o]`;
        const rgb = await ctx.exec(cfg.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-i", path.join(dir, f.file), "-filter_complex", graph, "-map", "[o]", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
        const left = (await det.detect(new Uint8Array(rgb))).map((b) => [b.x1, b.y1, b.x2, b.y2] as Box);
        for (const l of f.labels.filter((x) => x.name === "caption" || x.name === "handle")) {
          const c = unionCoverage(l.box, left);
          if (c > 0.15) {
            residual++;
            leaks.push(`${f.t}s ${l.name} ${c.toFixed(2)}`);
          }
        }
      }
      const g = grown[0]!;
      out.push({ id: "mask-residual", pass: residual === 0, metrics: { residual, regionW: Number((g.x2 - g.x1).toFixed(2)), regionH: Number((g.y2 - g.y1).toFixed(2)) }, notes: leaks.join("; ") });
    }

    for (const a of spec.aggregate) {
      let media: string;
      try {
        media = await materialize(ctx, a.source);
      } catch (err) {
        out.push({ id: `aggregate-${a.id}`, pass: false, skipped: (err as Error).message });
        continue;
      }
      const t0 = Date.now();
      // not cached on purpose: the aggregation logic is what this case tests, and it is fast (~2 s)
      const scan = await detectOverlays({ detector: det, ffmpegPath: cfg.FFMPEG_PATH }, media, a.source.end - a.source.start, a.sceneCuts);
      const regions = scan.overlays.map((o) => [o.x1, o.y1, o.x2, o.y2] as Box);
      const covered = Object.fromEntries(a.expectOverlays.map((e) => [e.name, Number(unionCoverage(e.box, regions).toFixed(2))]));
      const leaked = Object.fromEntries(a.mustNotCover.map((e) => [e.name, Number(unionCoverage(e.box, regions).toFixed(2))]));
      const missing = a.expectOverlays.filter((e) => covered[e.name]! < 0.6).map((e) => e.name);
      // a region is a false positive if it covers much of a forbidden area, or sits mostly inside one
      const falsePos = a.mustNotCover.filter((e) => leaked[e.name]! > 0.2 || regions.some((r) => unionCoverage(r, [e.box]) >= 0.5)).map((e) => e.name);
      out.push({
        id: `aggregate-${a.id}`,
        pass: !missing.length && !falsePos.length,
        metrics: { regions: regions.length, frames: scan.frames, ...Object.fromEntries(Object.entries(covered).map(([k, v]) => [`hit:${k}`, v])), ...Object.fromEntries(Object.entries(leaked).map(([k, v]) => [`fp:${k}`, v])), sec: Number(((Date.now() - t0) / 1000).toFixed(1)) },
        notes: [missing.length ? `missed ${missing.join(", ")}` : "", falsePos.length ? `false positive on ${falsePos.join(", ")}` : "", JSON.stringify(scan.overlays.map((o) => [o.kind, o.x1, o.y1, o.x2, o.y2]))].filter(Boolean).join("; "),
      });
    }
    return out;
  },
  summarize(results) {
    const frames = results.filter((r) => r.id.startsWith("frame-"));
    const meanOf = (k: string) => {
      const v = frames.map((r) => r.metrics?.[k]).filter((x): x is number => typeof x === "number");
      return Number((v.reduce((a, b) => a + b, 0) / (v.length || 1)).toFixed(2));
    };
    return {
      captionCoverage: { value: meanOf("caption"), better: "higher", tolerance: 0.05 },
      handleCoverage: { value: meanOf("handle"), better: "higher", tolerance: 0.05 },
      logoCoverage: { value: meanOf("logo"), better: "higher", tolerance: 0.05 },
      framePassRate: { value: Number((frames.filter((r) => r.pass).length / (frames.length || 1)).toFixed(2)), better: "higher" },
      aggregatePass: { value: results.filter((r) => r.id.startsWith("aggregate-") && r.pass).length, better: "higher" },
    };
  },
};
