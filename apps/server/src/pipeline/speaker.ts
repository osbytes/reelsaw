/**
 * Active speaker detection for two-person shots: who is talking, when.
 *
 * Signal: audio-visual synchrony. A talking mouth moves in time with the syllables (the loudness
 * envelope rises and falls ~4-6×/s with the jaw); a mouth that is drinking, chewing or smiling moves
 * without that rhythm. Per frame (10 fps) we measure mouth-region motion for each face and, over a
 * sliding ±1.5 s window, correlate each face's motion with the audio envelope. The clearly better
 * correlated face is the speaker; otherwise the previous speaker holds. Runs shorter than `minShot`
 * fold into their neighbours. (A first version compared raw mouth motion during speech and followed
 * a speaker who was drinking: motion magnitude alone can't tell drinking from talking.)
 *
 * Contract: exactly two speakers at the positions the split layout found. When a third face of
 * comparable size persists, who is talking is ambiguous, so the result is "unsure" (no runs,
 * confidence 0) and the caller keeps its default framing instead of guessing wrong.
 * Lightweight stand-in for audio-visual ASD models (TalkNet / Light-ASD; docs/RESEARCH.md B7).
 */
import { spawn } from "node:child_process";
import type { FaceDetector, FaceBox } from "../vision/faces.js";
import { FACE_INPUT_W, FACE_INPUT_H } from "../vision/faces.js";
import { VAD_FRAME_SEC } from "../audio/vad.js";

const W = FACE_INPUT_W * 2; // decode at 640×480: detector gets a 2× downscale, mouths keep detail
const H = FACE_INPUT_H * 2;

export interface SpeakerRun {
  start: number;
  end: number;
  /** 0 = speaker A (track), 1 = speaker B (track2) */
  who: 0 | 1;
}

export interface SpeakerTimeline {
  runs: SpeakerRun[];
  /** fraction of speech frames where one mouth clearly out-moved the other */
  confidence: number;
  frames: number;
}

function downscale2x(rgb: Uint8Array): Uint8Array {
  const out = new Uint8Array(FACE_INPUT_W * FACE_INPUT_H * 3);
  for (let y = 0; y < FACE_INPUT_H; y++)
    for (let x = 0; x < FACE_INPUT_W; x++)
      for (let c = 0; c < 3; c++) {
        const i = ((2 * y) * W + 2 * x) * 3 + c;
        out[(y * FACE_INPUT_W + x) * 3 + c] = (rgb[i]! + rgb[i + 3]! + rgb[i + W * 3]! + rgb[i + W * 3 + 3]!) >> 2;
      }
  return out;
}

function gray(rgb: Uint8Array): Uint8Array {
  const g = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = (rgb[i * 3]! * 77 + rgb[i * 3 + 1]! * 150 + rgb[i * 3 + 2]! * 29) >> 8;
  return g;
}

function regionDiff(cur: Uint8Array, prev: Uint8Array, x1n: number, x2n: number, y1n: number, y2n: number): number {
  const x1 = Math.max(0, Math.floor(x1n * W));
  const x2 = Math.min(W, Math.ceil(x2n * W));
  const y1 = Math.max(0, Math.floor(y1n * H));
  const y2 = Math.min(H, Math.ceil(y2n * H));
  let sum = 0;
  let n = 0;
  for (let y = y1; y < y2; y++)
    for (let x = x1; x < x2; x++) {
      sum += Math.abs(cur[y * W + x]! - prev[y * W + x]!);
      n++;
    }
  return n ? sum / n : 0;
}

/**
 * Mouth motion with head motion removed: lower face (mouth, jaw, a little below the chin) minus the
 * upper face (eyes, forehead). Nodding or turning moves both; talking moves the mouth far more.
 */
function mouthMotion(cur: Uint8Array, prev: Uint8Array, b: FaceBox): number {
  const fw = b.x2 - b.x1;
  const fh = b.y2 - b.y1;
  const mouth = regionDiff(cur, prev, b.x1 + fw * 0.15, b.x2 - fw * 0.15, b.y1 + fh * 0.55, b.y2 + fh * 0.1);
  const upper = regionDiff(cur, prev, b.x1 + fw * 0.15, b.x2 - fw * 0.15, b.y1 + fh * 0.1, b.y1 + fh * 0.45);
  return Math.max(0, mouth - upper);
}

export async function activeSpeakers(
  deps: { faces: FaceDetector; ffmpegPath: string; signal?: AbortSignal },
  source: string,
  /** absolute source seconds */
  start: number,
  duration: number,
  /** normalized x of speaker A and B (from the split decision) */
  speakers: [number, number],
  /** speech probability per VAD frame, for the same range (clip audio sliced to this segment) */
  speechProb: (t: number) => number,
  /** audio loudness (RMS) around segment-relative time t */
  envelope: (t: number) => number,
  opts: { fps?: number; minShot?: number; margin?: number; window?: number } = {},
): Promise<SpeakerTimeline> {
  const fps = opts.fps ?? 10;
  const minShot = opts.minShot ?? 2.5; // editors rarely cut to someone for less; folds brief false turns
  const margin = opts.margin ?? 0.12;
  const window = opts.window ?? 1.5;
  const frameBytes = W * H * 3;
  const ff = spawn(deps.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", source, "-vf", `fps=${fps},scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { signal: deps.signal, stdio: ["ignore", "pipe", "ignore"] });
  const act: [number[], number[]] = [[], []];
  // a box belongs to a speaker when its centre is within a third of the seat separation (capped at
  // 0.12 for far-apart seats, so close-seated pairs get a tighter, non-overlapping tolerance)
  const seatTol = Math.min(0.12, Math.max(0.04, Math.abs(speakers[1] - speakers[0]) / 3));
  let thirdFrames = 0;
  const times: number[] = [];
  let prevGray: Uint8Array | null = null;
  let buf = Buffer.alloc(0);
  let f = 0;
  for await (const chunk of ff.stdout) {
    buf = Buffer.concat([buf, chunk as Buffer]);
    while (buf.length >= frameBytes) {
      const rgb = new Uint8Array(buf.subarray(0, frameBytes));
      buf = buf.subarray(frameBytes);
      const g = gray(rgb);
      const boxes = await deps.faces.detect(downscale2x(rgb));
      const t = f / fps;
      times.push(t);
      const matched: FaceBox[] = [];
      for (const who of [0, 1] as const) {
        // the box nearest this speaker's usual position (ignores posters and passers-by)
        const b = boxes.map((bx) => ({ bx, d: Math.abs((bx.x1 + bx.x2) / 2 - speakers[who]) })).filter((x) => x.d < seatTol).sort((p, q) => p.d - q.d)[0]?.bx;
        if (b) matched.push(b);
        act[who].push(b && prevGray ? mouthMotion(g, prevGray, b) : NaN);
      }
      // a third face about as big as the speakers' own, unmatched to either seat
      const seatH = matched.length ? Math.min(...matched.map((m) => m.y2 - m.y1)) : 0;
      if (seatH > 0 && boxes.some((bx) => !matched.includes(bx) && bx.y2 - bx.y1 >= 0.6 * seatH)) thirdFrames++;
      prevGray = g;
      f++;
    }
  }
  const n = times.length;
  if (n < fps) return { runs: [], confidence: 0, frames: n };
  if (thirdFrames >= 0.3 * n) return { runs: [], confidence: 0, frames: n }; // more than two people: unsure, not wrong
  const env = times.map((t) => envelope(t));
  // motion change rate is what tracks syllables; use frame-to-frame motion as is (already a difference)
  const maxLag = Math.round(0.2 * fps); // jaw and sound are not perfectly simultaneous
  const corrAt = (series: number[], i: number) => {
    let best = NaN;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const c = corrLag(series, i, lag);
      if (Number.isFinite(c) && !(c <= best)) best = c;
    }
    return best;
  };
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
    if (xs.length < fps) return NaN;
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
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  };
  const who: Array<0 | 1> = [];
  const corr: [number[], number[]] = [act[0].map((_, i) => corrAt(act[0], i)), act[1].map((_, i) => corrAt(act[1], i))];
  // start with whoever correlates better over the first seconds
  const early = (k: 0 | 1) => corr[k].slice(0, fps * 3).filter(Number.isFinite).reduce((p, q) => p + q, 0);
  let cur: 0 | 1 = early(0) >= early(1) ? 0 : 1;
  let speechFrames = 0;
  let clear = 0;
  let lead = 0;
  let challenger: 0 | 1 | -1 = -1;
  const switchFrames = Math.round(0.6 * fps);
  for (let i = 0; i < n; i++) {
    if (speechProb(times[i]!) >= 0.5) {
      speechFrames++;
      const a = corr[0][i]!;
      const b = corr[1][i]!;
      const av = Number.isFinite(a) ? a : -1;
      const bv = Number.isFinite(b) ? b : -1;
      const leader: 0 | 1 | -1 = av - bv >= margin && av > 0.1 ? 0 : bv - av >= margin && bv > 0.1 ? 1 : -1;
      if (leader !== -1) clear++;
      // switch only after the other speaker has led for a while (a nod or a laugh isn't a turn)
      if (leader !== -1 && leader !== cur) {
        challenger = challenger === leader ? challenger : leader;
        lead++;
        if (lead >= switchFrames) {
          cur = leader;
          lead = 0;
        }
      } else lead = 0;
    }
    who.push(cur);
  }
  // runs, then fold short ones into the previous speaker
  let runs: SpeakerRun[] = [];
  for (let i = 0; i < n; i++) {
    const t = times[i]!;
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
  return { runs: runs.map((r) => ({ ...r, start: Number(r.start.toFixed(2)), end: Number(r.end.toFixed(2)) })), confidence: Number((speechFrames ? clear / speechFrames : 0).toFixed(2)), frames: n };
}

/** speech probability lookup over a VAD probability array starting at `offset` seconds */
export function speechAt(probs: Float32Array, offset: number) {
  return (t: number) => {
    const i = Math.floor((t + offset) / VAD_FRAME_SEC);
    return i >= 0 && i < probs.length ? probs[i]! : 0;
  };
}

/** RMS loudness of 16 kHz PCM in a 100 ms window around (t + offset) seconds */
export function envelopeAt(pcm: Float32Array, offset: number) {
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
