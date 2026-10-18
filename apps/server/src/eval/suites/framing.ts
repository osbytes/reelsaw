/**
 * framing: reframing geometry on real face tracks.
 *  - split cases: face samples from a wide two-person shot (speakers at the far left and right).
 *    The layout must be "split" and each speaker crop (`speakerCrop` + `cropX`, shared with the
 *    preview) must centre its speaker within `maxOffset` of the crop width and keep burned-in
 *    caption bands out of the crop. With `maxDrift`, neither speaker's crop may wander more than
 *    that (normalized x) from where that speaker sits: no pan over to the other person and back.
 *  - panel cases: a speaker beside an app screen or title card. Samples carry text boxes and the
 *    divider probe too (generated with the text model on first run). The layout must be "stack" with
 *    the panel on the expected side and at least `minWidth` wide, and the auto segmentation of the
 *    range (`segments`) must show the panel as its own piece when it appears and goes away.
 *  - track cases: the "heavy tripod" camera (`tripodTrack`) must settle within `maxErrPx` of the
 *    face after `settleSec`, and never pan faster than `maxPanPxPerSec`.
 * Face samples are committed (samples.json, derived from the video); when missing they are
 * regenerated from the materialised media with UltraFace.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { speakerCrop, cropX } from "@reelsaw/shared";
import { decideLayout, segmentLayouts, sampleFaces, tripodTrack, trackCenter, type FaceSample } from "../../pipeline/layout.js";
import { attachText } from "../../pipeline/side-panel.js";
import { sampleClipText } from "../../pipeline/overlays.js";
import { loadFaceDetector } from "../../vision/faces.js";
import { loadTextDetector } from "../../vision/text.js";
import { materialize, type CaseResult, type MediaSource, type Suite, type EvalContext } from "../framework.js";

interface FramingCase {
  kind: "split" | "track" | "panel";
  note?: string;
  source: MediaSource;
  /** seconds inside the materialised media */
  start: number;
  end: number;
  srcW: number;
  srcH: number;
  avoid?: Array<{ y1: number; y2: number }>;
  expect: {
    layout?: string;
    maxOffset?: number;
    maxDrift?: number;
    settleSec?: number;
    maxErrPx?: number;
    maxPanPxPerSec?: number;
    /** panel cases: the content panel beside the speaker (side, and at least this share of the frame width) */
    panel?: { side: "left" | "right"; minWidth: number };
    /** panel cases: the auto segmentation of the range, in order (the panel appears and goes away mid-range) */
    segments?: string[];
  };
}

async function samplesFor(ctx: EvalContext, dir: string, c: FramingCase): Promise<FaceSample[]> {
  const file = path.join(dir, "samples.json");
  if (existsSync(file)) return JSON.parse(await fs.readFile(file, "utf8")) as FaceSample[];
  const media = await materialize(ctx, c.source);
  const det = await loadFaceDetector(ctx.config().FACE_MODEL_PATH);
  try {
    let samples = await sampleFaces(det, { ffmpegPath: ctx.config().FFMPEG_PATH, source: media, startSec: c.start, durationSec: c.end - c.start, sampleFps: 4 });
    if (c.kind === "panel") {
      // panel cases read text beside the speaker: scan it the way a render does (2 fps), keep boxes only
      const text = await loadTextDetector(ctx.config().TEXT_MODEL_PATH);
      try {
        const frames = await sampleClipText({ detector: text, ffmpegPath: ctx.config().FFMPEG_PATH }, media, c.start, c.end - c.start, 2);
        const r3 = (v: number) => Number(v.toFixed(3));
        samples = attachText(samples, frames.map((f) => ({ t: f.t, all: f.all.map((b) => ({ x1: r3(b.x1), y1: r3(b.y1), x2: r3(b.x2), y2: r3(b.y2) })) })));
      } finally {
        await text.release();
      }
    }
    await fs.writeFile(file, JSON.stringify(samples));
    ctx.log.warn({ file }, "generated face samples; commit them so the case runs offline");
    return samples;
  } finally {
    await det.release();
  }
}

export const framingSuite: Suite = {
  name: "framing",
  description: "speaker crops centre faces and avoid burned-in text; tripod camera settles on the face",
  needs: [],
  async run(ctx) {
    const root = ctx.fixtures("framing");
    const cfg = ctx.config();
    const out: CaseResult[] = [];
    for (const name of (await fs.readdir(root)).sort()) {
      const dir = path.join(root, name);
      if (!(await fs.stat(dir)).isDirectory()) continue;
      const c = JSON.parse(await fs.readFile(path.join(dir, "case.json"), "utf8")) as FramingCase;
      let samples: FaceSample[];
      try {
        samples = await samplesFor(ctx, dir, c);
      } catch (err) {
        out.push({ id: name, pass: false, skipped: `no samples and cannot generate: ${(err as Error).message.slice(0, 120)}` });
        continue;
      }
      if (c.kind === "split") {
        const d = decideLayout(samples, cfg, []);
        const halfAspect = 1080 / 960;
        const checks: Record<string, number | string> = { layout: d.layout };
        const fails: string[] = [];
        if (c.expect.layout && d.layout !== c.expect.layout) fails.push(`layout ${d.layout}, expected ${c.expect.layout}`);
        const speakers = [
          { label: "A", track: d.track, size: d.speakerSizes?.[0] ?? d.faceSize },
          { label: "B", track: d.track2 ?? [], size: d.speakerSizes?.[1] ?? d.faceSize },
        ];
        for (const s of speakers) {
          if (!s.track.length) continue;
          const ctr = trackCenter(s.track);
          const crop = speakerCrop(c.srcW, c.srcH, halfAspect, { cy: ctr.y, size: s.size }, c.avoid ?? []);
          const x = cropX(c.srcW, crop.w, ctr.x);
          const offset = Math.abs(ctr.x * c.srcW - (x + crop.w / 2)) / crop.w;
          checks[`${s.label}.face`] = `${ctr.x.toFixed(2)},${ctr.y.toFixed(2)}`;
          checks[`${s.label}.offset`] = Number(offset.toFixed(3));
          checks[`${s.label}.cropW`] = Number((crop.w / c.srcW).toFixed(2));
          const drift = Math.max(...s.track.map((p) => Math.abs(p.x - ctr.x)));
          checks[`${s.label}.drift`] = Number(drift.toFixed(3));
          if (c.expect.maxDrift !== undefined && drift > c.expect.maxDrift) fails.push(`speaker ${s.label} crop drifts ${drift.toFixed(2)} from its speaker`);
          if (offset > (c.expect.maxOffset ?? 0.2)) fails.push(`speaker ${s.label} off-centre by ${(offset * 100).toFixed(0)}% of the crop`);
          const faceY = ctr.y * c.srcH;
          for (const b of c.avoid ?? []) {
            const overlaps = crop.y < b.y2 * c.srcH && crop.y + crop.h > b.y1 * c.srcH;
            if (overlaps && faceY < b.y1 * c.srcH) fails.push(`speaker ${s.label} crop includes text band ${b.y1}-${b.y2}`);
          }
          if (faceY < crop.y || faceY > crop.y + crop.h) fails.push(`speaker ${s.label} face outside crop vertically`);
        }
        out.push({ id: name, pass: !fails.length, metrics: checks, notes: fails.join("; ") || c.note || "" });
      } else if (c.kind === "panel") {
        const d = decideLayout(samples, cfg, []);
        const fails: string[] = [];
        const checks: Record<string, number | string> = { layout: d.layout, share: d.panelSignals?.share ?? 0 };
        if (c.expect.layout && d.layout !== c.expect.layout) fails.push(`layout ${d.layout}, expected ${c.expect.layout}${d.panelSignals?.rejected ? ` (${d.panelSignals.rejected})` : ""}`);
        const want = c.expect.panel;
        if (want) {
          if (!d.panel) fails.push("no panel found");
          else {
            checks.side = d.panel.side;
            checks.panelX = `${d.panel.x1}-${d.panel.x2}`;
            checks.reason = d.reason;
            if (d.panel.side !== want.side) fails.push(`panel on the ${d.panel.side}, expected ${want.side}`);
            if (d.panel.x2 - d.panel.x1 < want.minWidth) fails.push(`panel ${(d.panel.x2 - d.panel.x1).toFixed(2)} wide, expected at least ${want.minWidth}`);
          }
        }
        if (c.expect.segments) {
          const got = segmentLayouts(samples, cfg, [], c.end - c.start).map((sg) => sg.decision.layout);
          checks.segments = got.join(",");
          if (got.join(",") !== c.expect.segments.join(",")) fails.push(`segments ${got.join(",")}, expected ${c.expect.segments.join(",")}`);
        }
        out.push({ id: name, pass: !fails.length, metrics: checks, notes: fails.join("; ") || c.note || "" });
      } else {
        const track = tripodTrack(samples, []);
        const settle = c.expect.settleSec ?? 2;
        const t0 = samples[0]?.t ?? 0;
        const errs: number[] = [];
        let maxSpeed = 0;
        for (let i = 0; i < track.length; i++) {
          const s = samples.find((x) => Math.abs(x.t - track[i]!.t) < 1e-6);
          if (i > 0) maxSpeed = Math.max(maxSpeed, (Math.abs(track[i]!.x - track[i - 1]!.x) * c.srcW) / Math.max(1e-3, track[i]!.t - track[i - 1]!.t));
          if (!s?.box || track[i]!.t - t0 < settle) continue;
          errs.push(Math.abs(track[i]!.x - (s.box.x1 + s.box.x2) / 2) * c.srcW);
        }
        errs.sort((a, b) => a - b);
        const median = errs[Math.floor(errs.length / 2)] ?? NaN;
        const fails: string[] = [];
        if (!(median <= (c.expect.maxErrPx ?? 30))) fails.push(`median error ${median.toFixed(0)}px after ${settle}s`);
        if (maxSpeed > (c.expect.maxPanPxPerSec ?? 1200)) fails.push(`pans at ${maxSpeed.toFixed(0)}px/s`);
        out.push({ id: name, pass: !fails.length, metrics: { medianErrPx: Number(median.toFixed(1)), maxPanPxPerSec: Math.round(maxSpeed), points: errs.length }, notes: fails.join("; ") || c.note || "" });
      }
    }
    return out;
  },
  summarize(results) {
    const offs = results.flatMap((r) => ["A.offset", "B.offset"].map((k) => r.metrics?.[k]).filter((v): v is number => typeof v === "number"));
    const errs = results.map((r) => r.metrics?.medianErrPx).filter((v): v is number => typeof v === "number");
    return {
      worstSpeakerOffset: { value: offs.length ? Math.max(...offs) : 0, better: "lower", tolerance: 0.03 },
      worstTrackErrPx: { value: errs.length ? Math.max(...errs) : 0, better: "lower", tolerance: 6 },
      passRate: { value: Number((results.filter((r) => r.pass).length / (results.length || 1)).toFixed(2)), better: "higher" },
    };
  },
};
