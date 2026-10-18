import { eq, asc, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { schema, type Db } from "../db/index.js";
import { StageContext, modelsUsed } from "./common.js";
import { fmtTs } from "./transcript.js";
import { chunkTranscript, mapChunk, mapLimit, pairwiseRank, scoreCandidates, type LlmOpts, type ScoreInput, type SelectContext } from "./select.js";
import { QUEUES } from "../queue/boss.js";
import { type ClipCandidate, type ProjectSettings, type TranscriptSegment, type Word } from "@reelsaw/shared";
import { finishThought } from "./thought.js";
import type { Logger } from "../log.js";

export { normalizeCandidate, parseClipsLeniently } from "./select.js";

/** Hard ceiling when the user did not set one: never more clips than the video can hold. */
export function clipCap(settings: ProjectSettings, durationSec: number) {
  if (settings.maxClips) return settings.maxClips;
  return Math.max(1, Math.min(40, Math.floor(durationSec / Math.max(15, settings.minClipSeconds))));
}

/** Auto mode drops weak picks, but never everything. */
export const AUTO_MIN_SCORE = 45;

function overlapRatio(a: ClipCandidate, b: ClipCandidate) {
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
  // more than 2.5 s from any boundary; then use the sentence it falls inside: start at its start,
  // end at its end (extending), or at the previous sentence end if extending would break the max.
  const inside = (t: number) => segments.find((sg) => t > sg.start && t < sg.end);
  let start = nearest(starts, c.startSec, 2.5) ?? inside(c.startSec)?.start ?? c.startSec;
  let end = nearest(ends, c.endSec, 2.5) ?? c.endSec;
  if (nearest(ends, c.endSec, 2.5) === undefined) {
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

function fmtRanges(cs: ClipCandidate[]) {
  return cs.map((c) => `${fmtTs(c.startSec)}-${fmtTs(c.endSec)} "${c.title}"`).join("; ");
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
  scores?: Record<string, unknown>;
  rank?: number;
  overlaps?: number;
  clipId?: string;
  clipIndex?: number;
  outcome: "unusable" | "overlap" | "pool-cap" | "off-topic" | "weak" | "clip-cap" | "chosen";
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
  const existingClips = await db.query.clips.findMany({ where: eq(schema.clips.projectId, projectId) });
  if (existingClips.length) {
    log.info({ clips: existingClips.length, pending: existingClips.filter((c) => c.status !== "done").length }, "analyze skipped: clips exist, re-queueing renders");
    await svc.tx(async (u) => {
      await u.db.update(schema.projects).set({ status: "rendering", stage: "render", stageStartedAt: sql`now()`, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
      for (const c of existingClips) if (c.status !== "done") await u.enqueue(QUEUES.render, { projectId, clipId: c.id, gen: c.renderGen });
    });
    return;
  }

  const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId) });
  if (!transcript) throw new Error("Transcript missing; transcribe must run first");
  await ctx.start("analyzing");

  const durationSec = project.durationSec ?? transcript.words.at(-1)?.end ?? 0;
  const selfHosted = isSelfHostedModel({ AI_MODEL: svc.models.get().language, OPENAI_BASE_URL: svc.providers.get("openai").baseUrl });
  const concurrency = svc.config.ANALYZE_CONCURRENCY || (selfHosted ? 1 : 4);
  const samples = svc.config.ANALYZE_SCORE_SAMPLES || (selfHosted ? 1 : 3);
  const pairwise = svc.config.ANALYZE_PAIRWISE === "on" || (svc.config.ANALYZE_PAIRWISE === "auto" && !selfHosted);
  const auto = !settings.maxClips;
  const cap = clipCap(settings, durationSec);
  const sc: SelectContext = { title: project.title, durationSec, minSec: settings.minClipSeconds, maxSec: settings.maxClipSeconds, maxClips: settings.maxClips, focus: settings.focus, instructions: settings.instructions };
  const o: LlmOpts = { model: await svc.ai.languageModel(), signal: ctx.signal, telemetry: svc.otel.enabled, log: ctx.log };
  const segments = transcript.segments;
  log.info({ durationSec, segments: segments.length, model: svc.models.get().language, selfHosted, concurrency, samples, pairwise, auto, cap, focus: settings.focus ?? null, minSec: settings.minClipSeconds, maxSec: settings.maxClipSeconds }, "analyze start");

  // 1-2. chunk + map
  const chunks = chunkTranscript(segments);
  let mapped = 0;
  await ctx.progress(0.03, `Finding moments in ${chunks.length} part(s) of the transcript`);
  const perChunk = await mapLimit(chunks, concurrency, async (ch) => {
    const found = await mapChunk(o, ch, sc);
    await ctx.progress(0.05 + 0.35 * (++mapped / chunks.length), `Found candidates in part ${mapped}/${chunks.length}`);
    return found;
  });
  // weak models often stop after the obvious pick; give sparse long chunks one more look
  for (let i = 0; i < chunks.length; i++) {
    const ch = chunks[i]!;
    if (perChunk[i]!.length > 1 || ch.end - ch.start < 180 || ctx.signal.aborted) continue;
    const more = await mapChunk(o, ch, sc, perChunk[i]!.length ? fmtRanges(perChunk[i]!) : "none").catch(() => []);
    perChunk[i]!.push(...more);
  }
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
  const candidatesArtifact = (extra: Record<string, unknown> = {}) => ({ settings: { cap, auto, minScore: AUTO_MIN_SCORE, focus: settings.focus ?? null, samples, pairwise }, chunks: chunks.map((c) => [c.start, c.end]), candidates: fate, ...extra });
  const failWithCandidates = async (message: string): Promise<never> => {
    await svc.tx((u) => u.artifact(projectId, "analyze", "candidates", candidatesArtifact({ failed: message }), modelsUsed(svc, "language"))).catch(() => {});
    throw new Error(message);
  };
  if (!pooled.length) log.warn({ proposed: candidates.length, snapped: snapped.length }, "no usable candidates");
  if (!pooled.length) await failWithCandidates("The model did not return any usable clips. Try widening the clip duration range.");

  // 4. rubric scoring
  const inputs: ScoreInput[] = pooled.map((c, id) => ({ id, durationSec: c.endSec - c.startSec, text: textFor(c, segments) }));
  await ctx.progress(0.45, `Scoring ${pooled.length} candidate(s)${samples > 1 ? ` × ${samples} samples` : ""}`);
  const scored = await scoreCandidates(o, inputs, sc, samples, concurrency, (d, t) => void ctx.progress(0.45 + 0.35 * (d / t), `Scoring candidates (${d}/${t})`).catch(() => {}));
  let ranked = pooled.map((c, id) => ({ c, id, r: scored.get(id) })).map((x) => ({ ...x, total: x.r?.total ?? Math.round(x.c.score) }));
  const offTopic = settings.focus ? ranked.filter((x) => (x.r?.scores.relevance ?? 10) < 4).length : 0;
  for (const x of ranked) Object.assign(fate[poolIdx[x.id]!]!, { total: x.total, scores: x.r?.scores, outcome: settings.focus && (x.r?.scores.relevance ?? 10) < 4 ? "off-topic" : "clip-cap" });
  if (settings.focus) ranked = ranked.filter((x) => (x.r?.scores.relevance ?? 10) >= 4);
  ranked.sort((a, b) => b.total - a.total);
  const weak = auto ? ranked.filter((x, i) => i > 0 && x.total < AUTO_MIN_SCORE).length : 0;
  if (auto) ranked.forEach((x, i) => i > 0 && x.total < AUTO_MIN_SCORE && (fate[poolIdx[x.id]!]!.outcome = "weak"));
  let chosen = (auto ? ranked.filter((x, i) => i === 0 || x.total >= AUTO_MIN_SCORE) : ranked).slice(0, cap);
  log.debug({ scored: scored.size, pooled: pooled.length, offTopic, weak, kept: chosen.length, cap, minScore: auto ? AUTO_MIN_SCORE : null, top: ranked.slice(0, 10).map((x) => ({ start: x.c.startSec, end: x.c.endSec, total: x.total, title: x.c.title.slice(0, 60) })) }, "candidates scored");
  if (!chosen.length) await failWithCandidates(settings.focus ? `No moments about "${settings.focus}" were found.` : "No usable clips were found.");

  // 5. pairwise re-rank of the top
  let ranks: Map<number, number> | undefined;
  if (pairwise && chosen.length > 2 && !ctx.signal.aborted) {
    const top = chosen.slice(0, Math.min(10, chosen.length));
    await ctx.progress(0.82, `Comparing the top ${top.length} clips head to head`);
    const order = await pairwiseRank(o, top.map((x) => inputs[x.id]!), sc, (d, t) => void ctx.progress(0.82 + 0.15 * (d / t), `Comparing clips (${d}/${t})`).catch(() => {}));
    const byId = new Map(top.map((x) => [x.id, x]));
    chosen = [...order.map((id) => byId.get(id)!), ...chosen.slice(top.length)];
    ranks = new Map(order.map((id, i) => [id, i + 1]));
    log.debug({ compared: top.length, order }, "pairwise re-rank");
  }

  const rows = chosen.map(({ c, id, r, total }, index) => ({
    id: randomUUID(),
    projectId,
    index,
    title: c.title.slice(0, 120),
    hook: c.hook.slice(0, 80),
    startSec: c.startSec,
    endSec: c.endSec,
    score: total,
    scores: r ? { ...r.scores, ...(ranks?.has(id) ? { rank: ranks.get(id)! } : {}) } : null,
    emphasis: r?.emphasis.length ? r.emphasis : null,
    reasoning: c.reasoning,
    caption: (c.caption ?? "").slice(0, 300),
    hashtags: c.hashtags.map((h) => h.replace(/^#/, "")),
    status: "pending" as const,
  }));
  log.debug({ picks: rows.map((r) => ({ index: r.index, start: r.startSec, end: r.endSec, score: r.score, title: r.title.slice(0, 60) })) }, "clips chosen");
  rows.forEach((r, index) => Object.assign(fate[poolIdx[chosen[index]!.id]!]!, { outcome: "chosen", clipId: r.id, clipIndex: index, rank: ranks?.get(chosen[index]!.id) }));
  // clips, their events, the candidates artifact, "analyze done", the move to rendering and every
  // render job: one commit
  await ctx.complete({ clips: rows.length, chunks: chunks.length, candidates: candidates.length, pooled: pooled.length, samples, pairwise: !!ranks, dropped: { unusable: candidates.length - snapped.length, overlap: snapped.length - pool.length, weak, offTopic } }, async (u) => {
    if (rows.length) await u.db.insert(schema.clips).values(rows);
    await u.artifact(projectId, "analyze", "candidates", candidatesArtifact({ pairwiseRanked: !!ranks }), modelsUsed(svc, "language"));
    for (const r of rows) await u.emit(projectId, "clip.created", { clipId: r.id, index: r.index, title: r.title });
    await u.db.update(schema.projects).set({ status: "rendering", stage: "render", stageProgress: 0, stageStartedAt: sql`now()`, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
    for (const r of rows) await u.enqueue(QUEUES.render, { projectId, clipId: r.id, gen: 0 });
  });
  void db;
}

export async function listClips(db: Db, projectId: string) {
  return db.query.clips.findMany({ where: eq(schema.clips.projectId, projectId), orderBy: asc(schema.clips.index) });
}
