import { requestRender } from "./lifecycle.js";
/**
 * Clips the user carved out of the transcript.
 *
 *  exact – keep the user's bounds; the AI only writes title / hook / caption / hashtags and scores it
 *  ai    – the selection is a search window: find the best standalone moment inside it (same map +
 *          rubric scoring as full analysis), falling back to the whole selection if nothing fits
 *
 * Runs as its own queue job (`clip.prepare`) so it is resumable; afterwards the clip is rendered.
 */
import { and, eq, isNull } from "drizzle-orm";
import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { schema } from "../db/index.js";
import { QUEUES } from "../queue/boss.js";
import { ProjectGoneError, StageTimeoutError, StaleJobError, type StageContext } from "./common.js";
import { snapCandidate } from "./analyze.js";
import { callSignal, isAbortError } from "./steps.js";
import { MAP_PROMPT_VERSION, SCORE_PROMPT_VERSION, aggregateScores, chunkTranscript, extractJson, mapChunk, normalizeCandidate, scoreBatches, scoreItem, scoreSample, type LlmOpts, type ScoreInput, type ScoreResult, type SelectContext } from "./select.js";
import type { Logger } from "../log.js";
import { mapLimit } from "../lib/batch.js";
import { isSelfHostedModel } from "../ai/self-hosted.js";
import { fmtTs } from "./transcript.js";
import { clipCandidateSchema, clipLayers, type ClipCandidate, type TranscriptSegment } from "@reelsaw/shared";
import { layersForNewClip, templateForNewClips } from "../library/templates.js";
import { syncClipsRefs } from "../library/refs.js";

const describeSchema = z.object({
  title: z.string(),
  hook: z.string(),
  caption: z.string().default(""),
  hashtags: z.array(z.string()).max(8).default([]),
});

/** Bump when the describe prompt changes: saved describe steps (job_steps) are keyed on it. */
export const DESCRIBE_PROMPT_VERSION = "describe-1";

function segmentsIn(segments: TranscriptSegment[], start: number, end: number) {
  return segments.filter((s) => s.end > start + 0.05 && s.start < end - 0.05);
}

async function describe(o: LlmOpts, title: string, text: string): Promise<z.infer<typeof describeSchema>> {
  const prompt = `You write packaging for short-form clips (TikTok / Shorts / Reels) cut from a longer video titled "${title}".

Clip transcript:
${text}

Write:
- "title": specific, punchy, max 80 characters, never generic
- "hook": a 3-8 word on-screen text overlay in the voice of a creator, not a summary
- "caption": the post text, 1-2 sentences that make people watch, no hashtags
- "hashtags": up to 6, without the # symbol

Respond with JSON only: {"title":"...","hook":"...","caption":"...","hashtags":["..."]}`;
  try {
    const { output } = await generateText({ model: o.model, prompt, abortSignal: callSignal(o.signal, o.timeoutMs), maxRetries: 2, temperature: 0.5, output: Output.object({ schema: describeSchema, name: "describe" }) });
    return output;
  } catch (err) {
    if (!NoObjectGeneratedError.isInstance(err)) throw err;
    const r = (extractJson(err.text ?? "") ?? {}) as Record<string, unknown>;
    return {
      title: String(r.title ?? text.slice(0, 60)),
      hook: String(r.hook ?? ""),
      caption: String(r.caption ?? ""),
      hashtags: Array.isArray(r.hashtags) ? r.hashtags.map(String).slice(0, 8) : [],
    };
  }
}

/** The title / hook / caption call as one saved clip-scoped step. */
export function describeStep(ctx: Pick<StageContext, "step">, clipId: string, o: LlmOpts, modelId: string, unitMs: number, title: string, text: string) {
  return ctx.step("describe", { input: { title, text }, model: modelId, promptVersion: DESCRIBE_PROMPT_VERSION }, (sig) => describe({ ...o, signal: sig, timeoutMs: undefined }, title, text), { schema: describeSchema, timeoutMs: unitMs, model: modelId, clipId });
}

/**
 * A user-made clip whose AI preparation never completed (no reasoning note, no scores). Rendering it
 * would produce an untitled clip with the wrong bounds for "ai" mode, so every path that would render
 * it (render worker, re-render, retry, reconciler) routes it back through clip.prepare instead.
 */
export function needsPrepare(c: { origin: string; status: string; reasoning: string; scores: unknown }) {
  return c.status === "preparing" || (c.origin !== "ai" && !c.reasoning && !c.scores);
}
export const prepareModeOf = (c: { origin: string }) => (c.origin === "manual-ai" ? ("ai" as const) : ("exact" as const));

type Packaging = Pick<schema.Clip, "title" | "hook" | "caption" | "hashtags" | "emphasis" | "startSec" | "endSec">;

/**
 * What prepare may write: clips.update does not wait for prep, so a field the user changed while the model worked
 * (`current` differs from `started`, the row the job read) keeps the user's value. Bounds move as a pair. The scores
 * and reasoning are prep's own and always land (they also mark the clip prepared).
 */
export function preparedPatch(started: Packaging, current: Packaging, prepared: Packaging): Partial<Packaging> {
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const out: Partial<Packaging> = {};
  for (const k of ["title", "hook", "caption", "hashtags", "emphasis"] as const) if (same(started[k], current[k])) Object.assign(out, { [k]: prepared[k] });
  if (started.startSec === current.startSec && started.endSec === current.endSec) Object.assign(out, { startSec: prepared.startSec, endSec: prepared.endSec });
  return out;
}

/**
 * Rubric scores for candidates as one saved step (clip-scoped): the batches' raw answers are what is stored, and the
 * totals are worked out from them. A cancelled or timed-out call is never swallowed (scoreSample rethrows it).
 */
export async function scoreStep(ctx: Pick<StageContext, "step">, name: string, clipId: string, o: LlmOpts, modelId: string, unitMs: number, items: ScoreInput[], sc: SelectContext): Promise<Map<number, ScoreResult>> {
  const batches = scoreBatches(items);
  const answers = await ctx.step(
    name,
    { input: items, model: modelId, promptVersion: SCORE_PROMPT_VERSION, params: { sc, samples: 1 } },
    async (sig) => {
      const out: Array<z.infer<typeof scoreItem>> = [];
      for (const b of batches) out.push(...(await scoreSample({ ...o, signal: sig, timeoutMs: undefined }, b, sc, 1)));
      return out;
    },
    { schema: z.array(scoreItem), timeoutMs: unitMs * Math.max(1, batches.length), model: modelId, clipId },
  );
  return aggregateScores(items, sc, [answers]);
}

/**
 * The "ai" mode search over the user's selection: windowed like a full analysis (a long selection in one prompt is read
 * badly and times out), every window a saved clip-scoped step so a retry maps only the windows still missing. A window
 * the model answered badly is skipped; a timeout, a cancel or a superseded job ends the run.
 */
export async function mapSelection(
  ctx: Pick<StageContext, "step" | "signal" | "progress">,
  o: LlmOpts,
  a: { inside: TranscriptSegment[]; sc: SelectContext; clipId: string; modelId: string; unitMs: number; concurrency: number; log: Logger },
): Promise<ClipCandidate[]> {
  const chunks = chunkTranscript(a.inside);
  const candidatesSchema = z.array(clipCandidateSchema);
  let mapped = 0;
  const perChunk = await mapLimit(chunks, a.concurrency, async (ch, i) => {
    ctx.signal.throwIfAborted();
    const found = await ctx
      .step(`map:${i}`, { input: { lines: ch.lines, start: ch.start, end: ch.end }, model: a.modelId, promptVersion: MAP_PROMPT_VERSION, params: a.sc }, (sig) => mapChunk({ ...o, signal: sig, timeoutMs: undefined }, ch, a.sc), { schema: candidatesSchema, timeoutMs: a.unitMs, model: a.modelId, clipId: a.clipId })
      .catch((err: unknown): ClipCandidate[] => {
        if (err instanceof StageTimeoutError || err instanceof StaleJobError || err instanceof ProjectGoneError || isAbortError(err) || ctx.signal.aborted) throw err;
        a.log.warn({ err, window: i }, "candidate search failed for a window");
        return [];
      });
    await ctx.progress(0.1 + 0.4 * (++mapped / chunks.length), `Looking for the best moment in your selection (${mapped}/${chunks.length})`, { clipId: a.clipId }).catch(() => {});
    return found;
  });
  return perChunk.flat();
}

export async function prepareClip(ctx: StageContext, clipId: string, mode: "exact" | "ai") {
  const { svc, db, projectId } = ctx;
  const clip = await db.query.clips.findFirst({ where: eq(schema.clips.id, clipId) });
  if (!clip || clip.deletedAt || !needsPrepare(clip)) return; // deleted, or already prepared before a crash
  const project = await ctx.project();
  const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId) });
  if (!transcript) throw new Error("Transcript missing");
  const settings = project.settings;
  const segments = transcript.segments;
  const durationSec = project.durationSec ?? transcript.words.at(-1)?.end ?? clip.endSec;
  const log = ctx.log.child({ clipId, mode });
  const modelId = svc.models.get().language;
  const unitMs = ctx.unitTimeoutMs(modelId);
  // each call is a saved, clip-scoped step with its own limit (inside a step the step's signal carries it)
  const o: LlmOpts = { model: await svc.ai.languageModel(), signal: ctx.signal, telemetry: svc.otel.enabled, log, timeoutMs: unitMs };
  const selfHosted = isSelfHostedModel({ AI_MODEL: modelId, OPENAI_BASE_URL: svc.providers.get("openai").baseUrl });
  const concurrency = svc.config.ANALYZE_CONCURRENCY || (selfHosted ? 1 : 4);
  const selLen = clip.endSec - clip.startSec;

  let pick: ClipCandidate = { title: clip.title, hook: clip.hook, startSec: clip.startSec, endSec: clip.endSec, score: 50, reasoning: clip.reasoning, caption: "", hashtags: [] };
  let note = "Created from a transcript selection.";

  if (mode === "ai") {
    await ctx.progress(0.1, "Looking for the best moment in your selection", { clipId });
    const inside = segmentsIn(segments, clip.startSec, clip.endSec);
    const minSec = Math.max(5, Math.min(settings.minClipSeconds, Math.round(selLen * 0.4)));
    const maxSec = Math.max(minSec + 1, Math.min(settings.maxClipSeconds, Math.ceil(selLen)));
    const sc: SelectContext = { title: project.title, durationSec, minSec, maxSec, focus: settings.focus, instructions: settings.instructions };
    const found = await mapSelection(ctx, o, { inside, sc, clipId, modelId, unitMs, concurrency, log });
    const local = { ...settings, minClipSeconds: minSec, maxClipSeconds: maxSec };
    const snapped = found
      .map((c) => snapCandidate(c, inside, transcript.sceneCuts ?? [], local, durationSec, { words: transcript.words, log, bounds: [clip.startSec, clip.endSec] }))
      .filter((c): c is ClipCandidate => !!c && c.startSec >= clip.startSec - 1 && c.endSec <= clip.endSec + 1);
    log.info({ selection: [clip.startSec, clip.endSec], minSec, maxSec, modelPicks: found.map((c) => [c.startSec, c.endSec]), usable: snapped.length }, "searched selection");
    if (snapped.length) {
      await ctx.progress(0.5, `Scoring ${snapped.length} option(s)`, { clipId });
      const texts = snapped.map((c, id) => ({ id, durationSec: c.endSec - c.startSec, text: segmentsIn(segments, c.startSec, c.endSec).map((s) => s.text.trim()).join(" ") }));
      const scored = await scoreStep(ctx, "pick-score", clipId, o, modelId, unitMs, texts, sc);
      const best = snapped.map((c, id) => ({ c, t: scored.get(id)?.total ?? c.score })).sort((a, b) => b.t - a.t)[0]!;
      pick = best.c;
      note = `AI picked ${fmtTs(pick.startSec)}–${fmtTs(pick.endSec)} from your selection (${snapped.length} option${snapped.length > 1 ? "s" : ""}). ${pick.reasoning}`;
    } else {
      note = "No tighter standalone moment found inside the selection; kept all of it.";
    }
  }

  // exact clips (and AI fallbacks) still need packaging
  const text = segmentsIn(segments, pick.startSec, pick.endSec)
    .map((s) => s.text.trim())
    .join(" ")
    .slice(0, 4000);
  if (mode === "exact" || !pick.caption) {
    await ctx.progress(0.6, "Writing title, hook and caption", { clipId });
    const d = await describeStep(ctx, clipId, o, modelId, unitMs, project.title, text);
    pick = normalizeCandidate({ ...pick, title: d.title || pick.title, hook: d.hook || pick.hook, caption: d.caption, hashtags: d.hashtags });
  }
  await ctx.progress(0.8, "Scoring", { clipId });
  const sc: SelectContext = { title: project.title, durationSec, minSec: 1, maxSec: 9999, focus: settings.focus };
  const scored = (await scoreStep(ctx, "score", clipId, o, modelId, unitMs, [{ id: 0, durationSec: pick.endSec - pick.startSec, text }], sc)).get(0);

  const template = await templateForNewClips(db, project.userId, settings.layerTemplateId, log);
  const prepared: Packaging = {
    title: pick.title.slice(0, 120),
    hook: pick.hook.slice(0, 80),
    caption: (pick.caption ?? "").slice(0, 300),
    hashtags: pick.hashtags.map((h) => h.replace(/^#/, "")).slice(0, 8),
    emphasis: scored?.emphasis.length ? scored.emphasis : null,
    startSec: Number(pick.startSec.toFixed(2)),
    endSec: Number(pick.endSec.toFixed(2)),
  };
  // packaging written, announced and the render queued in one commit
  await svc.tx(async (u) => {
    // the row as it is now, locked: the user's edits since this job read it win (preparedPatch)
    const [cur] = await u.db.select().from(schema.clips).where(and(eq(schema.clips.id, clipId), isNull(schema.clips.deletedAt))).for("update");
    if (!cur || !needsPrepare(cur)) return log.info("clip deleted or prepared meanwhile; nothing to write");
    const patch = preparedPatch(clip, cur, prepared);
    const bounds = { startSec: patch.startSec ?? cur.startSec, endSec: patch.endSec ?? cur.endSec };
    // the project's layer template, placed against the final bounds; a clip that already has layers keeps them
    const layers = clipLayers(cur).length ? null : layersForNewClip(template, bounds);
    await requestRender(svc, u, projectId, clipId, { ...patch, score: scored?.total ?? 50, scores: scored?.scores ?? null, reasoning: note.slice(0, 1000), ...(layers ? { layers } : {}) });
    if (layers) await syncClipsRefs(u.db, projectId, [{ id: clipId, bumpers: cur.bumpers, layers }]);
    await u.emit(projectId, "clip.created", { clipId, index: cur.index, title: patch.title ?? cur.title });
  });
  void db;
}
