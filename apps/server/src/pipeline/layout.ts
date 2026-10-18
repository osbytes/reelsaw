import { spawn } from "node:child_process";
import type { Config } from "../config.js";
import { FACE_INPUT_W, FACE_INPUT_H, type FaceDetector, type FaceBox } from "../vision/faces.js";
import { panelRuns, type PanelRun } from "./panel-runs.js";
import { probeDivider, detectSidePanel, panelReason, frameVote, type PanelRegion, type PanelSignals, type PBox, type DividerProbe } from "./side-panel.js";

/** Resolved layout for one clip. */
export type Layout = "face" | "split" | "stack" | "fit" | "center" | "none";

export interface FaceSample {
  t: number; // seconds from clip start
  box: FaceBox | null; // largest face, normalized coords
  boxes: FaceBox[]; // every face this frame
  /** text boxes near this frame (all of them, paragraphs included); absent when text was not scanned */
  text?: PBox[];
  /** strongest straight vertical edge of the frame, for side-by-side composites */
  divider?: DividerProbe;
}

export interface LayoutDecision {
  layout: Layout;
  reason: string;
  /** Fraction of sampled frames with a face. */
  faceRatio: number;
  /** Median face height as fraction of frame height. */
  faceSize: number;
  /** Smoothed face center per second (normalized x,y), for the following crop. */
  track: Array<{ t: number; x: number; y: number }>;
  /** Second speaker's track for the split layout. */
  track2?: Array<{ t: number; x: number; y: number }>;
  /** Per-speaker median face heights for split crops (first = track, second = track2). */
  speakerSizes?: [number, number];
  faceCount: number;
  /** "stack" only: the content panel beside the speaker; the top half shows just this region */
  panel?: PanelRegion;
  /** side-panel detector inputs and outcome, for the debug log */
  panelSignals?: PanelSignals;
}

export interface LayoutOptions {
  ffmpegPath: string;
  source: string;
  startSec: number;
  durationSec: number;
  signal?: AbortSignal;
  sampleFps?: number;
}

/** Sample frames at `sampleFps` through ffmpeg and run the detector on each. */
export async function sampleFaces(det: FaceDetector, opts: LayoutOptions): Promise<FaceSample[]> {
  const fps = opts.sampleFps ?? 2;
  const frameBytes = FACE_INPUT_W * FACE_INPUT_H * 3;
  const ff = spawn(
    opts.ffmpegPath,
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", opts.startSec.toFixed(3), "-t", opts.durationSec.toFixed(3), "-i", opts.source, "-vf", `fps=${fps},scale=${FACE_INPUT_W}:${FACE_INPUT_H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { signal: opts.signal, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  ff.stderr.on("data", (d) => (stderr += d.toString()));
  const samples: FaceSample[] = [];
  let buf = Buffer.alloc(0);
  let i = 0;
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= frameBytes) {
      const frame = buf.subarray(0, frameBytes);
      buf = buf.subarray(frameBytes);
      const px = new Uint8Array(frame);
      const boxes = await det.detect(px);
      const sorted = boxes.sort((a, b) => (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1));
      samples.push({ t: i / fps, box: sorted[0] ?? null, boxes: sorted, divider: probeDivider(px, FACE_INPUT_W, FACE_INPUT_H) });
      i++;
    }
  }
  const code = await new Promise<number | null>((r) => ff.on("close", r));
  if (code !== 0 && !samples.length) throw new Error(`frame sampling failed (${code}): ${stderr.slice(-500)}`);
  return samples;
}

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * Decide how to frame a clip from its face samples.
 *  - a big face most of the time → "face": 9:16 crop that follows the face
 *  - a face that is small or parked in a corner (webcam over a slide/screen) → "stack": full frame on top, zoomed face below
 *  - a big face beside an app screen or title card (side-by-side composite) → "stack" with `panel`: just the panel on top, the speaker below (see side-panel.ts)
 *  - no face → "fit": whole frame over a blurred background (graphics, b-roll, screencasts without a webcam)
 */
export function decideLayout(
  samples: FaceSample[],
  config: Pick<Config, "LAYOUT_MIN_FACE_RATIO" | "LAYOUT_MIN_FACE_SIZE">,
  sceneCuts: number[] = [],
  opts: { panel?: boolean } = {},
): LayoutDecision {
  const withFace = samples.filter((s) => s.box);
  const faceRatio = samples.length ? withFace.length / samples.length : 0;
  const faceCount = Number((samples.reduce((n, s) => n + s.boxes.length, 0) / Math.max(1, samples.length)).toFixed(2));
  const sizes = withFace.map((s) => s.box!.y2 - s.box!.y1);
  const faceSize = median(sizes);
  const cxs = withFace.map((s) => (s.box!.x1 + s.box!.x2) / 2);
  const cys = withFace.map((s) => (s.box!.y1 + s.box!.y2) / 2);
  const cx = median(cxs);
  const cy = median(cys);
  const inCorner = withFace.length > 0 && (cx < 0.22 || cx > 0.78) && (cy < 0.3 || cy > 0.7);

  const track = tripodTrack(samples, sceneCuts);
  const base = { faceRatio: Number(faceRatio.toFixed(2)), faceSize: Number(faceSize.toFixed(3)), track, faceCount };

  if (faceRatio < config.LAYOUT_MIN_FACE_RATIO) {
    return { ...base, layout: "fit", reason: withFace.length ? `face in only ${Math.round(faceRatio * 100)}% of frames` : "no face detected" };
  }
  // two people on screen most of the time (interview / podcast wide shot) → one crop per speaker
  const twoFaces = samples.filter((s) => s.boxes.length >= 2 && s.boxes[1]!.y2 - s.boxes[1]!.y1 >= 0.08).length / Math.max(1, samples.length);
  if (twoFaces >= 0.5) {
    const pair = assignPair(samples);
    const t1 = tripodTrack(pair.a, sceneCuts);
    const t2 = tripodTrack(pair.b, sceneCuts);
    return { ...base, track: t1, track2: t2, speakerSizes: pairSizes(pair), layout: "split", reason: `two faces in ${Math.round(twoFaces * 100)}% of frames` };
  }
  if (faceSize < config.LAYOUT_MIN_FACE_SIZE || inCorner) {
    return { ...base, layout: "stack", reason: inCorner ? "small webcam in a corner over screen content" : `face too small (${Math.round(faceSize * 100)}% of frame height)` };
  }
  // a big speaker beside an app screen / title card (a side-by-side composite): stack the panel on top
  if (opts.panel === false) return { ...base, layout: "face", reason: `face in ${Math.round(faceRatio * 100)}% of frames, ${Math.round(faceSize * 100)}% tall` };
  const found = detectSidePanel(samples);
  if (found.panel) {
    const { panel, ...signals } = found;
    return { ...base, layout: "stack", panel, panelSignals: signals, reason: panelReason(panel, signals) };
  }
  return { ...base, layout: "face", panelSignals: found, reason: `face in ${Math.round(faceRatio * 100)}% of frames, ${Math.round(faceSize * 100)}% tall` };
}

/**
 * The stack decision for one stretch where the panel was on screen. The aggregate rule decides on
 * the whole stretch; when a bridged gap (OCR lost the title for a few seconds) pulls its share under
 * the threshold, the frames that did show the panel decide, with the stretch's own face track.
 */
function panelDecision(inside: FaceSample[], config: Pick<Config, "LAYOUT_MIN_FACE_RATIO" | "LAYOUT_MIN_FACE_SIZE">, cuts: number[]): LayoutDecision {
  const d = decideLayout(inside, config, cuts);
  if (d.panel || d.layout !== "face") return d;
  const found = detectSidePanel(inside.filter((s) => frameVote(s)));
  if (!found.panel) return d;
  const { panel, ...signals } = found;
  return { ...d, layout: "stack", panel, panelSignals: signals, reason: `${panelReason(panel, signals)}; held through a gap in the evidence` };
}

/**
 * Split the two largest faces per frame into a consistent left/right pair by x position so each
 * speaker gets a stable track.
 */
function pairSizes(pair: { a: FaceSample[]; b: FaceSample[] }): [number, number] {
  const sz = (xs: FaceSample[]) => Number(median(xs.filter((s) => s.box).map((s) => s.box!.y2 - s.box!.y1)).toFixed(3));
  return [sz(pair.a), sz(pair.b)];
}

export function assignPair(samples: FaceSample[]): { a: FaceSample[]; b: FaceSample[] } {
  // Keep each speaker by continuity, not by "two largest boxes sorted left to right": a spurious box
  // (a second detection beside one face, a hand) would otherwise outrank the other speaker and swap
  // that crop onto the wrong person for a few frames, then back (a "lazy eye" pan).
  const cx = (bx: FaceBox) => (bx.x1 + bx.x2) / 2;
  const seeds = samples.flatMap((s) => {
    const xs = s.boxes.slice(0, 2).map(cx).sort((p, q) => p - q);
    return xs.length === 2 && xs[1]! - xs[0]! > 0.2 ? [xs as [number, number]] : [];
  });
  let la = seeds.length ? median(seeds.map((x) => x[0])) : 0.33;
  let lb = seeds.length ? median(seeds.map((x) => x[1])) : 0.67;
  const a: FaceSample[] = [];
  const b: FaceSample[] = [];
  for (const s of samples) {
    // every box belongs to the speaker it's nearer to; each speaker keeps its nearest box
    let pa: FaceBox | null = null;
    let pb: FaceBox | null = null;
    for (const bx of s.boxes) {
      const x = cx(bx);
      if (Math.abs(x - la) <= Math.abs(x - lb)) {
        if (!pa || Math.abs(x - la) < Math.abs(cx(pa) - la)) pa = bx;
      } else if (!pb || Math.abs(x - lb) < Math.abs(cx(pb) - lb)) pb = bx;
    }
    if (pa) la = cx(pa);
    if (pb) lb = cx(pb);
    a.push({ t: s.t, box: pa, boxes: [] });
    b.push({ t: s.t, box: pb, boxes: [] });
  }
  return { a, b };
}

/**
 * "Heavy tripod" camera: the crop stays put while the face is inside a dead zone, pans with a
 * capped velocity when it leaves, and snaps instantly at scene cuts (no pan across an edit).
 * Produces one point per sample, normalized coordinates.
 */
export function tripodTrack(
  samples: FaceSample[],
  sceneCuts: number[] = [],
  opts = { deadZone: 0.025, maxSpeed: 0.12, fastThreshold: 0.2, fastSpeed: 0.4, settleSpeed: 0.04 },
): Array<{ t: number; x: number; y: number }> {
  const raw = smoothTrack(samples, 3); // light denoise first (3-sample median-ish average)
  if (!raw.length) return [];
  const out: Array<{ t: number; x: number; y: number }> = [];
  // start where the face sits for the first second, not on one noisy sample
  const head = raw.filter((p) => p.t <= raw[0]!.t + 1);
  const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  let cx = med(head.map((p) => p.x));
  let cy = med(head.map((p) => p.y));
  let prevT = raw[0]!.t;
  let cutIdx = 0;
  const cuts = sceneCuts.slice().sort((p, q) => p - q);
  for (const p of raw) {
    const dt = Math.max(0.001, p.t - prevT);
    // scene cut between prevT and p.t → snap
    let snapped = false;
    while (cutIdx < cuts.length && cuts[cutIdx]! <= p.t) {
      if (cuts[cutIdx]! > prevT) snapped = true;
      cutIdx++;
    }
    if (snapped) {
      cx = p.x;
      cy = p.y;
    } else {
      const dx = p.x - cx;
      const dy = p.y - cy;
      if (Math.abs(dx) > opts.deadZone) {
        const speed = Math.abs(dx) > opts.fastThreshold ? opts.fastSpeed : opts.maxSpeed; // normalized units per second
        const step = Math.min(Math.abs(dx), speed * dt);
        cx += Math.sign(dx) * step;
      } else if (Math.abs(dx) > 0.004) {
        // inside the dead zone: settle onto the face so it ends up centred, too slowly to read as a pan
        cx += Math.sign(dx) * Math.min(Math.abs(dx), opts.settleSpeed * dt);
      }
      if (Math.abs(dy) > opts.deadZone * 1.5) {
        const step = Math.min(Math.abs(dy) - opts.deadZone, opts.maxSpeed * dt);
        cy += Math.sign(dy) * step;
      }
    }
    out.push({ t: p.t, x: Number(cx.toFixed(4)), y: Number(cy.toFixed(4)) });
    prevT = p.t;
  }
  return out;
}

/** One (x, y) per sample, holes filled from neighbours, then a moving average so the crop glides instead of jittering. */
export function smoothTrack(samples: FaceSample[], window = 5): Array<{ t: number; x: number; y: number }> {
  const pts = samples.map((s) => (s.box ? { t: s.t, x: (s.box.x1 + s.box.x2) / 2, y: (s.box.y1 + s.box.y2) / 2 } : { t: s.t, x: NaN, y: NaN }));
  // fill gaps: carry last known, or next known at the start
  let last: { x: number; y: number } | undefined;
  for (const p of pts) {
    if (Number.isNaN(p.x)) {
      if (last) Object.assign(p, last);
    } else last = { x: p.x, y: p.y };
  }
  const firstKnown = pts.find((p) => !Number.isNaN(p.x));
  for (const p of pts) if (Number.isNaN(p.x)) Object.assign(p, firstKnown ?? { x: 0.5, y: 0.5 });
  const half = Math.floor(window / 2);
  return pts.map((p, i) => {
    const slice = pts.slice(Math.max(0, i - half), Math.min(pts.length, i + half + 1));
    return { t: p.t, x: Number((slice.reduce((a, q) => a + q.x, 0) / slice.length).toFixed(4)), y: Number((slice.reduce((a, q) => a + q.y, 0) / slice.length).toFixed(4)) };
  });
}

/**
 * ffmpeg expression for a value that moves piecewise-linearly through `points` over time `t`.
 * Keeps the expression short by keeping only every `step`th point.
 */
export function piecewiseExpr(points: Array<{ t: number; v: number }>, step = 1, maxPoints = 48): string {
  let pts = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  // The tripod keeps the value constant most of the time: collapse runs of (nearly) equal values to
  // their endpoints so a 60 s clip becomes a handful of segments instead of hundreds of nested if()s,
  // which ffmpeg's expression parser rejects.
  const collapsed: typeof pts = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const prev = collapsed[collapsed.length - 1];
    const prev2 = collapsed[collapsed.length - 2];
    if (prev && prev2 && Math.abs(prev.v - p.v) < 0.5 && Math.abs(prev2.v - prev.v) < 0.5) collapsed[collapsed.length - 1] = p; // extend the run
    else collapsed.push(p);
  }
  pts = collapsed;
  // hard cap: keep the expression within what ffmpeg parses comfortably
  if (pts.length > maxPoints) {
    const stride = Math.ceil(pts.length / maxPoints);
    pts = pts.filter((_, i) => i % stride === 0 || i === pts.length - 1);
  }
  if (pts.length === 0) return "0";
  if (pts.length === 1) return pts[0]!.v.toFixed(2);
  // build from the end: if(lt(t,t1), lerp(p0,p1), if(lt(t,t2), lerp(p1,p2), ... vN))
  let expr = pts[pts.length - 1]!.v.toFixed(2);
  for (let i = pts.length - 2; i >= 0; i--) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dt = Math.max(0.001, b.t - a.t);
    const lerp = `(${a.v.toFixed(2)}+(${(b.v - a.v).toFixed(2)})*(t-${a.t.toFixed(2)})/${dt.toFixed(3)})`;
    expr = `if(lt(t\\,${b.t.toFixed(2)})\\,${lerp}\\,${expr})`;
  }
  return expr;
}


// ---------- per-segment layouts ----------

export interface LayoutSegment {
  /** clip-relative seconds */
  start: number;
  end: number;
  decision: LayoutDecision;
}

/**
 * A clip is rarely one shot: a picture-in-picture intro cuts to a talking head, b-roll interrupts a
 * speaker. Split the clip at scene cuts and at changes in face presence, decide the layout for each
 * piece, then merge neighbours that agree. Pieces shorter than `minSeg` fold into their neighbour.
 */
export function segmentLayouts(
  samples: FaceSample[],
  config: Pick<Config, "LAYOUT_MIN_FACE_RATIO" | "LAYOUT_MIN_FACE_SIZE">,
  sceneCuts: number[],
  duration: number,
  minSeg = 2.5,
): LayoutSegment[] {
  if (!samples.length || duration <= 0) return [];
  // per-sample framing state, smoothed over ±2 samples
  const raw = samples.map((s) => {
    const big = !!s.box && s.box.y2 - s.box.y1 >= config.LAYOUT_MIN_FACE_SIZE;
    const two = s.boxes.length >= 2 && s.boxes[1]!.y2 - s.boxes[1]!.y1 >= 0.08;
    return two ? "split" : big ? "face" : "none";
  });
  // a second speaker who briefly disappears (drinks, turns away, leans out) shouldn't flip the
  // layout: "split" holds while two faces were seen in ≥35% of the surrounding ±3 s
  const hold = Math.max(2, Math.round(3 * (samples.length > 1 ? (samples.length - 1) / Math.max(0.01, samples.at(-1)!.t - samples[0]!.t) : 4)));
  const state = raw.map((_, i) => {
    const wide = raw.slice(Math.max(0, i - hold), i + hold + 1);
    if (wide.filter((w) => w === "split").length / wide.length >= 0.35) return "split" as const;
    const win = raw.slice(Math.max(0, i - 2), i + 3);
    const counts = { face: 0, split: 0, none: 0 };
    for (const w of win) counts[w as keyof typeof counts]++;
    return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0]) as "face" | "split" | "none";
  });
  const cuts = sceneCuts.filter((c) => c > 0 && c < duration).sort((a, b) => a - b);
  const bounds = new Set<number>([0, duration, ...cuts]);
  for (let i = 1; i < state.length; i++) {
    if (state[i] === state[i - 1]) continue;
    const t = samples[i]!.t;
    const near = cuts.find((c) => Math.abs(c - t) <= 1.0);
    bounds.add(near ?? t);
  }
  let edges = [...bounds].sort((a, b) => a - b);
  // drop boundaries that would create segments shorter than minSeg
  const kept: number[] = [edges[0]!];
  for (let i = 1; i < edges.length; i++) {
    const e = edges[i]!;
    const isLast = i === edges.length - 1;
    if (e - kept[kept.length - 1]! < minSeg && !isLast) continue;
    if (isLast && e - kept[kept.length - 1]! < minSeg && kept.length > 1) kept.pop();
    kept.push(e);
  }
  edges = kept;
  const runs = panelRuns(samples, duration, cuts);
  const segs: LayoutSegment[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const start = edges[i]!;
    const end = edges[i + 1]!;
    // a panel stack only exists inside the runs where the panel was seen: cut the piece at the run's
    // edges, so a leading or trailing sliver stays the plain face crop (never half the room on top)
    const pieces: Array<{ a: number; b: number; run?: PanelRun }> = [];
    let t = start;
    for (const r of runs) {
      const a = Math.max(r.start, start);
      const b = Math.min(r.end, end);
      if (b - a <= 0.01) continue;
      if (a - t > 0.01) pieces.push({ a: t, b: a });
      pieces.push({ a, b, run: r });
      t = b;
    }
    if (end - t > 0.01) pieces.push({ a: t, b: end });
    for (const p of pieces) {
      const inside = samples.filter((s) => s.t >= p.a && s.t < p.b);
      const near = inside.length ? inside : [samples.reduce((best, s) => (Math.abs(s.t - p.a) < Math.abs(best.t - p.a) ? s : best))];
      const cutsIn = cuts.filter((c) => c > p.a && c < p.b);
      if (p.run) {
        const d = panelDecision(samples.filter((s) => s.t >= p.run!.start && s.t < p.run!.end), config, cuts.filter((c) => c > p.run!.start && c < p.run!.end));
        if (d.panel) {
          const track = d.track.filter((pt) => pt.t >= p.a - 1e-6 && pt.t < p.b);
          segs.push({ start: p.a, end: p.b, decision: { ...d, track: track.length ? track : d.track.slice(0, 1) } });
          continue;
        }
      }
      segs.push({ start: p.a, end: p.b, decision: decideLayout(near, config, cutsIn, { panel: false }) });
    }
  }
  // a short one-face stretch beside a split, where the visible face IS one of the split's speakers
  // (same place, same size), is the same two-person shot with the other speaker momentarily
  // undetected (drinking, turned away): keep it split instead of flipping layouts for a few seconds
  for (let i = 0; i < segs.length; i++) {
    const sg = segs[i]!;
    if (sg.decision.layout === "split" || sg.end - sg.start > 8 || !sg.decision.track.length) continue;
    const nb = [segs[i - 1], segs[i + 1]].find((n) => n?.decision.layout === "split" && n.decision.track2?.length);
    if (!nb) continue;
    const me = trackCenter(sg.decision.track);
    const a = trackCenter(nb.decision.track);
    const b = trackCenter(nb.decision.track2);
    const [sa, sb] = nb.decision.speakerSizes ?? [nb.decision.faceSize, nb.decision.faceSize];
    const same = (c: { x: number }, size: number) => Math.abs(c.x - me.x) < 0.08 && Math.abs(size - sg.decision.faceSize) <= 0.4 * Math.max(size, sg.decision.faceSize);
    if (!same(a, sa) && !same(b, sb)) continue;
    segs[i] = { ...sg, decision: { ...nb.decision, reason: `${nb.decision.reason}; held through ${Math.round(sg.end - sg.start)}s with one speaker undetected` } };
  }
  // merge neighbours with the same layout
  const merged: LayoutSegment[] = [];
  for (const seg of segs) {
    const last = merged[merged.length - 1];
    if (last && sameFraming(last.decision, seg.decision)) {
      last.end = seg.end;
      last.decision = { ...last.decision, track: [...last.decision.track, ...seg.decision.track], track2: last.decision.track2 && seg.decision.track2 ? [...last.decision.track2, ...seg.decision.track2] : last.decision.track2 };
    } else merged.push({ ...seg, decision: { ...seg.decision } });
  }
  return merged;
}

/** Same layout, and for a stack the same panel (a left panel and a right panel are different framings). */
export function sameFraming(a: LayoutDecision, b: LayoutDecision): boolean {
  if (a.layout !== b.layout) return false;
  return (a.panel?.side ?? null) === (b.panel?.side ?? null);
}

/** Re-base track points to a segment's own clock (t = 0 at segment start). */
export function localTrack(track: LayoutDecision["track"], start: number, end: number): LayoutDecision["track"] {
  const pts = track.filter((p) => p.t >= start - 0.01 && p.t <= end + 0.01).map((p) => ({ ...p, t: Math.max(0, p.t - start) }));
  if (!pts.length) {
    const nearest = track.reduce<LayoutDecision["track"][number] | undefined>((best, p) => (!best || Math.abs(p.t - start) < Math.abs(best.t - start) ? p : best), undefined);
    return nearest ? [{ t: 0, x: nearest.x, y: nearest.y }] : [];
  }
  return pts;
}

/** Make a layout chain's internal labels unique so several chains can live in one filtergraph. */
export function suffixLabels(chain: string, suffix: string, input: string): string {
  return chain.replace(/\[([a-z][a-z0-9]*)\]/g, (_m, name: string) => `[${name}_${suffix}]`).replace("[0:v]", input);
}

// ---------- user-forced sections ----------

export type TimelineMode = "auto" | Layout;

/** A clip-relative stretch of time with the framing mode that applies to it. */
export interface TimelinePiece {
  start: number;
  end: number;
  mode: TimelineMode;
  manual: boolean;
  offsetX?: number;
}

/**
 * Cover [0, duration] with the user's sections (clip-relative) and the default mode in the gaps.
 * Later sections win where they overlap; slivers under 0.1 s are dropped.
 */
export function coverTimeline(duration: number, sections: Array<{ start: number; end: number; mode: TimelineMode; offsetX?: number }>, defaultMode: TimelineMode): TimelinePiece[] {
  const clean = sections
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(duration, s.end), mode: s.mode, offsetX: s.offsetX }))
    .filter((s) => s.end - s.start >= 0.1);
  const edges = [...new Set([0, duration, ...clean.flatMap((s) => [s.start, s.end])])].sort((a, b) => a - b);
  const out: TimelinePiece[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i]!;
    const b = edges[i + 1]!;
    if (b - a < 0.1) continue;
    const mid = (a + b) / 2;
    const hit = [...clean].reverse().find((s) => s.start <= mid && s.end >= mid);
    const mode = hit?.mode ?? defaultMode;
    const manual = !!hit && hit.mode !== "auto";
    const offsetX = hit?.offsetX || undefined;
    const last = out[out.length - 1];
    if (last && last.mode === mode && last.manual === manual && last.offsetX === offsetX) last.end = b;
    else out.push({ start: a, end: b, mode, manual, ...(offsetX ? { offsetX } : {}) });
  }
  return out.length ? out : [{ start: 0, end: duration, mode: defaultMode, manual: false }];
}

export function staticDecision(layout: Layout, reason: string): LayoutDecision {
  return { layout, reason, faceRatio: 0, faceSize: 0, track: [], faceCount: 0 };
}

/** Use the detector's tracks but force the layout the user asked for. */
export function forcedDecision(samples: FaceSample[], layout: Layout, config: Pick<Config, "LAYOUT_MIN_FACE_RATIO" | "LAYOUT_MIN_FACE_SIZE">, sceneCuts: number[]): LayoutDecision {
  if (!samples.length || !samples.some((s) => s.box)) return staticDecision(layout === "face" || layout === "split" || layout === "stack" ? "center" : layout, "manual (no face found, centre crop)");
  const base = decideLayout(samples, config, sceneCuts);
  if (layout === "split" && !base.track2) {
    const pair = assignPair(samples);
    return { ...base, layout, reason: "manual", track: tripodTrack(pair.a, sceneCuts), track2: tripodTrack(pair.b, sceneCuts), speakerSizes: pairSizes(pair) };
  }
  // a forced Stack is the whole frame on top: the detected panel only applies to the automatic choice
  return { ...base, layout, reason: "manual", panel: undefined, panelSignals: undefined };
}

function shiftDecision(d: LayoutDecision, by: number): LayoutDecision {
  const sh = (tr: LayoutDecision["track"]) => tr.map((p) => ({ ...p, t: p.t + by }));
  return { ...d, track: sh(d.track), track2: d.track2 ? sh(d.track2) : undefined };
}

export interface ResolvedSegment extends LayoutSegment {
  manual: boolean;
  offsetX?: number;
}

/** Shift a decision's crop horizontally; a static centre crop becomes a fixed crop at 0.5 + offset. */
export function offsetDecision(d: LayoutDecision, offsetX: number | undefined, start: number): LayoutDecision {
  if (!offsetX || d.layout === "fit" || d.layout === "none") return d;
  const sh = (tr: LayoutDecision["track"]) => tr.map((p) => ({ ...p, x: Math.max(0, Math.min(1, p.x + offsetX)) }));
  if (!d.track.length) return { ...d, track: [{ t: start, x: Math.max(0, Math.min(1, 0.5 + offsetX)), y: 0.45 }] };
  return { ...d, track: sh(d.track), track2: d.track2 ? sh(d.track2) : undefined };
}

/**
 * Turn the timeline (auto + forced pieces) into concrete layout segments. Auto pieces are split
 * further by `segmentLayouts`; neighbours with the same layout and origin are merged.
 */
export function resolveSegments(
  pieces: TimelinePiece[],
  samples: FaceSample[],
  config: Pick<Config, "LAYOUT_MIN_FACE_RATIO" | "LAYOUT_MIN_FACE_SIZE">,
  sceneCuts: number[],
  hasDetector: boolean,
): ResolvedSegment[] {
  const out: ResolvedSegment[] = [];
  for (const pc of pieces) {
    const inside = samples.filter((s) => s.t >= pc.start && s.t < pc.end);
    const cutsIn = sceneCuts.filter((c) => c > pc.start && c < pc.end);
    if (pc.mode === "auto") {
      if (!hasDetector) {
        out.push({ start: pc.start, end: pc.end, decision: staticDecision("center", "no face detector"), manual: false });
        continue;
      }
      const local = inside.map((s) => ({ ...s, t: s.t - pc.start }));
      const segs = segmentLayouts(local, config, cutsIn.map((c) => c - pc.start), pc.end - pc.start);
      if (!segs.length) out.push({ start: pc.start, end: pc.end, decision: offsetDecision(inside.length ? decideLayout(inside, config, cutsIn) : staticDecision("fit", "no frames sampled"), pc.offsetX, pc.start), manual: false, offsetX: pc.offsetX });
      for (const sg of segs) out.push({ start: sg.start + pc.start, end: sg.end + pc.start, decision: offsetDecision(shiftDecision(sg.decision, pc.start), pc.offsetX, sg.start + pc.start), manual: false, offsetX: pc.offsetX });
      continue;
    }
    const layout = pc.mode;
    const needsTrack = layout === "face" || layout === "split" || layout === "stack";
    const decision = needsTrack ? (hasDetector ? forcedDecision(inside, layout, config, cutsIn) : staticDecision("center", "manual (no face detector)")) : staticDecision(layout, "manual");
    out.push({ start: pc.start, end: pc.end, decision: offsetDecision(decision, pc.offsetX, pc.start), manual: pc.manual, offsetX: pc.offsetX });
  }
  const merged: ResolvedSegment[] = [];
  for (const seg of out) {
    const last = merged[merged.length - 1];
    if (last && sameFraming(last.decision, seg.decision) && last.manual === seg.manual && last.offsetX === seg.offsetX) {
      last.end = seg.end;
      last.decision = { ...last.decision, track: [...last.decision.track, ...seg.decision.track], track2: last.decision.track2 && seg.decision.track2 ? [...last.decision.track2, ...seg.decision.track2] : last.decision.track2 };
    } else merged.push({ ...seg, decision: { ...seg.decision } });
  }
  return merged;
}

/** Median of a track's x/y for the browser preview. */
export function trackCenter(track: LayoutDecision["track"] | undefined): { x: number; y: number } {
  if (!track?.length) return { x: 0.5, y: 0.45 };
  const xs = track.map((p) => p.x).sort((a, b) => a - b);
  const ys = track.map((p) => p.y).sort((a, b) => a - b);
  return { x: xs[Math.floor(xs.length / 2)]!, y: ys[Math.floor(ys.length / 2)]! };
}

/** ~1 point per second of a track, for the editor preview: [t, x]. */
export function sparseTrack(track: LayoutDecision["track"], start: number, end: number, base: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let last = -Infinity;
  for (const p of track) {
    if (p.t < start - 0.01 || p.t > end + 0.01 || p.t - last < 1) continue;
    out.push([Number((p.t + base).toFixed(2)), Number(p.x.toFixed(3))]);
    last = p.t;
  }
  return out.slice(0, 400);
}

/**
 * Drop "faces" that never move: posters, photos, logos on the wall. UltraFace returns the same box,
 * frame after frame, for a printed face, while a real person drifts and the detector jitters on them.
 * Boxes are clustered by centre across the clip; a cluster seen in enough frames whose centre and
 * size barely vary is treated as static and removed from every sample.
 */
export function dropStaticFaces(samples: FaceSample[], opts = { radius: 0.05, minFrames: 8, maxStd: 0.0025 }): { samples: FaceSample[]; dropped: Array<{ x: number; y: number; frames: number }> } {
  type Cluster = { x: number; y: number; members: FaceBox[] };
  const clusters: Cluster[] = [];
  for (const s of samples)
    for (const b of s.boxes) {
      const cx = (b.x1 + b.x2) / 2;
      const cy = (b.y1 + b.y2) / 2;
      const c = clusters.find((k) => Math.abs(k.x - cx) < opts.radius && Math.abs(k.y - cy) < opts.radius);
      if (c) {
        c.members.push(b);
        c.x += (cx - c.x) / c.members.length;
        c.y += (cy - c.y) / c.members.length;
      } else clusters.push({ x: cx, y: cy, members: [b] });
    }
  const std = (xs: number[]) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const isStatic = new Set<FaceBox>();
  const dropped: Array<{ x: number; y: number; frames: number }> = [];
  for (const c of clusters) {
    if (c.members.length < opts.minFrames) continue;
    const xs = c.members.map((b) => (b.x1 + b.x2) / 2);
    const ys = c.members.map((b) => (b.y1 + b.y2) / 2);
    const hs = c.members.map((b) => b.y2 - b.y1);
    if (std(xs) < opts.maxStd && std(ys) < opts.maxStd && std(hs) < opts.maxStd) {
      for (const b of c.members) isStatic.add(b);
      dropped.push({ x: Number(c.x.toFixed(3)), y: Number(c.y.toFixed(3)), frames: c.members.length });
    }
  }
  if (!isStatic.size) return { samples, dropped };
  const out = samples.map((s) => {
    const boxes = s.boxes.filter((b) => !isStatic.has(b));
    return { ...s, boxes, box: boxes[0] ?? null };
  });
  return { samples: out, dropped };
}

/**
 * Spans where text fills the frame (slides, documents, paragraphs): runs of text-heavy frames at
 * least `minRun` long, snapped to a nearby scene cut so the switch lands on the shot change.
 */
export function textHeavyRuns(frames: Array<{ t: number; textHeavy: boolean }>, fps: number, duration: number, sceneCuts: number[], minRun = 2): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start: number | null = null;
  for (const f of frames) {
    if (f.textHeavy && start === null) start = f.t;
    if (!f.textHeavy && start !== null) {
      runs.push([start, f.t]);
      start = null;
    }
  }
  if (start !== null) runs.push([start, duration]);
  const snap = (t: number) => {
    const c = sceneCuts.find((x) => Math.abs(x - t) <= 1 / fps + 0.25);
    return c ?? t;
  };
  return runs
    .map(([a, b]) => [a <= 1 / fps ? 0 : snap(a), b >= duration - 1 / fps ? duration : snap(b)] as [number, number])
    .filter(([a, b]) => b - a >= minRun);
}

/** Auto segments show text-heavy spans whole (Whole frame) instead of cropping into the text. */
export function fitTextHeavy(segments: ResolvedSegment[], runs: Array<[number, number]>, minPiece = 1.5): ResolvedSegment[] {
  if (!runs.length) return segments;
  const out: ResolvedSegment[] = [];
  for (const sg of segments) {
    // a side panel is already shown whole on top (the text in it is why the frame looks text-heavy)
    if (sg.manual || sg.decision.layout === "fit" || sg.decision.layout === "none" || sg.decision.panel) {
      out.push(sg);
      continue;
    }
    let t = sg.start;
    for (const [a0, b0] of runs) {
      const a = Math.max(a0, sg.start);
      const b = Math.min(b0, sg.end);
      if (b - a < minPiece) continue;
      // a sliver before the run is folded into it rather than becoming its own flash of a crop
      if (a - t >= minPiece) out.push({ ...sg, start: t, end: a });
      const from = a - t < minPiece ? t : a;
      out.push({ start: from, end: b, manual: false, decision: { ...staticDecision("fit", "text fills the frame (slide or document)") } });
      t = b;
    }
    if (sg.end - t >= minPiece) out.push({ ...sg, start: t, end: sg.end });
    else if (out.length) out[out.length - 1]!.end = sg.end;
  }
  return out;
}
