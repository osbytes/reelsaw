import { and, eq, asc, inArray, isNull, sql } from "drizzle-orm";
import { lockProjectClips, requestPrepare } from "./lifecycle.js";
import { needsPrepare } from "./manual.js";
import { randomUUID } from "node:crypto";
import { schema, type Db } from "../db/index.js";
import { StageContext, modelsUsed } from "./common.js";
import { chunkTranscript, excludeRanges, mapChunk, mapLimit, needsSecondLook, pairwiseRank, scoreCandidates, type LlmOpts, type ScoreInput, type ScoreResult, type SelectContext } from "./select.js";
import { QUEUES } from "../queue/boss.js";
import { type ClipCandidate, type ProjectSettings, type TranscriptSegment, type Word } from "@reelsaw/shared";
import { finishThought } from "./thought.js";
import type { Logger } from "../log.js";
import { layersForNewClip, templateForNewClips } from "../library/templates.js";
import { syncClipsRefs } from "../library/refs.js";

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
  if (o.rule === "absolute") return { rule: "absolute", threshold: AUTO_MIN_SCORE, n, median: null, mad: null, floor: o.floor, k: o.k, keep: totals.map((t, i) => i === leader || t >= AUTO_MIN_SCORE) };
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

export function snapCandidate(
  c: ClipCandidate,
  segments: TranscriptSegment[],
  sceneCuts: number[],
  settings: ProjectSettings,
  durationSec: number,
  thought: { words?: Word[]; log?: Logger; bounds?: [number, number] } = {},
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
    end = fit + 0.35;
  }
  if (end - start < settings.minClipSeconds) {
    // too short: grow forward to the first sentence end that satisfies the minimum (small models
    // often pick a single punchy sentence); then backwards if the video ran out
    const grown = ends.find((e) => e - start >= settings.minClipSeconds && e - start <= settings.maxClipSeconds);
    if (grown !== undefined) end = Math.min(durationSec || grown + 0.35, grown + 0.35);
    else {
      const back = starts.filter((st) => end - st >= settings.minClipSeconds && end - st <= settings.maxClipSeconds).pop();
      if (back === undefined) return null;
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
    });
    for (const ch of done.changes) {
      thought.log?.debug({ edge: ch.edge, from: Number(ch.from.toFixed(2)), to: ch.to === undefined ? null : Number(ch.to.toFixed(2)), action: ch.action, reason: ch.reason, title: c.title.slice(0, 60) }, ch.action === "left" ? `clip ${ch.edge} left inside a sentence` : `clip ${ch.edge} moved to finish the sentence`);
    }
    if (done.changes.some((ch) => ch.action !== "left")) {
      start = Math.max(0, done.start - PAD_START);
      end = Math.min(durationSec || done.end + PAD_END, done.end + PAD_END);
    }
  }
  return { ...c, startSec: Number(start.toFixed(2)), endSec: Number(end.toFixed(2)) };
}

/** Local models are slow and sequential; cloud models take parallel calls and extra samples. */
function isSelfHostedModel(cfg: { AI_MODEL: string; OPENAI_BASE_URL?: string }) {
  const provider = cfg.AI_MODEL.split(":")[0];
  return provider === "compat" || provider === "ollama" || (provider === "openai" && !!cfg.OPENAI_BASE_URL);
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

export async function analyze(ctx: StageContext) {
  const { svc, projectId, db } = ctx;
  const project = await ctx.project();
  const settings = project.settings;

  const log = ctx.log;
  // Untouched AI picks mean this analysis already committed (a re-analyze replaces every one of them before it
  // queues this job): converge instead of re-picking. Clips the user made or edited were kept: new picks go around them.
  const live = await db.query.clips.findMany({ where: and(eq(schema.clips.projectId, projectId), isNull(schema.clips.deletedAt)) });
  const existingClips = live.filter((c) => !keepReason(c));
  const kept = live.filter((c) => keepReason(c));
  if (existingClips.length) {
    log.info({ clips: existingClips.length, pending: existingClips.filter((c) => c.status !== "done").length }, "analyze skipped: clips exist, re-queueing renders");
    await svc.tx(async (u) => {
      // unprepared clips go through the one prepare path (which keeps a live prepare job); the rest re-queue their
      // current generation. Clips are locked (id order) before the project row is touched.
      await lockProjectClips(u, projectId);
      for (const c of await listClips(u.db, projectId)) {
        if (c.status === "done") continue;
        if (needsPrepare(c)) await requestPrepare(svc, u, projectId, c.id, { restart: false });
        else await u.enqueue(QUEUES.render, { projectId, clipId: c.id, gen: c.renderGen });
      }
      // a conditional flip: only a project still in an earlier stage moves to rendering, and only that caller emits
      const [moved] = await u.db
        .update(schema.projects)
        .set({ status: "rendering", stage: "render", stageStartedAt: sql`now()`, updatedAt: new Date() })
        .where(and(eq(schema.projects.id, projectId), inArray(schema.projects.status, ["queued", "ingesting", "transcribing", "refining", "analyzing"])))
        .returning({ id: schema.projects.id });
      if (moved) await u.emit(projectId, "stage.started", { stage: "render", status: "rendering", resumed: true });
    });
    return;
  }

  const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId) });
  if (!transcript) throw new Error("Transcript missing; transcribe must run first");
  await ctx.start("analyzing");

  const durationSec = project.durationSec ?? transcript.words.at(-1)?.end ?? 0;
  const selfHosted = isSelfHostedModel({ AI_MODEL: svc.models.get().language, OPENAI_BASE_URL: svc.providers.get("openai").baseUrl });
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
  const sc: SelectContext = { title: project.title, durationSec, minSec: settings.minClipSeconds, maxSec: settings.maxClipSeconds, maxClips: settings.maxClips, focus: settings.focus, instructions: settings.instructions };
  const o: LlmOpts = { model: await svc.ai.languageModel(), signal: ctx.signal, telemetry: svc.otel.enabled, log: ctx.log };
  const judge: LlmOpts = judgeId ? { ...o, model: await svc.ai.languageModel(judgeId) } : o;
  const segments = transcript.segments;
  log.info({ durationSec, segments: segments.length, model: svc.models.get().language, judge: judgeId ?? null, selfHosted, concurrency, samples, pairwise, passes, scoreRule: gateOpts.rule, auto, cap, focus: settings.focus ?? null, minSec: settings.minClipSeconds, maxSec: settings.maxClipSeconds }, "analyze start");

  // 1-2. chunk + map
  const chunks = chunkTranscript(segments);
  let mapped = 0;
  await ctx.progress(0.03, `Finding moments in ${chunks.length} part(s) of the transcript`);
  const perChunk = await mapLimit(chunks, concurrency, async (ch) => {
    const found = await mapChunk(o, ch, sc);
    await ctx.progress(0.05 + 0.35 * (++mapped / chunks.length), `Found candidates in part ${mapped}/${chunks.length}`);
    return found;
  });
  // gleaning: one extra pass when the first pick clustered at the start of a long window (or found ≤1)
  let gleaned = 0;
  const gleanIdx = chunks.map((ch, i) => (needsSecondLook(ch, perChunk[i]!, settings.minClipSeconds) ? i : -1)).filter((i) => i >= 0);
  await mapLimit(gleanIdx, concurrency, async (i) => {
    if (ctx.signal.aborted) return;
    const ch = chunks[i]!;
    const more = await mapChunk(o, ch, sc, excludeRanges(perChunk[i]!)).catch(() => []);
    perChunk[i]!.push(...more);
    gleaned++;
    await ctx.progress(0.4 + 0.05 * (gleaned / Math.max(1, gleanIdx.length)), `Looking again in part ${i + 1}/${chunks.length}`);
  });
  if (gleanIdx.length) log.debug({ gleaned: gleanIdx.length, perChunk: perChunk.map((l) => l.length) }, "second map pass on uncovered windows");
  const candidates = perChunk.flat();
  log.debug({ chunks: chunks.length, perChunk: perChunk.map((l) => l.length), candidates: candidates.length }, "moments proposed by the model");
  // what happened to every candidate the model proposed (stage artifact for diagnosis / reports)
  const chunkOf = perChunk.flatMap((list, i) => list.map(() => i));
  const fate: CandidateFate[] = candidates.map((c, i) => ({ i, chunk: chunkOf[i]!, title: c.title, proposed: [c.startSec, c.endSec], modelScore: c.score, reasoning: c.reasoning, outcome: "unusable" }));

  // 3. pool: snap to sentences/scene cuts, enforce length, drop overlaps (keep the better first guess)
  const snappedIdx = candidates
    .map((c, i) => ({ c: snapCandidate(c, segments, transcript.sceneCuts ?? [], settings, durationSec, { words: transcript.words, log }), i }))
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
      fate[i]!.overlaps = poolIdx[over];
      continue;
    }
    pool.push(c);
    poolIdx.push(i);
  }
  const pooled = pool.slice(0, Math.min(40, Math.max(cap * 3, 12)));
  log.debug({ proposed: candidates.length, snapped: snapped.length, unusable: candidates.length - snapped.length, overlapDropped: snapped.length - pool.length, pooled: pooled.length, poolCapDropped: pool.length - pooled.length }, "candidate pool built");
  for (const i of poolIdx.slice(pooled.length)) fate[i]!.outcome = "pool-cap";
  // the candidates matter most when nothing survives ("no clips found"): keep them on failure too
  let gate: (Omit<ScoreGate, "keep"> & { kept: number; dropped: number; unscored: number; unscoredKept: number }) | null = null;
  // settings.minScore is the effective threshold of this run; settings.gate says how it was derived
  const candidatesArtifact = (extra: Record<string, unknown> = {}) => ({ settings: { cap, auto, minScore: gate?.threshold ?? null, gate, focus: settings.focus ?? null, samples, pairwise, pairwisePasses: pairwise ? passes : 0, judge: judgeId ?? null }, chunks: chunks.map((c) => [c.start, c.end]), ...(kept.length ? { kept: kept.map((k) => ({ clipId: k.id, index: k.index, origin: k.origin, bounds: [k.startSec, k.endSec] })) } : {}), candidates: fate, ...extra });
  const artifactModels = () => ({ ...modelsUsed(svc, "language"), ...(judgeId ? { judge: judgeId } : {}) });
  const failWithCandidates = async (message: string): Promise<never> => {
    await svc.tx((u) => u.artifact(projectId, "analyze", "candidates", candidatesArtifact({ failed: message }), artifactModels())).catch(() => {});
    throw new Error(message);
  };
  if (!pooled.length) log.warn({ proposed: candidates.length, snapped: snapped.length }, "no usable candidates");
  if (!pooled.length) await failWithCandidates("The model did not return any usable clips. Try widening the clip duration range.");

  // 4. rubric scoring
  const inputs: ScoreInput[] = pooled.map((c, id) => ({ id, durationSec: c.endSec - c.startSec, text: textFor(c, segments) }));
  await ctx.progress(0.45, `Scoring ${pooled.length} candidate(s)${samples > 1 ? ` × ${samples} samples` : ""}`);
  const scored = await scoreCandidates(judge, inputs, sc, samples, concurrency, (d, t) => void ctx.progress(0.45 + 0.35 * (d / t), `Scoring candidates (${d}/${t})`).catch(() => {}));
  // unscored (scoring failed) keep their map-pass guess only to order them among themselves
  type Ranked = { c: ClipCandidate; id: number; r: ScoreResult | undefined; total: number };
  let ranked: Ranked[] = pooled.map((c, id) => ({ c, id, r: scored.get(id), total: scored.get(id)?.total ?? Math.round(c.score) }));
  const offTopic = settings.focus ? ranked.filter((x) => (x.r?.scores.relevance ?? 10) < 4).length : 0;
  for (const x of ranked) Object.assign(fate[poolIdx[x.id]!]!, { total: x.r ? x.total : undefined, scores: x.r?.scores ?? null, outcome: settings.focus && (x.r?.scores.relevance ?? 10) < 4 ? "off-topic" : "clip-cap" });
  if (settings.focus) ranked = ranked.filter((x) => (x.r?.scores.relevance ?? 10) >= 4);
  const byTotal = (a: Ranked, b: Ranked) => b.total - a.total;
  const rated = ranked.filter((x) => x.r).sort(byTotal);
  const unrated = ranked.filter((x) => !x.r).sort(byTotal);
  let chosen: Ranked[];
  let weak = 0;
  if (auto) {
    // the gate runs on rubric totals only; unscored candidates are gated among themselves (same
    // rule on their map guesses) and fill in only when the scored pool is tiny
    const g = scoreGate(rated.map((x) => x.total), gateOpts);
    const keptRated = rated.filter((_, i) => g.keep[i]);
    const gu = scoreGate(unrated.map((x) => x.total), gateOpts);
    const keptUnrated = keptRated.length < TINY_POOL ? unrated.filter((_, i) => gu.keep[i]).slice(0, TINY_POOL - keptRated.length) : [];
    const keptIds = new Set([...keptRated, ...keptUnrated].map((x) => x.id));
    for (const x of [...rated, ...unrated]) if (!keptIds.has(x.id)) fate[poolIdx[x.id]!]!.outcome = "weak";
    weak = rated.length + unrated.length - keptIds.size;
    const { keep: _keep, ...stats } = rated.length ? g : gu;
    gate = { ...stats, kept: keptRated.length, dropped: rated.length - keptRated.length, unscored: unrated.length, unscoredKept: keptUnrated.length };
    chosen = [...keptRated, ...keptUnrated].slice(0, cap);
  } else chosen = [...rated, ...unrated].slice(0, cap);
  log.debug({ scored: scored.size, pooled: pooled.length, offTopic, weak, kept: chosen.length, cap, gate, top: rated.slice(0, 10).map((x) => ({ start: x.c.startSec, end: x.c.endSec, total: x.total, title: x.c.title.slice(0, 60) })) }, "candidates scored");
  if (gate) log.info({ rule: gate.rule, threshold: gate.threshold, n: gate.n, median: gate.median, mad: gate.mad, dropped: gate.dropped, unscored: gate.unscored }, `score gate: dropped ${gate.dropped} below ${gate.threshold} (${gate.rule})`);
  if (!chosen.length) await failWithCandidates(settings.focus ? `No moments about "${settings.focus}" were found.` : "No usable clips were found.");

  // 5. pairwise re-rank of the top
  let ranks: Map<number, number> | undefined;
  if (pairwise && chosen.length > 2 && !ctx.signal.aborted) {
    // only scored clips are compared; an unscored fill-in keeps its place after them
    const top = chosen.filter((x) => x.r).slice(0, 10);
    await ctx.progress(0.82, `Comparing the top ${top.length} clips head to head`);
    const order = await pairwiseRank(judge, top.map((x) => inputs[x.id]!), sc, (d, t) => void ctx.progress(0.82 + 0.15 * (d / t), `Comparing clips (${d}/${t})`).catch(() => {}), passes);
    const byId = new Map(top.map((x) => [x.id, x]));
    chosen = [...order.map((id) => byId.get(id)!), ...chosen.filter((x) => !byId.has(x.id))];
    ranks = new Map(order.map((id, i) => [id, i + 1]));
    log.debug({ compared: top.length, passes, order }, "pairwise re-rank");
  }

  if (kept.length) log.debug({ kept: kept.map((k) => ({ clipId: k.id, start: k.startSec, end: k.endSec })), droppedForKept: fate.filter((f) => f.outcome === "kept-overlap").length }, "new picks avoid the clips the user kept");
  const firstIndex = kept.reduce((m, k) => Math.max(m, k.index + 1), 0);
  // the project's layer template (brand overlays, music bed, CTA), materialised on every new clip against its own length
  const template = await templateForNewClips(db, project.userId, settings.layerTemplateId, log);
  const rows = chosen.map(({ c, id, r, total }, index) => ({
    id: randomUUID(),
    projectId,
    index: firstIndex + index,
    title: c.title.slice(0, 120),
    hook: c.hook.slice(0, 80),
    startSec: c.startSec,
    endSec: c.endSec,
    layers: layersForNewClip(template, c),
    score: total,
    scores: r ? { ...r.scores, ...(ranks?.has(id) ? { rank: ranks.get(id)! } : {}) } : null,
    emphasis: r?.emphasis.length ? r.emphasis : null,
    reasoning: c.reasoning,
    caption: (c.caption ?? "").slice(0, 300),
    hashtags: c.hashtags.map((h) => h.replace(/^#/, "")),
    status: "pending" as const,
  }));
  log.debug({ picks: rows.map((r) => ({ index: r.index, start: r.startSec, end: r.endSec, score: r.score, title: r.title.slice(0, 60) })) }, "clips chosen");
  rows.forEach((r, index) => Object.assign(fate[poolIdx[chosen[index]!.id]!]!, { outcome: "chosen", clipId: r.id, clipIndex: r.index, rank: ranks?.get(chosen[index]!.id) }));
  // clips, their events, the candidates artifact, "analyze done", the move to rendering and every
  // render job: one commit
  await ctx.complete({ clips: rows.length, chunks: chunks.length, candidates: candidates.length, pooled: pooled.length, samples, pairwise: !!ranks, dropped: { unusable: candidates.length - snapped.length, overlap: snapped.length - pool.length, weak, offTopic }, gate: gate && { rule: gate.rule, threshold: gate.threshold } }, async (u) => {
    if (rows.length) await u.db.insert(schema.clips).values(rows);
    if (template && rows.length) await syncClipsRefs(u.db, projectId, rows);
    await u.artifact(projectId, "analyze", "candidates", candidatesArtifact({ pairwiseRanked: !!ranks }), artifactModels());
    for (const r of rows) await u.emit(projectId, "clip.created", { clipId: r.id, index: r.index, title: r.title });
    await u.db.update(schema.projects).set({ status: "rendering", stage: "render", stageProgress: 0, stageStartedAt: sql`now()`, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
    for (const r of rows) await u.enqueue(QUEUES.render, { projectId, clipId: r.id, gen: 0 });
  });
  void db;
}

/**
 * Why a re-analyze keeps a clip instead of replacing it: the user made it ("manual"), or changed it in any way
 * ("edited": text, bounds, framing, style, intro/outro). Null = an untouched AI pick, which is replaced.
 */
export function keepReason(c: Pick<schema.Clip, "origin" | "editedAt" | "layoutOverride" | "layoutSections" | "style" | "bumpers">): "manual" | "edited" | null {
  if (c.origin !== "ai") return "manual";
  if (c.editedAt || c.layoutOverride || c.layoutSections?.length || (c.style && Object.keys(c.style).length) || c.bumpers) return "edited";
  return null;
}

/** A project's live clips (not soft-deleted), in order. */
export async function listClips(db: Db, projectId: string) {
  return db.query.clips.findMany({ where: and(eq(schema.clips.projectId, projectId), isNull(schema.clips.deletedAt)), orderBy: asc(schema.clips.index) });
}
