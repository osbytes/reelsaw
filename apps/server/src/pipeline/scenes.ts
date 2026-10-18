/**
 * Shot-cut detection from ffmpeg's per-frame scene scores.
 *
 * A fixed threshold (ffmpeg's `select=gt(scene,0.35)`) misses every cut in dark, desaturated or
 * low-contrast footage: in one podcast re-upload hard cuts scored 0.17-0.28 while ordinary frames
 * sat at ~0.0015. Cuts are spikes relative to the local motion level, so: a frame is a cut when its
 * score clears a low absolute floor, is `ratio`× the local median around it, and is the local peak.
 */
/**
 * Provenance of the defaults below: tuned on ONE dark, low-contrast podcast re-upload (cuts 0.17-0.28
 * over a ~0.0015 baseline). The relative-to-local-median rule is general; the numbers are not
 * validated on bright, high-motion footage (sports, vlogs, screencasts), where the baseline is far
 * higher and `SCENE_RATIO` may be too strict or too loose. Do not retune without a fixture: the
 * `scenes` suite needs a bright, high-motion case (see docs/EVALS.md).
 */
/** absolute minimum score (0-1) for a cut */
export const SCENE_FLOOR = 0.1;
/** a cut must score this many times the local median */
export const SCENE_RATIO = 6;
/** epsilon added to the median so a perfectly still shot does not make every blip a cut */
export const SCENE_MEDIAN_EPS = 0.003;

export interface SceneCutOptions {
  /** absolute minimum score (0-1) */
  floor?: number;
  /** score must be this many times the local median (+ a small epsilon) */
  ratio?: number;
  /** half-width (s) of the window for the local median */
  window?: number;
  /** cuts closer than this (s) are merged, keeping the stronger */
  minGap?: number;
}

export function pickSceneCuts(times: number[], scores: number[], opts: SceneCutOptions = {}): number[] {
  const floor = opts.floor ?? SCENE_FLOOR;
  const ratio = opts.ratio ?? SCENE_RATIO;
  const win = opts.window ?? 1;
  const minGap = opts.minGap ?? 0.5;
  const n = Math.min(times.length, scores.length);
  const cuts: Array<{ t: number; s: number }> = [];
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const s = scores[i]!;
    if (s < floor) continue;
    const t = times[i]!;
    while (lo < n && times[lo]! < t - win) lo++;
    if (hi < lo) hi = lo;
    while (hi < n && times[hi]! <= t + win) hi++;
    const local: number[] = [];
    let isPeak = true;
    for (let j = lo; j < hi; j++) {
      if (j === i) continue;
      local.push(scores[j]!);
      if (Math.abs(times[j]! - t) <= 0.4 && scores[j]! > s) isPeak = false;
    }
    if (!isPeak) continue;
    local.sort((a, b) => a - b);
    const med = local.length ? local[Math.floor(local.length / 2)]! : 0;
    if (s < ratio * (med + SCENE_MEDIAN_EPS)) continue;
    const last = cuts[cuts.length - 1];
    if (last && t - last.t < minGap) {
      if (s > last.s) cuts[cuts.length - 1] = { t, s };
      continue;
    }
    cuts.push({ t, s });
  }
  return cuts.map((c) => Number(c.t.toFixed(3)));
}

/** Parse `metadata=print` output: "pts_time:12.3" lines followed by "lavfi.scene_score=0.12". */
export function parseSceneScores(stderrLines: string[]): { times: number[]; scores: number[] } {
  const times: number[] = [];
  const scores: number[] = [];
  let pending: number | undefined;
  for (const line of stderrLines) {
    const t = /pts_time:(\d+(?:\.\d+)?)/.exec(line);
    if (t) {
      pending = Number(t[1]);
      continue;
    }
    const s = /lavfi\.scene_score=(\d+(?:\.\d+)?)/.exec(line);
    if (s && pending !== undefined) {
      times.push(pending);
      scores.push(Number(s[1]));
      pending = undefined;
    }
  }
  return { times, scores };
}
