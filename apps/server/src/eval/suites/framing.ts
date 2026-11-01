/**
 * framing: reframing geometry on real face tracks.
 *  - split cases: face samples from a wide two-person shot (speakers at the far left and right).
 *    The layout must be "split" and each speaker crop (`speakerCrop` + `cropX`, shared with the
 *    preview) must centre its speaker within `maxOffset` of the crop width and keep burned-in
 *    caption bands out of the crop. With `maxDrift`, neither speaker's crop may wander more than
 *    that (normalized x) from where that speaker sits: no pan over to the other person and back.
 *  - content cases: a speaker beside an app screen or title card. Samples carry text boxes and the
 *    divider probe too (generated with the text model on first run). The layout must be "stack" with
 *    the content region on the expected side and at least `minWidth` wide, and the auto segmentation of the
 *    range (`segments`) must show the region as its own piece when it appears and goes away.
 *  - track cases: the "heavy tripod" camera (`tripodTrack`) must settle within `maxErrFrac` (of the
 *    source width) of the face after `settleSec`, and never pan faster than `maxPanFracPerSec`
 *    (source widths per second). Source-size independent; the legacy `maxErrPx` / `maxPanPxPerSec`
 *    keys (1920 px source) are still accepted and converted.
 *  - shots cases: any source shape (multi-camera, screencast + webcam, hands-only POV, 4:3, 9:16). The
 *    range is segmented the way a render does it (static faces dropped, the source aspect passed, the
 *    detected scene cuts) and compared with hand-labelled `windows`: the share of labelled time whose
 *    layout is one of the window's allowed layouts must reach `minAgreement`; where a window gives
 *    `faces` (x of each person a human would frame), the matching segment's crop track(s) must sit
 *    within `faceTol` of them. `uncertain` windows (a human editor could go either way) are reported
 *    but never scored. `maxFaceFrames` caps the share of sampled frames with any face box (a source
 *    with no face must not grow one), and `minCropWidth` the face crop's share of the source width
 *    (a vertical source should come out near the identity).
 *  - tile cases: a webcam tile (picture-in-picture box) over a screen share or in a meeting layout.
 *    The range must segment as a stack whose decision carries the tile at the labelled bounds
 *    (+-`tol`), a forced "Screen + speaker" must find the same tile, the detected faces must lie
 *    inside it, and the top pane must be the labelled `content` region (the frame without the
 *    tile's flat band) or the whole frame. Samples carry the per-frame tile probe. A shots case may
 *    give `tile` too: every stack piece must then frame it.
 * Face samples are committed (samples.json, derived from the video); when missing they are
 * regenerated from the materialised media with UltraFace.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { speakerCrop, cropX, isFullFrame, contentSide, verticalCrop } from "@reelsaw/shared";
import {
  decideLayout,
  segmentLayouts,
  sampleFaces,
  tripodTrack,
  trackCenter,
  dropStaticFaces,
  forcedDecision,
  type FaceSample,
} from "../../pipeline/layout.js";
import { attachText } from "../../pipeline/content-region.js";
import { sampleClipText } from "../../pipeline/overlays.js";
import { loadFaceDetector } from "../../vision/faces.js";
import { loadTextDetector } from "../../vision/text.js";
import { materialize, type CaseResult, type MediaSource, type Suite, type EvalContext } from "../framework.js";

interface ShotWindow {
  /** seconds from the range start */
  from: number;
  to: number;
  /** the layout(s) a human editor would accept here */
  layout: string | string[];
  /** x (0..1 of the source width) of each person the crop should frame, left to right */
  faces?: number[];
  /** debatable: reported, never scored */
  uncertain?: boolean;
}

interface FramingCase {
  kind: "split" | "track" | "content" | "shots" | "tile";
  note?: string;
  source: MediaSource;
  /** seconds inside the materialised media */
  start: number;
  end: number;
  srcW: number;
  srcH: number;
  avoid?: Array<{ y1: number; y2: number }>;
  /** content cases: scene cuts inside the range (seconds from its start), as the render passes them */
  sceneCuts?: number[];
  expect: {
    layout?: string;
    maxOffset?: number;
    maxDrift?: number;
    settleSec?: number;
    maxErrFrac?: number;
    maxPanFracPerSec?: number;
    /** legacy: pixels of a 1920 px wide source */
    maxErrPx?: number;
    maxPanPxPerSec?: number;
    /** content cases: the region shown on top: the side it hugs (or an explicit box, +-0.03), and at least this share of the frame width */
    content?: { side?: "left" | "right"; box?: [number, number, number, number]; minWidth: number };
    /** content cases: the auto segmentation of the range, in order (the region appears and goes away mid-range) */
    segments?: string[];
    /** track cases: after a shot change at `at` (seconds from the range start) the crop must be on the face within `within` seconds */
    recentre?: { at: number; within: number };
    /** content cases: where the segments change, in seconds from the range start (+-0.3 s) */
    edges?: number[];
    /** shots cases: hand-labelled windows, the share of labelled time that must agree, and the face tolerance (fraction of width) */
    windows?: ShotWindow[];
    minAgreement?: number;
    faceTol?: number;
    /** shots cases: at most this share of sampled frames may hold any face box */
    maxFaceFrames?: number;
    /** shots cases: a face crop must keep at least this share of the source width */
    minCropWidth?: number;
    /**
     * tile cases (and shots cases with a webcam tile): the tile's bounds (+-`tol`, default 0.03), and
     * the region shown on top when the tile sits in a flat band (absent = the whole frame on top)
     */
    tile?: { box: [number, number, number, number]; tol?: number; content?: [number, number, number, number] };
  };
}

const fmtBox = (b: { x1: number; y1: number; x2: number; y2: number }) => [b.x1, b.y1, b.x2, b.y2].map((v) => v.toFixed(2)).join(",");
const boxErr = (b: { x1: number; y1: number; x2: number; y2: number }, want: [number, number, number, number]) =>
  Math.max(...[b.x1, b.y1, b.x2, b.y2].map((v, i) => Math.abs(v - want[i]!)));

/**
 * A webcam tile over a screen share or in a meeting layout: the auto segmentation must stack the
 * range with the tile at the expected bounds, a forced "Screen + speaker" must find the same tile,
 * the faces the detector did see must lie inside it, and the top pane must be the expected region
 * (the frame without the tile's band) or the whole frame.
 */
function judgeTile(id: string, c: FramingCase, raw: FaceSample[], config: Parameters<typeof segmentLayouts>[1]): CaseResult {
  const samples = dropStaticFaces(raw).samples;
  const cuts = c.sceneCuts ?? [];
  const segs = segmentLayouts(samples, config, cuts, c.end - c.start);
  const fails: string[] = [];
  const checks: Record<string, number | string> = { segments: segs.map((sg) => `${sg.decision.layout}@${sg.start.toFixed(1)}`).join(",") };
  const stackSec = segs.filter((sg) => sg.decision.layout === "stack").reduce((n, sg) => n + sg.end - sg.start, 0);
  const share = stackSec / (c.end - c.start);
  checks.stackShare = Number(share.toFixed(3));
  const minAgree = c.expect.minAgreement ?? 0.9;
  if (share < minAgree) fails.push(`stack for ${(share * 100).toFixed(0)}% of the range, expected at least ${(minAgree * 100).toFixed(0)}%`);
  const auto = segs.filter((sg) => sg.decision.layout === "stack").sort((a, b) => b.end - b.start - (a.end - a.start))[0]?.decision;
  const forced = forcedDecision(samples, "stack", config, cuts);
  const want = c.expect.tile;
  const tol = want?.tol ?? 0.03;
  let worst = 0;
  for (const [label, d] of [
    ["auto", auto],
    ["forced", forced],
  ] as const) {
    if (!d) {
      fails.push(`${label}: no stack piece`);
      continue;
    }
    checks[`${label}.reason`] = d.reason;
    if (!d.tile) {
      fails.push(`${label}: no webcam tile found`);
      continue;
    }
    checks[`${label}.tile`] = fmtBox(d.tile);
    if (want) {
      const err = boxErr(d.tile, want.box);
      worst = Math.max(worst, err);
      if (err > tol) fails.push(`${label}: tile ${fmtBox(d.tile)}, expected ${want.box.join(",")} (+-${tol})`);
      if (want.content) {
        if (!d.content || isFullFrame(d.content)) fails.push(`${label}: the whole frame on top, expected the region ${want.content.join(",")}`);
        else if (boxErr(d.content, want.content) > tol)
          fails.push(`${label}: region ${fmtBox(d.content)} on top, expected ${want.content.join(",")} (+-${tol})`);
      } else if (d.content && !isFullFrame(d.content)) fails.push(`${label}: region ${fmtBox(d.content)} on top, expected the whole frame`);
    }
    // the faces the detector did see sit inside the tile
    const faces = samples.filter((s) => s.box);
    const inside = faces.filter(
      (s) => s.box!.x1 >= d.tile!.x1 - 0.02 && s.box!.x2 <= d.tile!.x2 + 0.02 && s.box!.y1 >= d.tile!.y1 - 0.02 && s.box!.y2 <= d.tile!.y2 + 0.02,
    ).length;
    const inTile = faces.length ? inside / faces.length : 1;
    checks[`${label}.facesInTile`] = Number(inTile.toFixed(2));
    if (inTile < 0.9) fails.push(`${label}: only ${(inTile * 100).toFixed(0)}% of the detected faces lie inside the tile`);
  }
  checks.tileErr = Number(worst.toFixed(3));
  checks.faceFrames = Number((samples.filter((s) => s.box).length / Math.max(1, samples.length)).toFixed(3));
  return { id, pass: !fails.length, metrics: checks, notes: fails.join("; ") || c.note || "" };
}

async function samplesFor(ctx: EvalContext, dir: string, c: FramingCase): Promise<FaceSample[]> {
  const file = path.join(dir, "samples.json");
  if (existsSync(file)) return JSON.parse(await fs.readFile(file, "utf8")) as FaceSample[];
  const media = await materialize(ctx, c.source);
  const det = await loadFaceDetector(ctx.config().FACE_MODEL_PATH);
  try {
    let samples = await sampleFaces(det, {
      ffmpegPath: ctx.config().FFMPEG_PATH,
      source: media,
      startSec: c.start,
      durationSec: c.end - c.start,
      sampleFps: 4,
      srcAspect: c.srcW / c.srcH,
    });
    if (c.kind === "content" || c.kind === "shots") {
      // content cases read text beside the speaker: scan it the way a render does (2 fps), keep boxes only
      const text = await loadTextDetector(ctx.config().TEXT_MODEL_PATH);
      try {
        const frames = await sampleClipText({ detector: text, ffmpegPath: ctx.config().FFMPEG_PATH }, media, c.start, c.end - c.start, 2);
        const r3 = (v: number) => Number(v.toFixed(3));
        samples = attachText(
          samples,
          frames.map((f) => ({ t: f.t, all: f.all.map((b) => ({ x1: r3(b.x1), y1: r3(b.y1), x2: r3(b.x2), y2: r3(b.y2) })) })),
        );
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

/** Segment a shots case the way a render does and score it against its labelled windows. */
function judgeShots(id: string, c: FramingCase, raw: FaceSample[], config: Parameters<typeof segmentLayouts>[1]): CaseResult {
  const samples = dropStaticFaces(raw).samples;
  const segs = segmentLayouts(samples, config, c.sceneCuts ?? [], c.end - c.start);
  const fails: string[] = [];
  const faceFrames = samples.filter((s) => s.boxes.length > 0).length / Math.max(1, samples.length);
  const checks: Record<string, number | string> = {
    segments: segs.map((sg) => `${sg.decision.layout}@${sg.start.toFixed(1)}`).join(","),
    faceFrames: Number(faceFrames.toFixed(3)),
  };
  if (c.expect.maxFaceFrames !== undefined && faceFrames > c.expect.maxFaceFrames)
    fails.push(`faces in ${(faceFrames * 100).toFixed(0)}% of frames, expected at most ${(c.expect.maxFaceFrames * 100).toFixed(0)}%`);
  const tol = c.expect.faceTol ?? 0.08;
  let scored = 0;
  let agreed = 0;
  let worstFace = 0;
  for (const w of c.expect.windows ?? []) {
    const allowed = Array.isArray(w.layout) ? w.layout : [w.layout];
    let ok = 0;
    for (const sg of segs) {
      const a = Math.max(w.from, sg.start);
      const b = Math.min(w.to, sg.end);
      if (b <= a || !allowed.includes(sg.decision.layout)) continue;
      ok += b - a;
      if (w.uncertain || !w.faces?.length || sg.decision.layout === "fit" || sg.decision.layout === "center" || sg.decision.layout === "none") continue;
      // where the crop sits inside this window: one track per framed person, left to right
      const inWin = (tr: Array<{ t: number; x: number; y: number }> | undefined) => (tr ?? []).filter((p) => p.t >= a - 1e-6 && p.t <= b + 1e-6);
      const xs = [inWin(sg.decision.track), inWin(sg.decision.track2)]
        .filter((tr) => tr.length)
        .map((tr) => trackCenter(tr).x)
        .sort((p, q) => p - q);
      for (let i = 0; i < Math.min(xs.length, w.faces.length); i++) worstFace = Math.max(worstFace, Math.abs(xs[i]! - w.faces[i]!));
    }
    const span = w.to - w.from;
    checks[`w${w.from}-${w.to}`] = `${Number((ok / span).toFixed(2))}${w.uncertain ? "?" : ""}`;
    if (w.uncertain) continue;
    scored += span;
    agreed += ok;
  }
  const agreement = scored > 0 ? agreed / scored : 1;
  checks.agreement = Number(agreement.toFixed(3));
  checks.faceErr = Number(worstFace.toFixed(3));
  const minAgree = c.expect.minAgreement ?? 0.8;
  if (agreement < minAgree)
    fails.push(`layout agrees with the labels for ${(agreement * 100).toFixed(0)}% of the labelled time, expected at least ${(minAgree * 100).toFixed(0)}%`);
  if (worstFace > tol) fails.push(`crop ${worstFace.toFixed(2)} of the width off a labelled face (tolerance ${tol})`);
  if (c.expect.tile) {
    // every stack piece must frame the webcam tile, at the labelled bounds
    const tol = c.expect.tile.tol ?? 0.03;
    const stacks = segs.filter((sg) => sg.decision.layout === "stack");
    const tiles = stacks.flatMap((sg) => (sg.decision.tile ? [sg.decision.tile] : []));
    const worst = tiles.length ? Math.max(...tiles.map((t) => boxErr(t, c.expect.tile!.box))) : NaN;
    checks.tile = tiles.length ? fmtBox(tiles[0]!) : "none";
    checks.tileErr = Number.isFinite(worst) ? Number(worst.toFixed(3)) : "n/a";
    if (tiles.length < stacks.length) fails.push(`${stacks.length - tiles.length} of ${stacks.length} stack pieces found no webcam tile`);
    if (worst > tol) fails.push(`tile ${worst.toFixed(2)} off the labelled bounds ${c.expect.tile.box.join(",")} (tolerance ${tol})`);
  }
  if (c.expect.minCropWidth !== undefined) {
    const share = verticalCrop(c.srcW, c.srcH).w / c.srcW;
    checks.cropWidth = Number(share.toFixed(3));
    if (segs.some((sg) => sg.decision.layout === "face") && share < c.expect.minCropWidth)
      fails.push(`face crop keeps ${(share * 100).toFixed(0)}% of the width`);
    const wide = segs.filter((sg) => sg.decision.layout === "split" || sg.decision.layout === "stack");
    if (wide.length) fails.push(`${wide.map((sg) => sg.decision.layout).join(",")} on a source that already fits the output`);
  }
  return { id, pass: !fails.length, metrics: checks, notes: fails.join("; ") || c.note || "" };
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
      // face-size floors are relative to the shorter source side, as in a render (identical for 16:9)
      const lcfg = { ...cfg, srcAspect: c.srcW / c.srcH };
      let samples: FaceSample[];
      try {
        samples = await samplesFor(ctx, dir, c);
      } catch (err) {
        out.push({ id: name, pass: false, skipped: `no samples and cannot generate: ${(err as Error).message.slice(0, 120)}` });
        continue;
      }
      if (c.kind === "split") {
        // as in a render: a printed face on the wall is not a third person
        const d = decideLayout(dropStaticFaces(samples).samples, lcfg, []);
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
      } else if (c.kind === "content") {
        // the way a render does it: segment the clip (with its scene cuts), judge the stack piece
        const segs = segmentLayouts(samples, lcfg, c.sceneCuts ?? [], c.end - c.start);
        const d =
          segs.find((sg) => sg.decision.layout === "stack" && sg.decision.content && !isFullFrame(sg.decision.content))?.decision ??
          decideLayout(samples, lcfg, c.sceneCuts ?? []);
        const fails: string[] = [];
        const checks: Record<string, number | string> = { layout: d.layout, share: d.contentSignals?.share ?? 0 };
        if (c.expect.layout && d.layout !== c.expect.layout)
          fails.push(`layout ${d.layout}, expected ${c.expect.layout}${d.contentSignals?.rejected ? ` (${d.contentSignals.rejected})` : ""}`);
        const want = c.expect.content;
        if (want) {
          const r = d.content;
          if (!r || isFullFrame(r)) fails.push("no content region found");
          else {
            const side = contentSide(r);
            checks.side = side ?? "inset";
            checks.contentX = `${r.x1}-${r.x2}`;
            checks.reason = d.reason;
            if (want.side && side !== want.side) fails.push(`content on the ${side}, expected ${want.side}`);
            if (want.box && [r.x1, r.y1, r.x2, r.y2].some((v, i) => Math.abs(v - want.box![i]!) > 0.03))
              fails.push(`content ${r.x1},${r.y1},${r.x2},${r.y2}, expected ${want.box.join(",")}`);
            if (r.x2 - r.x1 < want.minWidth) fails.push(`content ${(r.x2 - r.x1).toFixed(2)} wide, expected at least ${want.minWidth}`);
          }
        }
        if (c.expect.segments) {
          const got = segs.map((sg) => sg.decision.layout);
          checks.segments = got.join(",");
          if (got.join(",") !== c.expect.segments.join(",")) fails.push(`segments ${got.join(",")}, expected ${c.expect.segments.join(",")}`);
        }
        if (c.expect.edges) {
          const got = segs.slice(0, -1).map((sg) => Number(sg.end.toFixed(1)));
          checks.edges = got.join(",");
          const off = c.expect.edges.some((e, i) => got[i] === undefined || Math.abs(got[i]! - e) > 0.3);
          if (off || got.length !== c.expect.edges.length) fails.push(`boundaries at ${got.join(",")} s, expected ${c.expect.edges.join(",")} (+-0.3)`);
        }
        out.push({ id: name, pass: !fails.length, metrics: checks, notes: fails.join("; ") || c.note || "" });
      } else if (c.kind === "shots") {
        out.push(judgeShots(name, c, samples, lcfg));
      } else if (c.kind === "tile") {
        out.push(judgeTile(name, c, samples, lcfg));
      } else {
        const track = tripodTrack(samples, c.sceneCuts ?? []);
        // tolerances are fractions of the source width; legacy px keys are 1920 px source pixels
        const maxErrPx = (c.expect.maxErrFrac ?? (c.expect.maxErrPx ?? 30) / 1920) * c.srcW;
        const maxPanPxPerSec = (c.expect.maxPanFracPerSec ?? (c.expect.maxPanPxPerSec ?? 1200) / 1920) * c.srcW;
        const settle = c.expect.settleSec ?? 2;
        const t0 = samples[0]?.t ?? 0;
        const errs: number[] = [];
        let maxSpeed = 0;
        for (let i = 0; i < track.length; i++) {
          const s = samples.find((x) => Math.abs(x.t - track[i]!.t) < 1e-6);
          // a hard cut (two points a few ms apart) is a snap, not a pan
          if (i > 0 && track[i]!.t - track[i - 1]!.t >= 0.01)
            maxSpeed = Math.max(maxSpeed, (Math.abs(track[i]!.x - track[i - 1]!.x) * c.srcW) / (track[i]!.t - track[i - 1]!.t));
          if (!s?.box || track[i]!.t - t0 < settle) continue;
          errs.push(Math.abs(track[i]!.x - (s.box.x1 + s.box.x2) / 2) * c.srcW);
        }
        errs.sort((a, b) => a - b);
        const median = errs[Math.floor(errs.length / 2)] ?? NaN;
        const fails: string[] = [];
        if (!(median <= maxErrPx)) fails.push(`median error ${median.toFixed(0)}px after ${settle}s`);
        const rc = c.expect.recentre;
        let recentreErr = 0;
        if (rc) {
          // the face must be framed by `within` seconds after the shot change, and stay framed for the next second and a half
          const late = track.flatMap((tp, i) =>
            tp.t - t0 >= rc.at + rc.within && tp.t - t0 <= rc.at + rc.within + 1.5 && samples[i]?.box
              ? [Math.abs(tp.x - (samples[i]!.box!.x1 + samples[i]!.box!.x2) / 2) * c.srcW]
              : [],
          );
          recentreErr = late.length ? Math.max(...late) : NaN;
          if (!(recentreErr <= maxErrPx * 2)) fails.push(`${recentreErr.toFixed(0)}px off the face ${rc.within}s after the shot change`);
        }
        if (maxSpeed > maxPanPxPerSec) fails.push(`pans at ${maxSpeed.toFixed(0)}px/s`);
        out.push({
          id: name,
          pass: !fails.length,
          metrics: {
            medianErrPx: Number(median.toFixed(1)),
            maxPanPxPerSec: Math.round(maxSpeed),
            points: errs.length,
            ...(rc ? { recentreErrPx: Math.round(recentreErr) } : {}),
          },
          notes: fails.join("; ") || c.note || "",
        });
      }
    }
    return out;
  },
  summarize(results) {
    const offs = results.flatMap((r) => ["A.offset", "B.offset"].map((k) => r.metrics?.[k]).filter((v): v is number => typeof v === "number"));
    const errs = results.map((r) => r.metrics?.medianErrPx).filter((v): v is number => typeof v === "number");
    const agree = results
      .filter((r) => !r.skipped)
      .map((r) => r.metrics?.agreement)
      .filter((v): v is number => typeof v === "number");
    const tileErrs = results
      .filter((r) => !r.skipped)
      .map((r) => r.metrics?.tileErr)
      .filter((v): v is number => typeof v === "number");
    return {
      worstShotAgreement: { value: agree.length ? Math.min(...agree) : 1, better: "higher", tolerance: 0.05 },
      worstTileErr: { value: tileErrs.length ? Math.max(...tileErrs) : 0, better: "lower", tolerance: 0.01 },
      worstSpeakerOffset: { value: offs.length ? Math.max(...offs) : 0, better: "lower", tolerance: 0.03 },
      worstTrackErrPx: { value: errs.length ? Math.max(...errs) : 0, better: "lower", tolerance: 6 },
      passRate: { value: Number((results.filter((r) => r.pass).length / (results.length || 1)).toFixed(2)), better: "higher" },
    };
  },
};
