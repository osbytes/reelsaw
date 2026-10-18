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
import { eq } from "drizzle-orm";
import { generateText, Output, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { schema } from "../db/index.js";
import { QUEUES } from "../queue/boss.js";
import type { StageContext } from "./common.js";
import { snapCandidate } from "./analyze.js";
import { extractJson, mapChunk, normalizeCandidate, scoreCandidates, type LlmOpts, type SelectContext, type Chunk } from "./select.js";
import { fmtTs } from "./transcript.js";
import type { ClipCandidate, TranscriptSegment } from "@reelsaw/shared";

const describeSchema = z.object({
  title: z.string(),
  hook: z.string(),
  caption: z.string().default(""),
  hashtags: z.array(z.string()).max(8).default([]),
});

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
    const { output } = await generateText({ model: o.model, prompt, abortSignal: o.signal, maxRetries: 2, temperature: 0.5, output: Output.object({ schema: describeSchema, name: "describe" }) });
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

/**
 * A user-made clip whose AI preparation never completed (no reasoning note, no scores). Rendering it
 * would produce an untitled clip with the wrong bounds for "ai" mode, so every path that would render
 * it (render worker, re-render, retry, reconciler) routes it back through clip.prepare instead.
 */
export function needsPrepare(c: { origin: string; status: string; reasoning: string; scores: unknown }) {
  return c.status === "preparing" || (c.origin !== "ai" && !c.reasoning && !c.scores);
}
export const prepareModeOf = (c: { origin: string }) => (c.origin === "manual-ai" ? ("ai" as const) : ("exact" as const));

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
  const o: LlmOpts = { model: await svc.ai.languageModel(), signal: ctx.signal, telemetry: svc.otel.enabled, log };
  const selLen = clip.endSec - clip.startSec;

  let pick: ClipCandidate = { title: clip.title, hook: clip.hook, startSec: clip.startSec, endSec: clip.endSec, score: 50, reasoning: clip.reasoning, caption: "", hashtags: [] };
  let note = "Created from a transcript selection.";

  if (mode === "ai") {
    await ctx.progress(0.1, "Looking for the best moment in your selection", { clipId });
    const inside = segmentsIn(segments, clip.startSec, clip.endSec);
    const minSec = Math.max(5, Math.min(settings.minClipSeconds, Math.round(selLen * 0.4)));
    const maxSec = Math.max(minSec + 1, Math.min(settings.maxClipSeconds, Math.ceil(selLen)));
    const sc: SelectContext = { title: project.title, durationSec, minSec, maxSec, focus: settings.focus, instructions: settings.instructions };
    const chunk: Chunk = { lines: inside.map((s) => `[${fmtTs(s.start)} - ${fmtTs(s.end)}] ${s.text}`), start: clip.startSec, end: clip.endSec };
    const found = inside.length
      ? await mapChunk(o, chunk, sc).catch((err) => {
          log.warn({ err }, "candidate search failed");
          return [] as ClipCandidate[];
        })
      : [];
    const local = { ...settings, minClipSeconds: minSec, maxClipSeconds: maxSec };
    const snapped = found
      .map((c) => snapCandidate(c, inside, transcript.sceneCuts ?? [], local, durationSec, { words: transcript.words, log, bounds: [clip.startSec, clip.endSec] }))
      .filter((c): c is ClipCandidate => !!c && c.startSec >= clip.startSec - 1 && c.endSec <= clip.endSec + 1);
    log.info({ selection: [clip.startSec, clip.endSec], minSec, maxSec, modelPicks: found.map((c) => [c.startSec, c.endSec]), usable: snapped.length }, "searched selection");
    if (snapped.length) {
      await ctx.progress(0.5, `Scoring ${snapped.length} option(s)`, { clipId });
      const texts = snapped.map((c, id) => ({ id, durationSec: c.endSec - c.startSec, text: segmentsIn(segments, c.startSec, c.endSec).map((s) => s.text.trim()).join(" ") }));
      const scored = await scoreCandidates(o, texts, sc, 1, 1);
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
    const d = await describe(o, project.title, text);
    pick = normalizeCandidate({ ...pick, title: d.title || pick.title, hook: d.hook || pick.hook, caption: d.caption, hashtags: d.hashtags });
  }
  await ctx.progress(0.8, "Scoring", { clipId });
  const sc: SelectContext = { title: project.title, durationSec, minSec: 1, maxSec: 9999, focus: settings.focus };
  const scored = (await scoreCandidates(o, [{ id: 0, durationSec: pick.endSec - pick.startSec, text }], sc, 1, 1)).get(0);

  // packaging written, announced and the render queued in one commit
  await svc.tx(async (u) => {
    await requestRender(svc, u, projectId, clipId, {
      title: pick.title.slice(0, 120),
      hook: pick.hook.slice(0, 80),
      caption: (pick.caption ?? "").slice(0, 300),
      hashtags: pick.hashtags.map((h) => h.replace(/^#/, "")).slice(0, 8),
      startSec: Number(pick.startSec.toFixed(2)),
      endSec: Number(pick.endSec.toFixed(2)),
      score: scored?.total ?? 50,
      scores: scored?.scores ?? null,
      emphasis: scored?.emphasis.length ? scored.emphasis : null,
      reasoning: note.slice(0, 1000),
    });
    await u.emit(projectId, "clip.created", { clipId, index: clip.index, title: pick.title });
  });
  void db;
}
