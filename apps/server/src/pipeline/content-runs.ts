/**
 * Where a content region beside the speaker (app screen, title card) is on screen within a clip. A
 * region stack is only ever applied inside these runs: it never outlives the last frame that showed it, and a region
 * that is on screen for under a segment's minimum is not worth a stack.
 */
import { frameVote, REGION, type RegionSample, type ContentSide } from "./content-region.js";

export interface ContentRun {
  side: ContentSide;
  /** clip-relative seconds, trimmed to the frames where the region vote held (plus one sample) */
  start: number;
  end: number;
  /** sample indices of the first and last voting frame */
  first: number;
  last: number;
  /** median region edge over the run */
  edge: number;
}

export const RUN = {
  /** holes this short inside a run are closed (OCR missing a frame or two) */
  hole: 0.75,
  /** two runs on the same side, same edge, are one region when the gap between them is this short and the divider holds */
  hold: 4,
  /** runs shorter than this are not worth a stack (a region appearing a second before the end stays a face crop) */
  minSec: 2.5,
  /** a run edge snaps to a scene cut this close */
  snap: 0.25,
  /** share of the run's frames that must show the speaker */
  minFace: 0.6,
};

const median = (xs: number[]) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);

/**
 * Runs of voting frames, holes closed, gaps of a few seconds bridged when the divider stays at the
 * region's edge (like a split held through a missed face), trimmed to the last frame that voted and
 * snapped to scene cuts.
 */
export function contentRuns(samples: RegionSample[], duration: number, sceneCuts: number[] = []): ContentRun[] {
  if (!samples.length) return [];
  const dts = samples.slice(1).map((s, i) => s.t - samples[i]!.t).filter((d) => d > 0);
  const dt = dts.length ? median(dts) : 0.25;
  const votes = samples.map((s) => frameVote(s));
  type R = { side: ContentSide; first: number; last: number };
  const runs: R[] = [];
  votes.forEach((v, i) => {
    if (!v) return;
    const cur = runs[runs.length - 1];
    if (cur && cur.side === v.side && samples[i]!.t - samples[cur.last]!.t - dt <= RUN.hole + 1e-6) cur.last = i;
    else runs.push({ side: v.side, first: i, last: i });
  });
  const edgeOf = (r: R) => median(votes.slice(r.first, r.last + 1).flatMap((v) => (v ? [v.edge] : [])));
  const merged: R[] = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.side === r.side) {
      const gap = samples[r.first]!.t - samples[prev.last]!.t - dt;
      const edge = edgeOf(prev);
      if (gap <= RUN.hold && Math.abs(edge - edgeOf(r)) <= REGION.stable) {
        const between = samples.slice(prev.last + 1, r.first);
        const holds = between.filter((s) => s.box && s.divider && s.divider.s >= REGION.dividerMin && Math.abs(s.divider.x - edge) <= 0.03).length;
        if (!between.length || holds / between.length >= 0.6) {
          prev.last = r.last;
          continue;
        }
      }
    }
    merged.push({ ...r });
  }
  const snap = (t: number) => sceneCuts.find((c) => Math.abs(c - t) <= RUN.snap) ?? t;
  const out: ContentRun[] = [];
  for (const r of merged) {
    const inRun = samples.slice(r.first, r.last + 1);
    if (inRun.filter((s) => s.box).length / inRun.length < RUN.minFace) continue;
    const start = r.first === 0 ? 0 : snap(samples[r.first]!.t);
    const end = r.last === samples.length - 1 ? duration : Math.min(duration, snap(samples[r.last]!.t + dt));
    if (end - start < RUN.minSec) continue;
    out.push({ side: r.side, start, end, first: r.first, last: r.last, edge: Number(edgeOf(r).toFixed(3)) });
  }
  return out;
}
