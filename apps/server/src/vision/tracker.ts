/**
 * Face identity across the sampled frames of one clip: each detection gets a `track` id that stays
 * with the same person from frame to frame. Detections are associated with the existing tracks by
 * overlap with each track's predicted box (constant velocity, an alpha-beta filter on centre and size),
 * greedily, best match first; a detection no track claims starts a new one, and a track unseen for
 * `maxGapSec` ends. The gate is strict on purpose: a cut to another person, or a jump the face could
 * not make in one sample, starts a new track instead of linking two people, so consumers can treat
 * "same id" as "same face, moved" (`assignPair`, `trackBreaks`, `dropStaticFaces` in pipeline/layout.ts).
 */
import { iou, type FaceBox } from "./faces.js";

interface Track {
  id: number;
  /** centre and size, normalized */
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  lastT: number;
  hits: number;
}

export interface TrackerOptions {
  /** a track unseen for longer ends (seconds) */
  maxGapSec?: number;
  /** least overlap between a detection and a track's predicted box */
  minIou?: number;
  /** largest centre step between two consecutive sightings, as a multiple of the face width */
  maxStep?: number;
  /** filter gains: position, velocity */
  alpha?: number;
  beta?: number;
}

export interface FaceTracker {
  /** assign ids to one frame's boxes (in place, `box.track`), frames in time order */
  update(t: number, boxes: FaceBox[]): FaceBox[];
}

export function createFaceTracker(opts: TrackerOptions = {}): FaceTracker {
  const maxGap = opts.maxGapSec ?? 1;
  const minIou = opts.minIou ?? 0.3;
  const maxStep = opts.maxStep ?? 0.6;
  const alpha = opts.alpha ?? 0.7;
  const beta = opts.beta ?? 0.3;
  let tracks: Track[] = [];
  let next = 1;

  return {
    update(t, boxes) {
      tracks = tracks.filter((k) => t - k.lastT <= maxGap + 1e-9);
      const predicted = tracks.map((k) => {
        const dt = t - k.lastT;
        const x = k.x + k.vx * dt;
        const y = k.y + k.vy * dt;
        return { x1: x - k.w / 2, x2: x + k.w / 2, y1: y - k.h / 2, y2: y + k.h / 2, x, y };
      });
      const pairs: Array<{ ti: number; bi: number; o: number }> = [];
      boxes.forEach((b, bi) => {
        const bx = (b.x1 + b.x2) / 2;
        const by = (b.y1 + b.y2) / 2;
        const bw = b.x2 - b.x1;
        const bh = b.y2 - b.y1;
        tracks.forEach((k, ti) => {
          const p = predicted[ti]!;
          const o = iou(p, b);
          if (o < minIou) return;
          if (Math.hypot(bx - p.x, by - p.y) > maxStep * Math.max(bw, k.w)) return;
          if (bh > 1.5 * k.h || bh < k.h / 1.5) return;
          pairs.push({ ti, bi, o });
        });
      });
      pairs.sort((a, b) => b.o - a.o);
      const usedT = new Set<number>();
      const usedB = new Set<number>();
      for (const { ti, bi } of pairs) {
        if (usedT.has(ti) || usedB.has(bi)) continue;
        usedT.add(ti);
        usedB.add(bi);
        const k = tracks[ti]!;
        const p = predicted[ti]!;
        const b = boxes[bi]!;
        const dt = Math.max(1e-3, t - k.lastT);
        const mx = (b.x1 + b.x2) / 2;
        const my = (b.y1 + b.y2) / 2;
        k.x = p.x + alpha * (mx - p.x);
        k.y = p.y + alpha * (my - p.y);
        k.vx += (beta * (mx - p.x)) / dt;
        k.vy += (beta * (my - p.y)) / dt;
        k.w += alpha * (b.x2 - b.x1 - k.w);
        k.h += alpha * (b.y2 - b.y1 - k.h);
        k.lastT = t;
        k.hits++;
        b.track = k.id;
      }
      boxes.forEach((b, bi) => {
        if (usedB.has(bi)) return;
        const id = next++;
        tracks.push({ id, x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2, w: b.x2 - b.x1, h: b.y2 - b.y1, vx: 0, vy: 0, lastT: t, hits: 1 });
        b.track = id;
      });
      return boxes;
    },
  };
}

/** Assign track ids to a whole run of samples (frames in time order), in place. */
export function trackFaces<S extends { t: number; boxes: FaceBox[] }>(samples: S[], opts?: TrackerOptions): S[] {
  const tracker = createFaceTracker(opts);
  for (const s of samples) tracker.update(s.t, s.boxes);
  return samples;
}
