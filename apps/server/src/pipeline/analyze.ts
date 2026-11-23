import { and, eq, asc, inArray, isNull, sql } from "drizzle-orm";
import { finalizeProjectIfDone, lockProjectClips, requestPrepare } from "./lifecycle.js";
import { needsPrepare } from "./manual.js";
import { sceneScanCpu } from "../resources.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { randomUUID } from "node:crypto";
import { schema, type Db, type Project } from "../db/index.js";
import {
  NonRetryableError,
  ProjectGoneError,
  type StageContext,
  StageTimeoutError,
  StaleJobError,
  lockCurrentStage,
  modelsUsed,
  stageElapsed,
} from "./common.js";
import {
  MAP_PROMPT_VERSION,
  SCORE_PROMPT_VERSION,
  aggregateScores,
  chunkTranscript,
  excludeRanges,
  mapChunk,
  needsSecondLook,
  pairwiseRank,
  scoreBatches,
  scoreItem,
  scoreSample,
  type LlmOpts,
  type ScoreInput,
  type ScoreResult,
  type SelectContext,
  distinctTitles,
} from "./select.js";
import { isAbortError } from "./steps.js";
import { isSelfHostedModel } from "../ai/self-hosted.js";
import { RANGE_PAD_SEC, clipCandidateSchema, formatTime, plural, processedEndSec, spansSec } from "@reelsaw/shared";
import { z } from "zod";
import { QUEUES } from "../queue/boss.js";
import type { ClipCandidate, ProjectSettings, TranscriptSegment, Word } from "@reelsaw/shared";
import { finishThought, sentenceRules, type SentenceRules } from "./thought.js";
import type { Logger } from "../log.js";
import { bumpersForNewClip, layersForNewClip, templateForNewClips } from "../library/templates.js";
import { syncClipsRefs } from "../library/refs.js";
import { languageCode, outputLanguage } from "./language.js";

export { normalizeCandidate, parseClipsLeniently } from "./select.js";

/** Hard ceiling when the user did not set one: never more clips than the video can hold. */
export function clipCap(settings: ProjectSettings, durationSec: number) {
  if (settings.maxClips) return settings.maxClips;
  return Math.max(1, Math.min(40, Math.floor(durationSec / Math.max(15, settings.minClipSeconds))));
}

/** The old fixed cutoff, kept as `ANALYZE_SCORE_RULE=absolute` for comparison. */
export const AUTO_MIN_SCORE = 45;

export interface ScoreGateOpts {
  rule: "relative" | "absolute";
  /** relative: never keep below this (rubric total; 25 ≈ the prompt's "2- = should not be posted") */
  floor: number;
  /** relative: how many MADs below the median still counts as a keeper */
  k: number;
}

export interface ScoreGate {
  rule: "relative" | "absolute";
  /** effective cutoff on the rubric total; the leader is kept even below it */
  threshold: number;
  n: number;
  median: number | null;
  mad: number | null;
  floor: number;
  k: number;
  /** per input total, in input order */
  keep: boolean[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length ? (s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2) : 0;
};

/**
 * Auto mode drops weak picks, but never everything (the leader always stays).
 *
 * Pointwise LLM scores do not transfer across judges: the same clips get 20-40 from a stingy model
 * and 60-95 from a generous one (and admins swap the model at runtime). A fixed cutoff therefore
 * empties projects under the first and keeps every weak clip under the second. The relative rule
 * is a robust z-score on this run's pooled totals: drop what sits more than k·MAD below the median.
 * It is invariant to any shift or stretch of the judge's scale, so the count follows the shape of
 * the distribution, not the judge's calibration. `floor` keeps one absolute anchor: a total under
 * it means the judge called the clip unpostable, which no amount of relativity should rescue.
 * (A fraction-of-the-top rule was rejected: it is not shift-invariant, and one generous outlier
 * at the top drops everything else.) Pure, for the selection eval.
 */
export function scoreGate(totals: number[], o: ScoreGateOpts): ScoreGate {
  const n = totals.length;
  const best = n ? Math.max(...totals) : 0;
  const leader = totals.indexOf(best);
  if (o.rule === "absolute")
    return {
      rule: "absolute",
      threshold: AUTO_MIN_SCORE,
      n,
      median: null,
      mad: null,
      floor: o.floor,
      k: o.k,
      keep: totals.map((t, i) => i === leader || t >= AUTO_MIN_SCORE),
    };
  const med = median(totals);
  // Rubric totals cluster on a few values (a local judge gives most candidates the same total), so the
  // MAD can be 0 and the threshold would collapse to the median, dropping half of an evenly good
  // pool. A floor on the spread keeps ties together: MIN_MAD is one rubric step on the 0-100 total.
  const mad = Math.max(median(totals.map((t) => Math.abs(t - med))), MIN_MAD);
  const threshold = Number(Math.max(o.floor, med - o.k * mad).toFixed(1));
  return { rule: "relative", threshold, n, median: med, mad, floor: o.floor, k: o.k, keep: totals.map((t, i) => i === leader || t >= threshold) };
}

/** Smallest spread the relative gate assumes (one rubric step on the 0-100 total): see scoreGate. */
const MIN_MAD = 5;

/** When fewer than this many scored clips survive the gate, unscored candidates may fill in. */
const TINY_POOL = 3;

/**
 * Sentence-snap tolerance from the transcript's own rhythm: 0.4 × the median segment length, in
 * [1, 4] s (≈2.5 s on podcasts with 6-7 s sentences, tighter on fast-cut speech). 2.5 s without segments.
 */
export function snapTolerance(segments: TranscriptSegment[]) {
  const d = segments.map((s) => s.end - s.start).filter((x) => x > 0);
  if (!d.length) return 2.5;
  return Math.max(1, Math.min(4, 0.4 * median(d)));
}

function overlapRatio(a: { startSec: number; endSec: number }, b: { startSec: number; endSec: number }) {
  const inter = Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
  const shortest = Math.min(a.endSec - a.startSec, b.endSec - b.startSec);
  return shortest > 0 ? inter / shortest : 0;
}

function nearest(values: number[], target: number, tolerance: number): number | undefined {
  let best: number | undefined;
  let bestDist = tolerance;
  for (const v of values) {
    const d = Math.abs(v - target);
    if (d <= bestDist) {
      best = v;
      bestDist = d;
    }
  }
  return best;
}

/**
 * The breathing room around a clip (and a scene cut it snapped to) stays in the gap between words: it never
 * reaches the next sentence's first word or the previous one's last. A fast talker starts the next word within
 * the 0.35 s end pad, and clips ended on the opening words of the next sentence ("If you",
 * "To have", "Does that"). `speech` is the span the clip is about; a padded
 * edge is pulled back to `GAP_MARGIN` short of the neighbouring word, never inside `speech`.
 */
const GAP_MARGIN = 0.05;
export function padWithinGaps(
  words: ReadonlyArray<{ start: number; end: number }>,
  padded: { start: number; end: number },
  speech: { start: number; end: number },
): { start: number; end: number } {
  let { start, end } = padded;
  const next = words.find((w) => w.start >= speech.end - 0.01);
  if (next && next.start < end + GAP_MARGIN) end = Math.max(speech.end, next.start - GAP_MARGIN);
  const prev = words.findLast((w) => w.end <= speech.start + 0.01);
  if (prev && prev.end > start - GAP_MARGIN) start = Math.min(speech.start, prev.end + GAP_MARGIN);
  return { start, end };
}

/** A range's sentences with the padding around it (docs/specs/range-clipping.md): a clip snapped to them stays inside. */
function rangeSegments(segments: TranscriptSegment[], r: { startSec: number; endSec: number }): TranscriptSegment[] {
  return segments.filter((sg) => sg.start >= r.startSec - RANGE_PAD_SEC - 0.05 && sg.end <= r.endSec + RANGE_PAD_SEC + 0.05);
}

/**
 * The range a candidate belongs to: the one it overlaps most (a range shorter than the shortest clip holds a clip that
 * runs on into its padding, so its middle can be past the range's end). Undefined when it overlaps none.
 */
function rangeOverlapping<R extends { startSec: number; endSec: number }>(ranges: readonly R[], c: { startSec: number; endSec: number }): R | undefined {
  let best: R | undefined;
  let most = 0;
  for (const r of ranges) {
    const o = Math.min(c.endSec, r.endSec) - Math.max(c.startSec, r.startSec);
    if (o > most) [best, most] = [r, o];
  }
  return best;
}

/**
 * A candidate picked in a project's find ranges, snapped to the sentences of the range it overlaps most (with its
 * padding), so it never reaches into time no range asked for; null when it overlaps no range or does not fit one.
 */
export function snapInRanges<R extends { startSec: number; endSec: number }>(
  c: ClipCandidate,
  ranges: readonly R[],
  segments: TranscriptSegment[],
  sceneCuts: number[],
  settings: ProjectSettings,
  endSec: number,
  thought: Parameters<typeof snapCandidate>[5] = {},
): { c: ClipCandidate; range: R } | null {
  const range = rangeOverlapping(ranges, c);
  if (!range) return null;
  // the snapper keeps a start it finds no sentence near, so a proposal that only grazes the range is cut to it (and its
  // padding) first, and whatever still reaches past the padding after snapping is dropped
  const lo = Math.max(0, range.startSec - RANGE_PAD_SEC);
  const hi = Math.min(endSec, range.endSec + RANGE_PAD_SEC);
  const within = { ...c, startSec: Math.max(c.startSec, lo), endSec: Math.min(c.endSec, hi) };
  const snapped = snapCandidate(within, rangeSegments(segments, range), sceneCuts, settings, hi, thought);
  return snapped && snapped.startSec >= lo - 0.3 && snapped.endSec <= hi + 0.4 ? { c: snapped, range } : null;
}

/**
 * An exact clip range's bounds: its ends snapped to the nearest sentences inside its padding (any length: the range is
 * the clip), or the range as given when its padding holds no sentence to snap to.
 */
export function exactRangeBounds(
  r: { startSec: number; endSec: number },
  segments: TranscriptSegment[],
  sceneCuts: number[],
  settings: ProjectSettings,
  endSec: number,
  words?: Word[],
): ClipCandidate {
  const raw: ClipCandidate = { title: "", hook: "", startSec: r.startSec, endSec: r.endSec, score: 50, reasoning: "", caption: "", hashtags: [] };
  const lenient = { ...settings, minClipSeconds: 1, maxClipSeconds: Math.max(settings.maxClipSeconds, r.endSec - r.startSec + 2 * RANGE_PAD_SEC) };
  return snapCandidate(raw, rangeSegments(segments, r), sceneCuts, lenient, Math.min(endSec, r.endSec + RANGE_PAD_SEC), words ? { words } : {}) ?? raw;
}

export function snapCandidate(
  c: ClipCandidate,
  segments: TranscriptSegment[],
  sceneCuts: number[],
  settings: ProjectSettings,
  durationSec: number,
  thought: { words?: Word[]; log?: Logger; bounds?: [number, number]; rules?: SentenceRules } = {},
): ClipCandidate | null {
  const starts = segments.map((s) => s.start);
  const ends = segments.map((s) => s.end);
  // Snap to sentence boundaries. Long sentences (6-7 s in podcasts) often leave the model's pick
  // further than the tolerance from any boundary; then use the sentence it falls inside: start at its start,
  // end at its end (extending), or at the previous sentence end if extending would break the max.
  const tol = snapTolerance(segments);
  const inside = (t: number) => segments.find((sg) => t > sg.start && t < sg.end);
  let start = nearest(starts, c.startSec, tol) ?? inside(c.startSec)?.start ?? c.startSec;
  let end = nearest(ends, c.endSec, tol) ?? c.endSec;
  if (nearest(ends, c.endSec, tol) === undefined) {
    const sg = inside(c.endSec);
    const prevEnd = ends.filter((e) => e <= c.endSec).pop();
    if (sg) end = sg.end - start <= settings.maxClipSeconds || prevEnd === undefined ? sg.end : prevEnd;
    // in a pause or after the last sentence (outro music): end with the last thing said
    else if (prevEnd !== undefined && prevEnd > start) end = prevEnd;
  }
  // where the speech starts and ends; the padding and scene snapping below go around it
  let speechStart = start;
  let speechEnd = end;
  // scene cuts within 0.6s make cleaner edits than mid-shot cuts
  const sc = nearest(sceneCuts, start, 0.6);
  if (sc !== undefined && sc <= start) start = sc;
  const ec = nearest(sceneCuts, end, 0.6);
  if (ec !== undefined && ec >= end) end = ec;
  // breathing room
  start = Math.max(0, start - 0.25);
  end = Math.min(durationSec || end + 0.35, end + 0.35);

  if (end - start > settings.maxClipSeconds) {
    // trim to the last sentence end that fits
    const limit = start + settings.maxClipSeconds;
    const fit = ends.filter((e) => e <= limit && e > start + settings.minClipSeconds).pop();
    if (fit === undefined) return null;
    speechEnd = fit;
    end = fit + 0.35;
  }
  if (end - start < settings.minClipSeconds) {
    // too short: grow forward to the first sentence end that satisfies the minimum (small models
    // often pick a single punchy sentence); then backwards if the video ran out
    const grown = ends.find((e) => e - start >= settings.minClipSeconds && e - start <= settings.maxClipSeconds);
    if (grown !== undefined) {
      speechEnd = grown;
      end = Math.min(durationSec || grown + 0.35, grown + 0.35);
    } else {
      const back = starts.filter((st) => end - st >= settings.minClipSeconds && end - st <= settings.maxClipSeconds).pop();
      if (back === undefined) return null;
      speechStart = back;
      start = Math.max(0, back - 0.25);
    }
  }
  // Segment boundaries are not sentence boundaries (the STT gives no punctuation and segments are
  // capped at 28 words), so growing/trimming above can land mid-sentence. Last step, with the
  // padding taken off and put back: a clip ends on a complete thought.
  if (thought.words?.length) {
    const PAD_START = 0.25;
    const PAD_END = 0.35;
    const done = finishThought(thought.words, start + PAD_START, end - PAD_END, {
      minSec: settings.minClipSeconds - PAD_START - PAD_END,
      maxSec: settings.maxClipSeconds - PAD_START - PAD_END,
      bounds: thought.bounds ? [thought.bounds[0] + PAD_START, thought.bounds[1] - PAD_END] : undefined,
      ...(thought.rules ? { rules: thought.rules } : {}),
    });
    for (const ch of done.changes) {
      thought.log?.debug(
        {
          edge: ch.edge,
          from: Number(ch.from.toFixed(2)),
          to: ch.to === undefined ? null : Number(ch.to.toFixed(2)),
          action: ch.action,
          reason: ch.reason,
          title: c.title.slice(0, 60),
        },
        ch.action === "left" ? `clip ${ch.edge} left inside a sentence` : `clip ${ch.edge} moved to finish the sentence`,
      );
    }
    if (done.changes.some((ch) => ch.action !== "left")) {
      speechStart = done.start;
      speechEnd = done.end;
      start = Math.max(0, done.start - PAD_START);
      end = Math.min(durationSec || done.end + PAD_END, done.end + PAD_END);
    }
    const fit = padWithinGaps(thought.words, { start, end }, { start: speechStart, end: speechEnd });
    if (fit.start !== start || fit.end !== end)
      thought.log?.debug(
        {
          from: [Number(start.toFixed(2)), Number(end.toFixed(2))],
          to: [Number(fit.start.toFixed(2)), Number(fit.end.toFixed(2))],
          title: c.title.slice(0, 60),
        },
        "clip padding kept out of the neighbouring words",
      );
    ({ start, end } = fit);
  }
  return { ...c, startSec: Number(start.toFixed(2)), endSec: Number(end.toFixed(2)) };
}

/** Where one model-proposed moment ended up (indices refer to the candidates array). */
interface CandidateFate {
  i: number;
  chunk: number;
  title: string;
  proposed: [number, number];
  snapped?: [number, number];
  modelScore: number;
  reasoning: string;
  total?: number;
  /** null: scoring failed for it; its map-pass guess is never compared with rubric totals */
  scores?: Record<string, unknown> | null;
  rank?: number;
  overlaps?: number;
  clipId?: string;
  clipIndex?: number;
  /** kept-overlap: covers a clip the user kept through a re-analyze */
  keptClipId?: string;
  outcome: "unusable" | "overlap" | "kept-overlap" | "pool-cap" | "off-topic" | "weak" | "clip-cap" | "chosen";
}

/** Transcript text inside a candidate, for scoring and pairwise prompts. */
function textFor(c: ClipCandidate, segments: TranscriptSegment[]) {
  return segments
    .filter((s) => s.end > c.startSec + 0.1 && s.start < c.endSec - 0.1)
    .map((s) => s.text.trim())
    .join(" ")
    .slice(0, 2500);
}

/** Bump when the shot-cut detector's behaviour changes: the saved scene-cuts step stops applying. */
const SCENE_CUTS_VERSION = "scenes-1";

/**
 * The source's shot cuts, detected once per project and kept on the transcript: clip boundaries snap to
 * them, the layout changes at them and the on-screen text scan reads shots from them. Every project gets them
 * (the scenes refine step, opt-in, only adds the text scan on top). It is a full low-resolution decode of the
 * video: seconds on a fast machine, several minutes for an hour of video on a small CPU, so it is a checkpointed
 * step of its own (the cuts live in `transcripts.sceneCuts`; the step row records the outcome and time).
 * Null means never detected (an older project, an imported report, a re-transcribed one): detect now. A detection
 * that fails inside ffmpeg throws (the step records it failed and the stage retries); only a decode that ran and found
 * nothing stores `[]`, and one that was cancelled or timed out stores nothing.
 */
export async function ensureSceneCuts(ctx: StageContext, project: Project, stored: number[] | null): Promise<number[]> {
  if (stored) return stored;
  if (!project.width || !project.sourceKey) return [];
  if (ctx.stage === "analyze") await ctx.progress(0.01, "Detecting shot changes"); // the refine stage reports its own steps
  const detect = async (signal: AbortSignal): Promise<number> => {
    const sourcePath = await ctx.wholeSource(project);
    const cuts = await ctx.svc.resources.withCpu(
      {
        kind: "scene-scan",
        cpu: sceneScanCpu(ctx.svc.config.SCENE_SCAN_THREADS),
        ids: ctx.leaseIds(),
      },
      (threads) => ctx.svc.media.detectScenes(sourcePath, { signal, threads }),
    );
    signal.throwIfAborted(); // detectScenes answers [] when it was stopped: that is not "no cuts"
    // saved the moment they are found, in a unit of their own: a later step of this stage timing out loses nothing
    await ctx.svc.tx(async (u) => {
      const [t] = await u.db
        .select({ id: schema.transcripts.projectId })
        .from(schema.transcripts)
        .where(eq(schema.transcripts.projectId, ctx.projectId))
        .for("update"); // transcript, then project
      if (!t) return;
      if (!(await lockCurrentStage(u.db, ctx.projectId, ctx.seq))) throw new StaleJobError(ctx.projectId, ctx.seq);
      await u.db.update(schema.transcripts).set({ sceneCuts: cuts }).where(eq(schema.transcripts.projectId, ctx.projectId));
    });
    ctx.log.info({ cuts: cuts.length, first: cuts.slice(0, 12).map((c) => Number(c.toFixed(1))) }, "shot cuts detected");
    return cuts.length;
  };
  // a decode is bounded by the video's own length on any machine that can play it in real time; never less than 30 min
  const timeoutMs = Math.max(30 * 60_000, Math.round((project.durationSec ?? 0) * 1000));
  await ctx.step(
    "scene-cuts",
    { input: project.sourceKey, model: "ffmpeg-scene", promptVersion: SCENE_CUTS_VERSION, params: { floor: 0.1, width: 320 } },
    detect,
    { schema: z.number(), timeoutMs, model: "ffmpeg-scene" },
  );
  // the step may have been reused while the transcript was replaced (cuts reset to null): then detect again
  const [row] = await ctx.db.select({ cuts: schema.transcripts.sceneCuts }).from(schema.transcripts).where(eq(schema.transcripts.projectId, ctx.projectId));
  if (row?.cuts) return row.cuts;
  await detect(ctx.signal);
  const [again] = await ctx.db.select({ cuts: schema.transcripts.sceneCuts }).from(schema.transcripts).where(eq(schema.transcripts.projectId, ctx.projectId));
  return again?.cuts ?? [];
}

/** One scoring batch's raw answers: a list of items per sample. */
const samplesSchema = z.array(z.array(scoreItem));

export async function analyze(ctx: StageContext) {
  const { svc, projectId, db } = ctx;
  const project = await ctx.project();
  const settings = project.settings;

  const log = ctx.log;
  // An extension of a partly processed video (extendProject) picks moments only in the new part, around every clip
  // that exists; it clears `extend_from_sec` in the commit that adds them, so a run of this job after it converges.
  const extendFrom = project.extendFromSec ?? null;
  // Untouched AI picks mean this analysis already committed (a re-analyze replaces every one of them before it
  // queues this job): converge instead of re-picking. Clips the user made or edited were kept: new picks go around them.
  const live = await db.query.clips.findMany({ where: and(eq(schema.clips.projectId, projectId), isNull(schema.clips.deletedAt)) });
  // A project's ranges (docs/specs/range-clipping.md): this run picks only in the ranges not picked from yet, a find
  // range by today's picker inside it, an exact clip range by becoming the clip (prepare writes its title and scores
  // it). A project of whole ranges only (the video, or a partly processed one's parts) keeps the extension path.
  const ranges = await db.select().from(schema.projectRanges).where(eq(schema.projectRanges.projectId, projectId)).orderBy(asc(schema.projectRanges.startSec));
  const hasChosenRanges = ranges.some((r) => r.origin !== "whole");
  const toPick = ranges.filter((r) => !r.pickedAt);
  const findRanges = hasChosenRanges ? toPick.filter((r) => r.mode === "find") : [];
  const exactRanges = hasChosenRanges ? toPick.filter((r) => r.mode === "clip") : [];
  /** ranges added to a project picked from before: like an extension, new picks go around every clip there */
  const addingRanges = hasChosenRanges && ranges.some((r) => r.pickedAt);
  const incremental = extendFrom !== null || addingRanges;
  const existingClips = incremental ? [] : live.filter((c) => !keepReason(c));
  const kept = incremental ? live : live.filter((c) => keepReason(c));
  if (existingClips.length) {
    log.info(
      { clips: existingClips.length, pending: existingClips.filter((c) => c.status !== "done").length },
      "analyze skipped: clips exist, re-queueing renders",
    );
    await svc.tx(async (u) => {
      await lockProjectClips(u, projectId);
      if (!(await lockCurrentStage(u.db, projectId, ctx.seq))) throw new StaleJobError(projectId, ctx.seq); // a newer re-analyze owns these clips now
      await convergeOnExistingClips(svc, u, projectId);
    });
    return;
  }
  if (hasChosenRanges && !toPick.length) return finishExtensionWithoutPicks(ctx, "Every range was picked from already.", []);

  const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId) });
  if (!transcript) throw new Error("Transcript missing; transcribe must run first");
  await ctx.start("analyzing");
  const sceneCuts = await ensureSceneCuts(ctx, project, transcript.sceneCuts);

  /** where the processed part ends (a partly processed video's limit, else the whole video) */
  const endSec = processedEndSec(project) ?? transcript.words.at(-1)?.end ?? 0;
  /** the stretch this run picks in: everything processed, only the new part of an extension, or the find ranges */
  const durationSec = hasChosenRanges ? spansSec(findRanges.map((r) => [r.startSec, r.endSec])) : Math.max(0, endSec - (extendFrom ?? 0));
  const findRangeOf = (c: { startSec: number; endSec: number }) => rangeOverlapping(findRanges, c);
  /** the range a clip from this run belongs to, for `clips.range_id` */
  const rangeIdOf = (startSec: number) => (toPick.find((r) => startSec >= r.startSec - RANGE_PAD_SEC && startSec < r.endSec) ?? null)?.id ?? null;
  const template = await templateForNewClips(db, project.userId, settings.layerTemplateId, log);
  /** exact clip ranges as clips, their ends snapped to sentences inside the padding; titled and scored by prepare */
  const exactRows = exactRanges.map((r, index) => {
    const c = exactRangeBounds(r, transcript.segments, sceneCuts, settings, endSec, transcript.words);
    return {
      id: randomUUID(),
      projectId,
      index,
      title: (r.label ?? `${formatTime(r.startSec)}–${formatTime(r.endSec)}`).slice(0, 120),
      hook: "",
      startSec: c.startSec,
      endSec: c.endSec,
      layers: layersForNewClip(template, c),
      bumpers: bumpersForNewClip(template),
      score: 0,
      scores: null,
      emphasis: null,
      reasoning: "",
      caption: "",
      hashtags: [],
      status: "pending" as const,
      rangeId: r.id,
    };
  });
  /** in the commit that adds this run's clips: the ranges it picked from are done, so a later run picks only in new ones */
  const markPicked = async (u: UnitOfWork) => {
    if (toPick.length)
      await u.db
        .update(schema.projectRanges)
        .set({ pickedAt: new Date() })
        .where(
          inArray(
            schema.projectRanges.id,
            toPick.map((r) => r.id),
          ),
        );
  };
  /** the exact clips, placed after `firstIndex`, each handed to prepare (title, hook, caption, scores), which renders it */
  const insertExact = async (u: UnitOfWork, firstIndex: number) => {
    const placed = exactRows.map((r) => ({ ...r, index: firstIndex + r.index }));
    if (!placed.length) return placed;
    await u.db.insert(schema.clips).values(placed);
    if (template) await syncClipsRefs(u.db, projectId, placed);
    for (const r of placed) await u.emit("clip.created", { projectId, clipId: r.id, index: r.index, title: r.title });
    for (const r of placed) await requestPrepare(svc, u, projectId, r.id, { mode: "exact" });
    return placed;
  };
  /** another run of this job committed this run's ranges already (they are picked now): converge on its clips */
  const rangesTaken = async (u: UnitOfWork) => {
    if (!toPick.length) return false;
    const now = await u.db
      .select({ pickedAt: schema.projectRanges.pickedAt })
      .from(schema.projectRanges)
      .where(
        inArray(
          schema.projectRanges.id,
          toPick.map((r) => r.id),
        ),
      );
    return now.some((r) => r.pickedAt !== null);
  };
  /** nothing to pick (no speech, no usable or strong enough moment): the exact clips still land, else the run ends soft */
  const endWithoutPicks = async (message: string): Promise<void> => {
    if (!exactRows.length)
      return finishExtensionWithoutPicks(
        ctx,
        message,
        toPick.map((r) => r.id),
      );
    let converged = false;
    await ctx.complete(
      async (u) => {
        converged = await rangesTaken(u);
        return { clips: converged ? 0 : exactRows.length, exact: exactRows.length, nothing: message };
      },
      async (u) => {
        if (converged) {
          await convergeOnExistingClips(svc, u, projectId);
          return;
        }
        const liveNow = await u.db
          .select({ index: schema.clips.index })
          .from(schema.clips)
          .where(and(eq(schema.clips.projectId, projectId), isNull(schema.clips.deletedAt)));
        await insertExact(
          u,
          liveNow.reduce((m, k) => Math.max(m, k.index + 1), 0),
        );
        await markPicked(u);
        await u.db
          .update(schema.projects)
          .set({ status: "rendering", stage: "render", stageProgress: 0, stageStartedAt: sql`now()`, extendFromSec: null, updatedAt: new Date() })
          .where(eq(schema.projects.id, projectId));
      },
    );
  };
  if (hasChosenRanges && !findRanges.length) return endWithoutPicks("Every range is an exact clip.");
  const languageId = svc.models.get().language;
  const selfHosted = isSelfHostedModel({ AI_MODEL: languageId, OPENAI_BASE_URL: svc.providers.get("openai").baseUrl });
  const concurrency = svc.config.ANALYZE_CONCURRENCY || (selfHosted ? 1 : 4);
  // the judge (scoring + pairwise) may be a different model; its hosting decides the sampling cost
  const judgeId = svc.config.ANALYZE_JUDGE_MODEL;
  const judgeSelfHosted = judgeId ? isSelfHostedModel({ AI_MODEL: judgeId, OPENAI_BASE_URL: svc.providers.get("openai").baseUrl }) : selfHosted;
  const samples = svc.config.ANALYZE_SCORE_SAMPLES || (judgeSelfHosted ? 1 : 3);
  const pairwise = svc.config.ANALYZE_PAIRWISE === "on" || (svc.config.ANALYZE_PAIRWISE === "auto" && !judgeSelfHosted);
  const passes = svc.config.ANALYZE_PAIRWISE_PASSES;
  const gateOpts: ScoreGateOpts = { rule: svc.config.ANALYZE_SCORE_RULE, floor: svc.config.ANALYZE_MIN_SCORE_FLOOR, k: svc.config.ANALYZE_SCORE_MAD_K };
  const auto = !settings.maxClips;
  const cap = clipCap(settings, durationSec);
  const sc: SelectContext = {
    title: project.title,
    durationSec,
    minSec: settings.minClipSeconds,
    maxSec: settings.maxClipSeconds,
    maxClips: settings.maxClips,
    focus: settings.focus,
    instructions: settings.instructions,
    // only when known: an undefined key keeps the step key (and its saved answers) of projects from before
    ...(outputLanguage(transcript.language) ? { language: outputLanguage(transcript.language) } : {}),
  };
  const o: LlmOpts = { model: await svc.ai.languageModel(), signal: ctx.signal, telemetry: svc.otel.enabled, log: ctx.log };
  const judge: LlmOpts = judgeId ? { ...o, model: await svc.ai.languageModel(judgeId) } : o;
  const judgeModelId = judgeId ?? languageId;
  const mapUnitMs = ctx.unitTimeoutMs(languageId);
  const scoreUnitMs = ctx.unitTimeoutMs(judgeModelId);
  // the pairwise pass is not checkpointed; each of its calls still has a limit
  judge.timeoutMs = scoreUnitMs;
  // an extension reads only the new part, so the windows (and their saved steps) are the rest of the video's
  const segments = hasChosenRanges
    ? transcript.segments.filter((sg) => findRanges.some((r) => sg.end > r.startSec + 0.5 && sg.start < r.endSec - 0.5))
    : extendFrom === null
      ? transcript.segments
      : transcript.segments.filter((sg) => sg.end > extendFrom + 0.5);
  /** a run that may end without new picks instead of failing: an extension, ranges added later, or exact clips to make */
  const soft = incremental || exactRows.length > 0;
  if (soft && !segments.length) return endWithoutPicks(hasChosenRanges ? "No speech in the ranges." : "No speech in the rest of the video.");
  log.info(
    {
      durationSec,
      extendFrom,
      segments: segments.length,
      model: languageId,
      judge: judgeId ?? null,
      selfHosted,
      concurrency,
      samples,
      pairwise,
      passes,
      scoreRule: gateOpts.rule,
      auto,
      cap,
      focus: settings.focus ?? null,
      minSec: settings.minClipSeconds,
      maxSec: settings.maxClipSeconds,
    },
    "analyze start",
  );

  // 1-2. chunk + map. Every window is a checkpointed step keyed on its lines, the model, the prompt version and the
  // selection settings (sc): a retry, or a re-analyze with nothing changed, reuses the windows already mapped.
  const chunks = chunkTranscript(segments);
  const candidatesSchema = z.array(clipCandidateSchema);
  await ctx.progress(0.03, `Finding moments in ${plural(chunks.length, "part")} of the transcript`);
  const perChunk = await ctx.steps(chunks, { concurrency, range: [0.05, 0.4], message: (d, t) => `Found candidates in part ${d}/${t}` }, (ch, i, signal) =>
    ctx.step(
      `map:${i}`,
      { input: { lines: ch.lines, start: ch.start, end: ch.end }, model: languageId, promptVersion: MAP_PROMPT_VERSION, params: sc },
      (sig) => mapChunk({ ...o, signal: sig }, ch, sc),
      { schema: candidatesSchema, timeoutMs: mapUnitMs, model: languageId, signal },
    ),
  );
  // gleaning: one extra pass when the first pick clustered at the start of a long window (or found ≤1). A window whose
  // extra pass fails (the model answered nonsense) just keeps its first picks; a timeout or a cancel is never skipped.
  const gleanIdx = chunks.map((ch, i) => (needsSecondLook(ch, perChunk[i]!, settings.minClipSeconds) ? i : -1)).filter((i) => i >= 0);
  /** second passes that failed and were skipped: not saved as steps, so another attempt runs them again and may find more */
  let gleanFailed = 0;
  await ctx.steps(gleanIdx, { concurrency, range: [0.4, 0.45], message: (d, t) => `Looking again in ${d}/${plural(t, "part")}` }, async (i, _k, signal) => {
    const ch = chunks[i]!;
    const exclude = excludeRanges(perChunk[i]!);
    const more = await ctx
      .step(
        `glean:${i}`,
        { input: { lines: ch.lines, start: ch.start, end: ch.end, exclude }, model: languageId, promptVersion: MAP_PROMPT_VERSION, params: sc },
        (sig) => mapChunk({ ...o, signal: sig }, ch, sc, exclude),
        { schema: candidatesSchema, timeoutMs: mapUnitMs, model: languageId, signal },
      )
      .catch((err: unknown) => {
        if (err instanceof StageTimeoutError || err instanceof StaleJobError || err instanceof ProjectGoneError || isAbortError(err) || ctx.signal.aborted)
          throw err;
        log.warn({ err, chunk: i }, "second map pass failed; keeping the first picks of this window");
        gleanFailed++;
        return [];
      });
    perChunk[i]!.push(...more);
  });
  if (gleanIdx.length) log.debug({ gleaned: gleanIdx.length, perChunk: perChunk.map((l) => l.length) }, "second map pass on uncovered windows");
  const candidates = perChunk.flat();
  log.debug({ chunks: chunks.length, perChunk: perChunk.map((l) => l.length), candidates: candidates.length }, "moments proposed by the model");
  // what happened to every candidate the model proposed (stage artifact for diagnosis / reports)
  const chunkOf = perChunk.flatMap((list, i) => list.map(() => i));
  const fate: CandidateFate[] = candidates.map((c, i) => ({
    i,
    chunk: chunkOf[i]!,
    title: c.title,
    proposed: [c.startSec, c.endSec],
    modelScore: c.score,
    reasoning: c.reasoning,
    outcome: "unusable",
  }));

  // 3. pool: snap to sentences/scene cuts, enforce length, drop overlaps (keep the better first guess)
  // how sentences end in this transcript: its language's punctuation, or its pauses where STT left punctuation out
  const rules = sentenceRules(transcript.words, transcript.language);
  if (!rules.punctuated) await unpunctuatedEvent(svc, projectId, transcript.language, rules, log);
  const snappedIdx = candidates
    .map((c, i) => {
      if (!hasChosenRanges) return { c: snapCandidate(c, segments, sceneCuts, settings, endSec, { words: transcript.words, log, rules }), i };
      // inside a find range only: snapped to its own sentences, so it never reaches into time no range asked for
      return { c: snapInRanges(c, findRanges, transcript.segments, sceneCuts, settings, endSec, { words: transcript.words, log, rules })?.c ?? null, i };
    })
    .filter((x): x is { c: ClipCandidate; i: number } => x.c !== null)
    .sort((a, b) => b.c.score - a.c.score);
  const snapped = snappedIdx.map((x) => x.c);
  const pool: ClipCandidate[] = [];
  const poolIdx: number[] = [];
  for (const { c, i } of snappedIdx) {
    fate[i]!.snapped = [c.startSec, c.endSec];
    const keptHit = kept.find((k) => overlapRatio(k, c) > 0.3);
    if (keptHit) {
      fate[i]!.outcome = "kept-overlap";
      fate[i]!.keptClipId = keptHit.id;
      continue;
    }
    const over = pool.findIndex((k) => overlapRatio(k, c) > 0.3);
    if (over >= 0) {
      fate[i]!.outcome = "overlap";
      fate[i]!.overlaps = poolIdx[over]!;
      continue;
    }
    pool.push(c);
    poolIdx.push(i);
  }
  const pooled = pool.slice(0, Math.min(40, Math.max(cap * 3, 12)));
  log.debug(
    {
      proposed: candidates.length,
      snapped: snapped.length,
      unusable: candidates.length - snapped.length,
      overlapDropped: snapped.length - pool.length,
      pooled: pooled.length,
      poolCapDropped: pool.length - pooled.length,
    },
    "candidate pool built",
  );
  for (const i of poolIdx.slice(pooled.length)) fate[i]!.outcome = "pool-cap";
  // the candidates matter most when nothing survives ("no clips found"): keep them on failure too
  let gate: (Omit<ScoreGate, "keep"> & { kept: number; dropped: number; unscored: number; unscoredKept: number }) | null = null;
  // settings.minScore is the effective threshold of this run; settings.gate says how it was derived
  const candidatesArtifact = (extra: Record<string, unknown> = {}) => ({
    settings: {
      cap,
      auto,
      minScore: gate?.threshold ?? null,
      gate,
      focus: settings.focus ?? null,
      samples,
      pairwise,
      pairwisePasses: pairwise ? passes : 0,
      judge: judgeId ?? null,
    },
    chunks: chunks.map((c) => [c.start, c.end]),
    ...(kept.length ? { kept: kept.map((k) => ({ clipId: k.id, index: k.index, origin: k.origin, bounds: [k.startSec, k.endSec] })) } : {}),
    candidates: fate,
    ...extra,
  });
  const artifactModels = () => ({ ...modelsUsed(svc, "language"), ...(judgeId ? { judge: judgeId } : {}) });
  const failWithCandidates = async (message: string): Promise<never> => {
    await svc.tx((u) => u.artifact(projectId, "analyze", "candidates", candidatesArtifact({ failed: message }), artifactModels())).catch(() => {});
    // every model answer this verdict rests on is a saved step, so another attempt reaches the same one: fail the run now.
    // A skipped second pass is the exception: it was not saved, and running it again may turn up a clip. The cause is
    // platform: a weak or broken model finds nothing as readily as a dull video, and a Retry after a model fix helps.
    throw gleanFailed ? new Error(message) : new NonRetryableError(message, "platform");
  };
  if (!pooled.length) log.warn({ proposed: candidates.length, snapped: snapped.length }, "no usable candidates");
  if (!pooled.length && soft) return endWithoutPicks(hasChosenRanges ? "No usable moments in the ranges." : "No usable moments in the rest of the video.");
  if (!pooled.length) await failWithCandidates("The model did not return any usable clips. Try widening the clip duration range.");

  // 4. rubric scoring
  const inputs: ScoreInput[] = pooled.map((c, id) => ({ id, durationSec: c.endSec - c.startSec, text: textFor(c, segments) }));
  await ctx.progress(0.45, `Scoring ${plural(pooled.length, "candidate")}${samples > 1 ? ` × ${samples} samples` : ""}`);
  // one step per batch of candidates (all its samples): keyed on the candidates' texts, the judge, the prompt and the settings
  const scoreResults = await ctx.steps(
    scoreBatches(inputs),
    { concurrency, range: [0.45, 0.8], message: (d, t) => `Scoring candidates (${d}/${t})` },
    (batch, i, signal) =>
      ctx.step(
        `score:${i}`,
        { input: batch, model: judgeModelId, promptVersion: SCORE_PROMPT_VERSION, params: { sc, samples } },
        async (sig) => {
          const out: z.infer<typeof samplesSchema> = [];
          for (let k = 0; k < samples; k++) out.push(await scoreSample({ ...judge, signal: sig, timeoutMs: undefined }, batch, sc, samples, k));
          return out;
        },
        { schema: samplesSchema, timeoutMs: scoreUnitMs * samples, model: judgeModelId, signal },
      ),
  );
  const scored = aggregateScores(inputs, sc, scoreResults.flat());
  // unscored (scoring failed) keep their map-pass guess only to order them among themselves
  type Ranked = { c: ClipCandidate; id: number; r: ScoreResult | undefined; total: number };
  let ranked: Ranked[] = pooled.map((c, id) => ({ c, id, r: scored.get(id), total: scored.get(id)?.total ?? Math.round(c.score) }));
  const offTopic = settings.focus ? ranked.filter((x) => (x.r?.scores.relevance ?? 10) < 4).length : 0;
  for (const x of ranked)
    Object.assign(fate[poolIdx[x.id]!]!, {
      total: x.r ? x.total : undefined,
      scores: x.r?.scores ?? null,
      outcome: settings.focus && (x.r?.scores.relevance ?? 10) < 4 ? "off-topic" : "clip-cap",
    });
  if (settings.focus) ranked = ranked.filter((x) => (x.r?.scores.relevance ?? 10) >= 4);
  const byTotal = (a: Ranked, b: Ranked) => b.total - a.total;
  const rated = ranked.filter((x) => x.r).sort(byTotal);
  const unrated = ranked.filter((x) => !x.r).sort(byTotal);
  let chosen: Ranked[];
  let weak = 0;
  if (auto) {
    // the gate runs on rubric totals only; unscored candidates are gated among themselves (same
    // rule on their map guesses) and fill in only when the scored pool is tiny
    const g = scoreGate(
      rated.map((x) => x.total),
      gateOpts,
    );
    const keptRated = rated.filter((_, i) => g.keep[i]);
    const gu = scoreGate(
      unrated.map((x) => x.total),
      gateOpts,
    );
    const keptUnrated = keptRated.length < TINY_POOL ? unrated.filter((_, i) => gu.keep[i]).slice(0, TINY_POOL - keptRated.length) : [];
    const keptIds = new Set([...keptRated, ...keptUnrated].map((x) => x.id));
    for (const x of [...rated, ...unrated]) if (!keptIds.has(x.id)) fate[poolIdx[x.id]!]!.outcome = "weak";
    weak = rated.length + unrated.length - keptIds.size;
    const { keep: _keep, ...stats } = rated.length ? g : gu;
    gate = { ...stats, kept: keptRated.length, dropped: rated.length - keptRated.length, unscored: unrated.length, unscoredKept: keptUnrated.length };
    chosen = [...keptRated, ...keptUnrated].slice(0, cap);
  } else chosen = [...rated, ...unrated].slice(0, cap);
  log.debug(
    {
      scored: scored.size,
      pooled: pooled.length,
      offTopic,
      weak,
      kept: chosen.length,
      cap,
      gate,
      top: rated.slice(0, 10).map((x) => ({ start: x.c.startSec, end: x.c.endSec, total: x.total, title: x.c.title.slice(0, 60) })),
    },
    "candidates scored",
  );
  if (gate)
    log.info(
      { rule: gate.rule, threshold: gate.threshold, n: gate.n, median: gate.median, mad: gate.mad, dropped: gate.dropped, unscored: gate.unscored },
      `score gate: dropped ${gate.dropped} below ${gate.threshold} (${gate.rule})`,
    );
  if (!chosen.length && soft)
    return endWithoutPicks(
      hasChosenRanges ? "No moments in the ranges were strong enough to clip." : "No moments in the rest of the video were strong enough to clip.",
    );
  if (!chosen.length) await failWithCandidates(settings.focus ? `No moments about "${settings.focus}" were found.` : "No usable clips were found.");

  // 5. pairwise re-rank of the top
  ctx.throwIfAborted(); // a stopped attempt must not go on to hand off half a ranking
  let ranks: Map<number, number> | undefined;
  if (pairwise && chosen.length > 2 && !ctx.signal.aborted) {
    // only scored clips are compared; an unscored fill-in keeps its place after them
    const top = chosen.filter((x) => x.r).slice(0, 10);
    await ctx.progress(0.82, `Comparing the top ${top.length} clips head to head`);
    const order = await pairwiseRank(
      judge,
      top.map((x) => inputs[x.id]!),
      sc,
      (d, t) => void ctx.progress(0.82 + 0.15 * (d / t), `Comparing clips (${d}/${t})`).catch(() => {}),
      passes,
    );
    const byId = new Map(top.map((x) => [x.id, x]));
    chosen = [...order.map((id) => byId.get(id)!), ...chosen.filter((x) => !byId.has(x.id))];
    ranks = new Map(order.map((id, i) => [id, i + 1]));
    log.debug({ compared: top.length, passes, order }, "pairwise re-rank");
  }

  if (kept.length)
    log.debug(
      { kept: kept.map((k) => ({ clipId: k.id, start: k.startSec, end: k.endSec })), droppedForKept: fate.filter((f) => f.outcome === "kept-overlap").length },
      "new picks avoid the clips the user kept",
    );
  // the project's layer template (brand overlays, music bed, CTA, intro / outro), materialised on every new clip against its own length
  const picks = chosen.map(({ c, id, r, total }, index) => ({
    id: randomUUID(),
    projectId,
    index, // position among the new picks; the hand-off offsets it past the clips that exist when it commits
    title: c.title.slice(0, 120),
    hook: c.hook.slice(0, 80),
    startSec: c.startSec,
    endSec: c.endSec,
    layers: layersForNewClip(template, c),
    bumpers: bumpersForNewClip(template),
    score: total,
    scores: r ? { ...r.scores, ...(ranks?.has(id) ? { rank: ranks.get(id)! } : {}) } : null,
    emphasis: r?.emphasis.length ? r.emphasis : null,
    reasoning: c.reasoning,
    caption: (c.caption ?? "").slice(0, 300),
    hashtags: c.hashtags.map((h) => h.replace(/^#/, "")),
    status: "pending" as const,
    rangeId: hasChosenRanges ? (findRangeOf(c)?.id ?? null) : rangeIdOf(c.startSec),
  }));
  const rows = distinctTitles(
    picks,
    kept.map((k) => k.title),
  );
  for (const [i, r] of rows.entries()) if (r.title !== picks[i]!.title) log.debug({ from: picks[i]!.title, to: r.title }, "clip retitled: title already used");
  log.debug({ picks: rows.map((r) => ({ index: r.index, start: r.startSec, end: r.endSec, score: r.score, title: r.title.slice(0, 60) })) }, "clips chosen");
  // clips, their events, the candidates artifact, "analyze done", the move to rendering and every
  // render job: one commit
  let converged = false;
  let liveNow: schema.Clip[] = [];
  const stageExtra = {
    chunks: chunks.length,
    candidates: candidates.length,
    pooled: pooled.length,
    samples,
    pairwise: !!ranks,
    dropped: { unusable: candidates.length - snapped.length, overlap: snapped.length - pool.length, weak, offTopic },
    gate: gate && { rule: gate.rule, threshold: gate.threshold },
  };
  await ctx.complete(
    async (u) => {
      // the project row is locked by now (lockCurrentStage), so what we read here is what the insert sees
      liveNow = await u.db
        .select()
        .from(schema.clips)
        .where(and(eq(schema.clips.projectId, projectId), isNull(schema.clips.deletedAt)));
      if (addingRanges) converged = await rangesTaken(u);
      else if (extendFrom === null) converged = liveNow.some((c) => c.origin === "ai" && !keepReason(c));
      else {
        // the project row is locked: an extension whose picks another run of this job committed has no extend_from_sec now
        const [p] = await u.db.select({ from: schema.projects.extendFromSec }).from(schema.projects).where(eq(schema.projects.id, projectId));
        converged = p?.from == null;
      }
      // when we converge, another run's picks stand and this run inserted none
      return { clips: converged ? 0 : rows.length + exactRows.length, ...(exactRows.length ? { exact: exactRows.length } : {}), ...stageExtra };
    },
    async (u) => {
      if (converged) {
        // another run of this analysis committed its picks while we scored: converge on them instead of adding a second set
        log.info({ clips: liveNow.length }, "clips already exist, converging");
        await convergeOnExistingClips(svc, u, projectId); // the clips are locked by lockCurrentStage in ctx.complete
        return;
      }
      const firstIndex = liveNow.reduce((m, k) => Math.max(m, k.index + 1), 0);
      const placed = rows.map((r) => ({ ...r, index: firstIndex + r.index }));
      placed.forEach((r, index) =>
        Object.assign(fate[poolIdx[chosen[index]!.id]!]!, { outcome: "chosen", clipId: r.id, clipIndex: r.index, rank: ranks?.get(chosen[index]!.id) }),
      );
      if (placed.length) await u.db.insert(schema.clips).values(placed);
      if (template && placed.length) await syncClipsRefs(u.db, projectId, placed);
      await insertExact(u, firstIndex + placed.length);
      await markPicked(u);
      await u.artifact(projectId, "analyze", "candidates", candidatesArtifact({ pairwiseRanked: !!ranks }), artifactModels());
      for (const r of placed) await u.emit("clip.created", { projectId: projectId, clipId: r.id, index: r.index, title: r.title });
      await u.db
        .update(schema.projects)
        .set({ status: "rendering", stage: "render", stageProgress: 0, stageStartedAt: sql`now()`, extendFromSec: null, updatedAt: new Date() })
        .where(eq(schema.projects.id, projectId));
      for (const r of placed) await u.enqueue(QUEUES.render, { projectId, clipId: r.id, gen: 0 });
    },
  );
  void db;
}

/**
 * An extension that found nothing worth a new clip in the rest of the video: the clips already there stand, the
 * extension is over (`extend_from_sec` cleared) and the project goes back to rendering what it has (done when it is
 * all done). Never a failure: the video was processed; it just had nothing more.
 */
async function finishExtensionWithoutPicks(ctx: StageContext, message: string, rangeIds: string[] = []): Promise<void> {
  const { svc, projectId } = ctx;
  ctx.log.info({ reason: message }, "extension found no new clips");
  // clips first, then the project row (the stage fence), as everywhere that touches several clips and the project
  await svc.tx(async (u) => {
    await lockProjectClips(u, projectId);
    if (!(await lockCurrentStage(u.db, projectId, ctx.seq))) throw new StaleJobError(projectId, ctx.seq);
    const durationSec = await stageElapsed(u.db, projectId, "analyze");
    await u.db
      .update(schema.projects)
      .set({ extendFromSec: null, stageProgress: 1, stageDetail: null, reconcileRequeues: 0, updatedAt: new Date() })
      .where(eq(schema.projects.id, projectId));
    // the ranges looked at are done: a later run picks only in ranges added after this one
    if (rangeIds.length) await u.db.update(schema.projectRanges).set({ pickedAt: new Date() }).where(inArray(schema.projectRanges.id, rangeIds));
    await u.emit("stage.completed", {
      projectId,
      stage: "analyze",
      clips: 0,
      extended: true,
      nothing: message,
      ...(durationSec !== undefined ? { durationSec } : {}),
    });
    await convergeOnExistingClips(svc, u, projectId);
  });
}

/**
 * Pick up where an analysis that already committed its clips left off: unprepared clips go through the one prepare
 * path (which keeps a live prepare job), the rest re-queue their current generation, the project moves to rendering
 * (only a project still in an earlier stage, and only that caller emits), and a project whose clips are all done
 * finishes. The caller holds the clip locks (id order) and the project's stage lock.
 */
async function convergeOnExistingClips(svc: Services, u: UnitOfWork, projectId: string): Promise<void> {
  for (const c of await listClips(u.db, projectId)) {
    if (c.status === "done") continue;
    if (needsPrepare(c)) await requestPrepare(svc, u, projectId, c.id, { restart: false });
    else await u.enqueue(QUEUES.render, { projectId, clipId: c.id, gen: c.renderGen });
  }
  const [moved] = await u.db
    .update(schema.projects)
    .set({ status: "rendering", stage: "render", stageStartedAt: sql`now()`, updatedAt: new Date() })
    .where(and(eq(schema.projects.id, projectId), inArray(schema.projects.status, ["queued", "ingesting", "transcribing", "refining", "analyzing"])))
    .returning({ id: schema.projects.id });
  if (moved) await u.emit("stage.started", { projectId: projectId, stage: "render", status: "rendering", resumed: true });
  // every clip already done (a Retry that only fetched an expired source again): nothing is queued to finish the project
  await finalizeProjectIfDone(svc, u, projectId);
}

/**
 * Why a re-analyze keeps a clip instead of replacing it: the user made it ("manual"), or changed it in any way
 * ("edited": text, bounds, framing, style, intro/outro). Null = an untouched AI pick, which is replaced.
 */
export function keepReason(
  c: Pick<schema.Clip, "origin" | "editedAt" | "layoutOverride" | "layoutSections" | "style" | "bumpers">,
): "manual" | "edited" | null {
  if (c.origin !== "ai") return "manual";
  if (c.editedAt || c.layoutOverride || c.layoutSections?.length || (c.style && Object.keys(c.style).length) || c.bumpers) return "edited";
  return null;
}

/** A project's live clips (not soft-deleted), in order. */
export async function listClips(db: Db, projectId: string) {
  return db.query.clips.findMany({
    where: and(eq(schema.clips.projectId, projectId), isNull(schema.clips.deletedAt)),
    orderBy: [asc(schema.clips.index), asc(schema.clips.createdAt), asc(schema.clips.id)],
  });
}

/**
 * Says once per pick that this transcript has almost no sentence punctuation (most STT output for Hindi, for one), so
 * clips start and end on the pauses its speaker makes between sentences instead (pipeline/language.ts,
 * sentenceBoundaries): a softer signal than a full stop, and the user should know why an edge may land mid-thought.
 */
export async function unpunctuatedEvent(
  svc: Pick<Services, "events">,
  projectId: string,
  language: string | null | undefined,
  rules: SentenceRules,
  log: Logger,
): Promise<void> {
  log.info({ language, pauseSec: Number(rules.pauseSec.toFixed(2)) }, "transcript has almost no punctuation: clip edges use pauses");
  await svc.events
    .emit("language.degraded", {
      projectId,
      stage: "sentenceBoundaries",
      language: languageCode(language) ?? "und",
      reason: `clip edges: the transcript has almost no punctuation, so clips start and end on pauses between sentences (${rules.pauseSec.toFixed(2)} s or longer) instead of full stops`,
    })
    .catch(() => {});
}
