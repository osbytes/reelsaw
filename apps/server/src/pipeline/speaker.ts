/**
 * Active speaker detection for two-person shots: who is talking, when.
 *
 * Primary signal: LR-ASD (vision/asd.ts), a learned audio-visual model that scores, per 25 fps frame,
 * whether a face's mouth is producing the speech heard (it was trained on AVA-ActiveSpeaker, where
 * listeners laugh, nod and drink). Each seat's face is cropped from its smoothed box, scored against the
 * segment's MFCCs, and during speech the seat whose face clearly speaks leads. A visible face that clearly
 * is not speaking while someone talks hands the turn to the other seat, which is how an off-camera
 * interviewer (a seat with no face) gets attributed.
 *
 * Fallback when the model is not loaded or fails: audio-visual synchrony. A talking mouth moves in time
 * with the syllables (the loudness envelope rises and falls ~4-6×/s with the jaw); a mouth that is drinking,
 * chewing or smiling moves without that rhythm. Per frame (10 fps) mouth-region motion is correlated with
 * the audio envelope over a sliding ±1.5 s window and the clearly better correlated face leads. (A first
 * version compared raw mouth motion during speech and followed a speaker who was drinking.)
 *
 * Both share the rest: the leader must lead for 0.6 s to take the turn (a nod or a laugh isn't a turn),
 * otherwise the previous speaker holds, and runs shorter than `minShot` fold into their neighbours.
 *
 * Contract: exactly two speakers at the positions the split layout found. When a third face of
 * comparable size persists (posters and photos excluded), who is talking is ambiguous, so the result is
 * "unsure" (no runs, confidence 0) and the caller keeps its default framing instead of guessing wrong.
 */
import { spawn } from "node:child_process";
import type { FaceDetector, FaceBox } from "../vision/faces.js";
import { ASD_CROP, ASD_FPS, faceCrop, type AsdModel } from "../vision/asd.js";
import { mfcc as mfccOf } from "../audio/mfcc.js";
import { rgbFramesToPipe } from "../media.js";
import { VAD_FRAME_SEC, VAD_SR } from "../audio/vad.js";
import { dropStaticFaces } from "./layout.js";

export interface SpeakerRun {
  start: number;
  end: number;
  /** 0 = speaker A (track), 1 = speaker B (track2) */
  who: 0 | 1;
}

export interface SpeakerTimeline {
  runs: SpeakerRun[];
  /** fraction of speech frames where one speaker clearly led */
  confidence: number;
  frames: number;
  /** which detector produced the runs: the learned model, or the synchrony heuristic */
  method: "model" | "heuristic";
  /** why the model was not used when one was loaded (it failed on this segment) */
  fallback?: string;
}

export interface SpeakerOptions {
  minShot?: number;
  /** source width / height, so face crops keep their proportions (default 16:9) */
  srcAspect?: number;
  /** heuristic: frames per second, correlation margin, correlation window (s) */
  fps?: number;
  margin?: number;
  window?: number;
  /** model: logit lead one face needs over the other when both are visible */
  scoreMargin?: number;
}

type Deps = { faces: FaceDetector; ffmpegPath: string; signal?: AbortSignal; asd?: AsdModel | null };

export async function activeSpeakers(
  deps: Deps,
  source: string,
  /** absolute source seconds */
  start: number,
  duration: number,
  /** normalized x of speaker A and B (from the split decision) */
  speakers: [number, number],
  /** speech probability per VAD frame, for the same range (clip audio sliced to this segment) */
  speechProb: (t: number) => number,
  /** the segment's audio: 16 kHz mono, starting at `start` */
  audio: Float32Array,
  opts: SpeakerOptions = {},
): Promise<SpeakerTimeline> {
  if (deps.asd) {
    try {
      return await modelSpeakers(deps, deps.asd, source, start, duration, speakers, speechProb, audio, opts);
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      const tl = await heuristicSpeakers(deps, source, start, duration, speakers, speechProb, audio, opts);
      return { ...tl, fallback: (err as Error).message.slice(0, 200) };
    }
  }
  return heuristicSpeakers(deps, source, start, duration, speakers, speechProb, audio, opts);
}

// ---------- shared: decoding, seats, the third-face check, turn following ----------

/** Decode size keeping the source's proportions, 480 px tall: the detector and the face crops read the same frame (YuNet takes any size). */
function decodeSize(srcAspect = 16 / 9) {
  const h = 480;
  return { w: Math.max(2, 2 * Math.round((h * srcAspect) / 2)), h };
}

async function decodeFrames(
  deps: Deps,
  source: string,
  start: number,
  duration: number,
  fps: number,
  w: number,
  h: number,
  onFrame: (rgb: Uint8Array, f: number) => Promise<void>,
) {
  const ff = spawn(
    deps.ffmpegPath,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-ss",
      start.toFixed(3),
      "-t",
      duration.toFixed(3),
      "-i",
      source,
      "-vf",
      `fps=${fps},scale=${w}:${h}`,
      ...rgbFramesToPipe,
    ],
    { signal: deps.signal, stdio: ["ignore", "pipe", "ignore"] },
  );
  const frameBytes = w * h * 3;
  let buf = Buffer.alloc(0);
  let f = 0;
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= frameBytes) {
      const rgb = new Uint8Array(buf.subarray(0, frameBytes));
      buf = buf.subarray(frameBytes);
      await onFrame(rgb, f++);
    }
  }
}

/** 16×16 grayscale thumbnail of a face box, to tell a printed face (never changes) from a still person (blinks, breathes, shifts). */
function boxThumb(rgb: Uint8Array, w: number, h: number, b: FaceBox): Uint8Array {
  const out = new Uint8Array(256);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const sx = Math.min(w - 1, Math.max(0, Math.floor((b.x1 + ((x + 0.5) / 16) * (b.x2 - b.x1)) * w)));
      const sy = Math.min(h - 1, Math.max(0, Math.floor((b.y1 + ((y + 0.5) / 16) * (b.y2 - b.y1)) * h)));
      const i = (sy * w + sx) * 3;
      out[y * 16 + x] = (rgb[i]! * 77 + rgb[i + 1]! * 150 + rgb[i + 2]! * 29) >> 8;
    }
  return out;
}

/**
 * A box belongs to a seat when its centre is within a third of the seat separation (capped at 0.12 for far-apart
 * seats) and it is at least half the height of the frame's largest face: a passer-by far behind a speaker, or
 * behind the empty seat of an off-camera interviewer, is not that speaker (YuNet finds such small faces).
 */
function seatBoxes(boxes: FaceBox[], speakers: [number, number]): [FaceBox | null, FaceBox | null] {
  const seatTol = Math.min(0.12, Math.max(0.04, Math.abs(speakers[1] - speakers[0]) / 3));
  const largest = Math.max(0, ...boxes.map((b) => b.y2 - b.y1));
  const near = boxes.filter((b) => b.y2 - b.y1 >= 0.5 * largest);
  const pick = (who: 0 | 1) =>
    near
      .map((bx) => ({ bx, d: Math.abs((bx.x1 + bx.x2) / 2 - speakers[who]) }))
      .filter((x) => x.d < seatTol)
      .sort((p, q) => p.d - q.d)[0]?.bx ?? null;
  return [pick(0), pick(1)];
}

type Detections = { t: number; boxes: FaceBox[]; thumbs: Uint8Array[] };

/**
 * Of the boxes `dropStaticFaces` called static, the ones whose 16×16 thumbnail still changes: over 1 s a
 * still person's face changes by a median of ~9 grey levels per pixel (blinks, breathing, small shifts), a
 * printed face by ~2 (compression noise). Measured on the speakers eval: a still, silent co-host vs a sign
 * on the wall. Clusters are the static boxes grouped by centre (within 0.05, as dropStaticFaces groups them).
 */
function liveStaticFaces(samples: Detections[], isStatic: Set<FaceBox>): Set<FaceBox> {
  type Cluster = { x: number; y: number; seen: Array<{ t: number; b: FaceBox; th: Uint8Array }> };
  const clusters: Cluster[] = [];
  for (const s of samples)
    s.boxes.forEach((b, k) => {
      if (!isStatic.has(b)) return;
      const cx = (b.x1 + b.x2) / 2;
      const cy = (b.y1 + b.y2) / 2;
      let c = clusters.find((q) => Math.abs(q.x - cx) < 0.05 && Math.abs(q.y - cy) < 0.05);
      if (!c) clusters.push((c = { x: cx, y: cy, seen: [] }));
      c.seen.push({ t: s.t, b, th: s.thumbs[k]! });
    });
  const alive = new Set<FaceBox>();
  for (const c of clusters) {
    const diffs: number[] = [];
    for (let i = 0, j = 0; i < c.seen.length; i++) {
      while (j < c.seen.length && c.seen[j]!.t < c.seen[i]!.t + 1) j++;
      if (j >= c.seen.length) break;
      let d = 0;
      for (let p = 0; p < 256; p++) d += Math.abs(c.seen[i]!.th[p]! - c.seen[j]!.th[p]!);
      diffs.push(d / 256);
    }
    diffs.sort((a, b) => a - b);
    if (diffs.length && diffs[Math.floor(diffs.length / 2)]! >= LIVE_CHANGE) for (const x of c.seen) alive.add(x.b);
  }
  return alive;
}

const LIVE_CHANGE = 5; // grey levels per pixel over 1 s; between a printed face (~2) and a still person (~9)

/**
 * True when a third face about as big as the speakers' own, unmatched to either seat, is in at least 30% of
 * the frames. Printed faces (posters, photos, a sign the detector takes for a face) do not count: they never
 * move and never change; a person sitting still does change.
 */
function thirdPersonPresent(samples: Detections[], speakers: [number, number]): boolean {
  if (!samples.length) return false;
  const moving = dropStaticFaces(samples.map((s) => ({ t: s.t, boxes: s.boxes, box: s.boxes[0] ?? null }))).samples;
  // a still person looks static to the box test; keep the "static" faces whose appearance still changes
  const isStatic = new Set(samples.flatMap((s, i) => s.boxes.filter((b) => !moving[i]!.boxes.includes(b))));
  const alive = liveStaticFaces(samples, isStatic);
  let third = 0;
  for (const [i, m] of moving.entries()) {
    const s = { boxes: [...m.boxes, ...samples[i]!.boxes.filter((b) => alive.has(b))] };
    const matched = seatBoxes(s.boxes, speakers).filter((b): b is FaceBox => !!b);
    const seatH = matched.length ? Math.min(...matched.map((m) => m.y2 - m.y1)) : 0;
    if (seatH > 0 && s.boxes.some((bx) => !matched.includes(bx) && bx.y2 - bx.y1 >= 0.6 * seatH)) third++;
  }
  return third >= 0.3 * samples.length;
}

/**
 * Turn following shared by both detectors: during speech, a leader (or -1 for no clear leader) per frame;
 * the leader takes the turn after leading for 0.6 s; runs shorter than `minShot` fold into a neighbour.
 */
function followTurns(
  leader: Array<0 | 1 | -1>,
  speech: boolean[],
  fps: number,
  duration: number,
  minShot: number,
  initial: 0 | 1,
): { runs: SpeakerRun[]; confidence: number } {
  const n = leader.length;
  const who: Array<0 | 1> = [];
  let cur = initial;
  let speechFrames = 0;
  let clear = 0;
  let lead = 0;
  const switchFrames = Math.round(0.6 * fps);
  for (let i = 0; i < n; i++) {
    if (speech[i]) {
      speechFrames++;
      const l = leader[i]!;
      if (l !== -1) clear++;
      if (l !== -1 && l !== cur) {
        lead++;
        if (lead >= switchFrames) {
          cur = l;
          lead = 0;
        }
      } else lead = 0;
    }
    who.push(cur);
  }
  let runs: SpeakerRun[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const last = runs[runs.length - 1];
    if (last && last.who === who[i]) last.end = t + 1 / fps;
    else runs.push({ start: t, end: t + 1 / fps, who: who[i]! });
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < runs.length; i++) {
      if (runs.length > 1 && runs[i]!.end - runs[i]!.start < minShot) {
        const into = i > 0 ? i - 1 : i + 1;
        runs[into]!.start = Math.min(runs[into]!.start, runs[i]!.start);
        runs[into]!.end = Math.max(runs[into]!.end, runs[i]!.end);
        runs.splice(i, 1);
        changed = true;
        break;
      }
    }
    const merged: SpeakerRun[] = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && last.who === r.who) last.end = r.end;
      else merged.push({ ...r });
    }
    runs = merged;
  }
  runs[0]!.start = 0;
  runs[runs.length - 1]!.end = duration;
  return {
    runs: runs.map((r) => ({ ...r, start: Number(r.start.toFixed(2)), end: Number(r.end.toFixed(2)) })),
    confidence: Number((speechFrames ? clear / speechFrames : 0).toFixed(2)),
  };
}

// ---------- the learned model ----------

const SMOOTH = 6; // ±frames of detections a crop's box is the median of (the reference median-filters its tracks)
/**
 * LR-ASD was trained on crops from S3FD boxes; YuNet's are tighter (5-15% shorter than UltraFace's on the same face,
 * and S3FD's run larger still). Scaling the half-size before cropping restores the framing the model knows. On the
 * speakers eval every factor from 1.2 to 1.5 passes all six cases and 1.0-1.1 loses the off-camera interviewer
 * (0.63-0.68); 1.35 is the middle.
 */
const BOX_TO_S3FD = 1.35;
const MIN_TRACK = 13; // shortest stretch of a face worth scoring (~0.5 s)

async function modelSpeakers(
  deps: Deps,
  asd: AsdModel,
  source: string,
  start: number,
  duration: number,
  speakers: [number, number],
  speechProb: (t: number) => number,
  audio: Float32Array,
  opts: SpeakerOptions,
): Promise<SpeakerTimeline> {
  const fps = ASD_FPS;
  const minShot = opts.minShot ?? 2.5; // editors rarely cut to someone for less; folds brief false turns
  const scoreMargin = opts.scoreMargin ?? 1;
  const { w, h } = decodeSize(opts.srcAspect);
  const px = ASD_CROP * ASD_CROP;
  // detections every other frame (the boxes are smoothed over ±SMOOTH frames anyway)
  const det: Array<FaceBox[] | null> = [];
  const thumbs: Array<Uint8Array[] | null> = [];
  const seat: [Array<FaceBox | null>, Array<FaceBox | null>] = [[], []];
  const crops: [Array<Uint8Array | null>, Array<Uint8Array | null>] = [[], []];
  const pending = new Map<number, Uint8Array>(); // frames waiting for the detections after them
  const tmp = new Float32Array(px);
  const cropFrame = (i: number) => {
    const rgb = pending.get(i)!;
    pending.delete(i);
    for (const who of [0, 1] as const) {
      const near: FaceBox[] = [];
      for (let j = Math.max(0, i - SMOOTH); j <= Math.min(det.length - 1, i + SMOOTH); j++) {
        const b = seat[who][j];
        if (b) near.push(b);
      }
      if (!near.length) {
        crops[who][i] = null;
        continue;
      }
      const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
      const cx = med(near.map((b) => ((b.x1 + b.x2) / 2) * w));
      const cy = med(near.map((b) => ((b.y1 + b.y2) / 2) * h));
      const bs = BOX_TO_S3FD * med(near.map((b) => Math.max((b.x2 - b.x1) * w, (b.y2 - b.y1) * h) / 2));
      faceCrop(rgb, w, h, cx, cy, bs, tmp);
      crops[who][i] = Uint8Array.from(tmp);
    }
  };
  await decodeFrames(deps, source, start, duration, fps, w, h, async (rgb, f) => {
    if (f % 2 === 0) {
      const boxes = await deps.faces.detect(rgb, { w, h });
      det[f] = boxes;
      thumbs[f] = boxes.map((b) => boxThumb(rgb, w, h, b));
      const [a, b] = seatBoxes(boxes, speakers);
      seat[0][f] = a;
      seat[1][f] = b;
    } else {
      det[f] = null;
      thumbs[f] = null;
      seat[0][f] = null;
      seat[1][f] = null;
    }
    pending.set(f, rgb);
    const ready = f - SMOOTH;
    if (ready >= 0 && pending.has(ready)) cropFrame(ready);
  });
  for (const i of [...pending.keys()].sort((a, b) => a - b)) cropFrame(i);
  const n = det.length;
  if (n < fps) return { runs: [], confidence: 0, frames: n, method: "model" };
  const samples: Detections[] = det.flatMap((boxes, f) => (boxes ? [{ t: f / fps, boxes, thumbs: thumbs[f]! }] : []));
  if (thirdPersonPresent(samples, speakers)) return { runs: [], confidence: 0, frames: n, method: "model" }; // unsure, not wrong

  const feats = mfccOf(audio, VAD_SR).data;
  const scores: [Float32Array, Float32Array] = [new Float32Array(n).fill(Number.NaN), new Float32Array(n).fill(Number.NaN)];
  for (const who of [0, 1] as const) {
    // score each unbroken stretch of this seat's face
    for (let i = 0; i < n; ) {
      if (!crops[who][i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < n && crops[who][j]) j++;
      if (j - i >= MIN_TRACK) {
        const v = new Float32Array((j - i) * px);
        for (let k = i; k < j; k++) v.set(crops[who][k]!, (k - i) * px);
        const s = await asd.score(v, feats.subarray(i * 4 * 13), j - i);
        scores[who].set(s, i);
      }
      i = j;
    }
  }
  const leader: Array<0 | 1 | -1> = [];
  const speech: boolean[] = [];
  for (let i = 0; i < n; i++) {
    speech.push(speechProb(i / fps) >= 0.5);
    const a = scores[0][i]!;
    const b = scores[1][i]!;
    let l: 0 | 1 | -1 = -1;
    if (Number.isFinite(a) && Number.isFinite(b)) {
      if (Math.max(a, b) > 0 && Math.abs(a - b) >= scoreMargin) l = a > b ? 0 : 1;
    } else if (Number.isFinite(a) || Number.isFinite(b)) {
      // one face visible: on the model's own boundary it speaks (> 0), or it doesn't and the voice is the
      // other seat's (off camera, turned away). Offset thresholds were tried on the eval and did no better.
      const k: 0 | 1 = Number.isFinite(a) ? 0 : 1;
      l = (k === 0 ? a : b) > 0 ? k : ((1 - k) as 0 | 1);
    }
    leader.push(l);
  }
  const firstClear = leader.find((l, i) => speech[i] && l !== -1);
  const { runs, confidence } = followTurns(leader, speech, fps, duration, minShot, firstClear === 1 ? 1 : 0);
  return { runs, confidence, frames: n, method: "model" };
}

// ---------- the synchrony heuristic (fallback) ----------

function regionDiff(cur: Uint8Array, prev: Uint8Array, w: number, h: number, x1n: number, x2n: number, y1n: number, y2n: number): number {
  const x1 = Math.max(0, Math.floor(x1n * w));
  const x2 = Math.min(w, Math.ceil(x2n * w));
  const y1 = Math.max(0, Math.floor(y1n * h));
  const y2 = Math.min(h, Math.ceil(y2n * h));
  let sum = 0;
  let n = 0;
  for (let y = y1; y < y2; y++)
    for (let x = x1; x < x2; x++) {
      sum += Math.abs(cur[y * w + x]! - prev[y * w + x]!);
      n++;
    }
  return n ? sum / n : 0;
}

/**
 * Mouth motion with head motion removed: lower face (mouth, jaw, a little below the chin) minus the
 * upper face (eyes, forehead). Nodding or turning moves both; talking moves the mouth far more.
 */
function mouthMotion(cur: Uint8Array, prev: Uint8Array, w: number, h: number, b: FaceBox): number {
  const fw = b.x2 - b.x1;
  const fh = b.y2 - b.y1;
  const mouth = regionDiff(cur, prev, w, h, b.x1 + fw * 0.15, b.x2 - fw * 0.15, b.y1 + fh * 0.55, b.y2 + fh * 0.1);
  const upper = regionDiff(cur, prev, w, h, b.x1 + fw * 0.15, b.x2 - fw * 0.15, b.y1 + fh * 0.1, b.y1 + fh * 0.45);
  return Math.max(0, mouth - upper);
}

async function heuristicSpeakers(
  deps: Deps,
  source: string,
  start: number,
  duration: number,
  speakers: [number, number],
  speechProb: (t: number) => number,
  audio: Float32Array,
  opts: SpeakerOptions,
): Promise<SpeakerTimeline> {
  const fps = opts.fps ?? 10;
  const minShot = opts.minShot ?? 2.5;
  const margin = opts.margin ?? 0.12;
  const window = opts.window ?? 1.5;
  const { w, h } = decodeSize(opts.srcAspect);
  const act: [number[], number[]] = [[], []];
  const samples: Detections[] = [];
  let prevGray: Uint8Array | null = null;
  await decodeFrames(deps, source, start, duration, fps, w, h, async (rgb, f) => {
    const g = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = (rgb[i * 3]! * 77 + rgb[i * 3 + 1]! * 150 + rgb[i * 3 + 2]! * 29) >> 8;
    const boxes = await deps.faces.detect(rgb, { w, h });
    samples.push({ t: f / fps, boxes, thumbs: boxes.map((b) => boxThumb(rgb, w, h, b)) });
    const seats = seatBoxes(boxes, speakers);
    for (const who of [0, 1] as const) {
      const b = seats[who];
      act[who].push(b && prevGray ? mouthMotion(g, prevGray, w, h, b) : Number.NaN);
    }
    prevGray = g;
  });
  const n = samples.length;
  if (n < fps) return { runs: [], confidence: 0, frames: n, method: "heuristic" };
  if (thirdPersonPresent(samples, speakers)) return { runs: [], confidence: 0, frames: n, method: "heuristic" };
  const envelope = envelopeAt(audio, 0);
  const env = samples.map((s) => envelope(s.t));
  // motion change rate is what tracks syllables; use frame-to-frame motion as is (already a difference)
  const maxLag = Math.round(0.2 * fps); // jaw and sound are not perfectly simultaneous
  const corrLag = (series: number[], i: number, lag: number) => {
    const half = Math.round(window * fps);
    const xs: number[] = [];
    const ys: number[] = [];
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) {
      const k = j + lag;
      if (k < 0 || k >= n || !Number.isFinite(series[j]!)) continue;
      xs.push(series[j]!);
      ys.push(env[k]!);
    }
    if (xs.length < fps) return Number.NaN;
    const mx = xs.reduce((p, q) => p + q, 0) / xs.length;
    const my = ys.reduce((p, q) => p + q, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let k = 0; k < xs.length; k++) {
      sxy += (xs[k]! - mx) * (ys[k]! - my);
      sxx += (xs[k]! - mx) ** 2;
      syy += (ys[k]! - my) ** 2;
    }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : Number.NaN;
  };
  const corrAt = (series: number[], i: number) => {
    let best = Number.NaN;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const c = corrLag(series, i, lag);
      if (Number.isFinite(c) && !(c <= best)) best = c;
    }
    return best;
  };
  const corr: [number[], number[]] = [act[0].map((_, i) => corrAt(act[0], i)), act[1].map((_, i) => corrAt(act[1], i))];
  // start with whoever correlates better over the first seconds
  const early = (k: 0 | 1) =>
    corr[k]
      .slice(0, fps * 3)
      .filter(Number.isFinite)
      .reduce((p, q) => p + q, 0);
  const leader: Array<0 | 1 | -1> = [];
  const speech: boolean[] = [];
  for (let i = 0; i < n; i++) {
    speech.push(speechProb(samples[i]!.t) >= 0.5);
    const a = corr[0][i]!;
    const b = corr[1][i]!;
    const av = Number.isFinite(a) ? a : -1;
    const bv = Number.isFinite(b) ? b : -1;
    leader.push(av - bv >= margin && av > 0.1 ? 0 : bv - av >= margin && bv > 0.1 ? 1 : -1);
  }
  const { runs, confidence } = followTurns(leader, speech, fps, duration, minShot, early(0) >= early(1) ? 0 : 1);
  return { runs, confidence, frames: n, method: "heuristic" };
}

/** speech probability lookup over a VAD probability array starting at `offset` seconds */
export function speechAt(probs: Float32Array, offset: number) {
  return (t: number) => {
    const i = Math.floor((t + offset) / VAD_FRAME_SEC);
    return i >= 0 && i < probs.length ? probs[i]! : 0;
  };
}

/** RMS loudness of 16 kHz PCM in a 100 ms window around (t + offset) seconds */
function envelopeAt(pcm: Float32Array, offset: number) {
  const SR = 16000;
  const half = Math.round(0.05 * SR);
  return (t: number) => {
    const c = Math.round((t + offset) * SR);
    let s = 0;
    let n = 0;
    for (let i = Math.max(0, c - half); i < Math.min(pcm.length, c + half); i++) {
      s += pcm[i]! * pcm[i]!;
      n++;
    }
    return n ? Math.sqrt(s / n) : 0;
  };
}
