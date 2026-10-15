import { detectOverlays } from "./overlays.js";
import type { SourceOverlay } from "@reelsaw/shared";
import { eq, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import { QUEUES } from "../queue/boss.js";
import { StageContext } from "./common.js";
import { correctTranscript, applyFlags } from "./entities.js";
import { detectDisfluencies } from "./disfluency.js";
import { toSentences } from "./transcript.js";
import { REFINE_STEPS, type RefineStep, type RefineStatus, type TranscriptFlag } from "@reelsaw/shared";

/**
 * Refine stage = three independent jobs after transcription:
 *   entities   – misheard names → flags (kind "entity")
 *   disfluency – fillers / repeats / false starts → flags (kind "disfluency")
 *   scenes     – ffmpeg scene cuts
 * Each writes its result through `mergeRefine`, which serialises on the transcript row, resolves
 * overlapping flags (entity wins), recomputes words/segments, and enqueues analyze once every step
 * is done or has given up. A step that exhausts its retries is marked failed but never blocks the
 * project: these are enhancements, not requirements.
 */

export const REFINE_QUEUE: Record<RefineStep, (typeof QUEUES)[keyof typeof QUEUES]> = {
  entities: QUEUES.refineEntities,
  disfluency: QUEUES.refineDisfluency,
  scenes: QUEUES.refineScenes,
};

export function stepEnabled(svc: Services, step: RefineStep): boolean {
  if (step === "entities") return svc.config.TRANSCRIPT_CORRECTION;
  if (step === "disfluency") return svc.config.DISFLUENCY_REMOVAL;
  return true;
}

/** Mark the project as refining and queue every enabled step that is not already done. */
export async function enqueueRefine(svc: Services, projectId: string, steps: readonly RefineStep[] = REFINE_STEPS) {
  const db = svc.database.db;
  const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId), columns: { refine: true } });
  if (!t) throw new Error("no transcript to refine");
  const refine: RefineStatus = { ...t.refine };
  const toRun = steps.filter((s) => stepEnabled(svc, s) && refine[s] !== "done");
  for (const s of REFINE_STEPS) if (!stepEnabled(svc, s)) refine[s] = "done"; // disabled steps count as done
  for (const s of toRun) refine[s] = "queued";
  await db.update(schema.transcripts).set({ refine }).where(eq(schema.transcripts.projectId, projectId));
  await db.update(schema.projects).set({ status: "refining", stage: "refine", stageProgress: 0, error: null, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
  await svc.events.emit(projectId, "stage.started", { stage: "refine", status: "refining", steps: toRun });
  for (const s of toRun) await svc.queue.enqueue(REFINE_QUEUE[s], { projectId });
  if (!toRun.length) await finishIfComplete(svc, projectId);
}

function overlaps(a: TranscriptFlag, b: TranscriptFlag) {
  return a.wordIndex < b.wordIndex + b.span && b.wordIndex < a.wordIndex + a.span;
}

/** Carry user decisions over when a step re-runs and finds the same span again. */
function carryDecisions(prev: TranscriptFlag[], next: TranscriptFlag[]): TranscriptFlag[] {
  return next.map((f) => {
    const old = prev.find((p) => p.kind === f.kind && p.wordIndex === f.wordIndex && p.span === f.span);
    if (old && (old.status === "accepted" || old.status === "rejected")) return { ...f, status: old.status, replacement: old.replacement };
    return f;
  });
}

/**
 * Apply a step's result under a row lock, recompute the derived transcript, and advance the
 * project when all steps are finished.
 */
export async function mergeRefine(
  svc: Services,
  projectId: string,
  step: RefineStep,
  result: { status: "done" | "failed"; flags?: TranscriptFlag[]; sceneCuts?: number[]; overlays?: SourceOverlay[] },
) {
  const db = svc.database.db;
  const allDone = await db.transaction(async (tx) => {
    const [t] = await tx.select().from(schema.transcripts).where(eq(schema.transcripts.projectId, projectId)).for("update");
    if (!t) return false;
    const raw = t.rawWords ?? t.words;
    let flags = t.flags;
    if (result.flags) {
      const kind = step === "entities" ? "entity" : "disfluency";
      const kept = flags.filter((f) => f.kind !== kind);
      let incoming = carryDecisions(flags.filter((f) => f.kind === kind), result.flags);
      if (kind === "disfluency") incoming = incoming.filter((f) => !kept.some((k) => k.kind === "entity" && overlaps(k, f)));
      else {
        // entity flags win: drop disfluency flags that overlap a new entity span
        flags = kept.filter((k) => !(k.kind === "disfluency" && incoming.some((f) => overlaps(k, f))));
        incoming = incoming;
      }
      flags = [...(kind === "entity" ? flags : kept), ...incoming].sort((a, b) => a.wordIndex - b.wordIndex);
    }
    const words = applyFlags(raw, flags);
    const segments = toSentences(words);
    const refine: RefineStatus = { ...t.refine, [step]: result.status };
    await tx
      .update(schema.transcripts)
      .set({
        flags,
        words,
        segments,
        text: segments.map((s) => s.text).join(" "),
        refine,
        ...(result.sceneCuts !== undefined ? { sceneCuts: result.sceneCuts } : {}),
        ...(result.overlays !== undefined ? { overlays: result.overlays } : {}),
      })
      .where(eq(schema.transcripts.projectId, projectId));
    return REFINE_STEPS.every((s) => refine[s] === "done" || refine[s] === "failed");
  });
  const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId), columns: { refine: true } });
  const finished = REFINE_STEPS.filter((s) => t?.refine[s] === "done" || t?.refine[s] === "failed").length;
  await svc.events.emit(projectId, "stage.progress", { stage: "refine", progress: finished / REFINE_STEPS.length, message: `${step} ${result.status}`, step, refine: t?.refine });
  if (allDone) await finishIfComplete(svc, projectId);
}

export async function finishIfComplete(svc: Services, projectId: string) {
  const db = svc.database.db;
  const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId), columns: { refine: true } });
  if (!t || !REFINE_STEPS.every((s) => t.refine[s] === "done" || t.refine[s] === "failed")) return;
  const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId), columns: { status: true } });
  if (!p || p.status !== "refining") return;
  await db
    .update(schema.projects)
    .set({ status: "analyzing", stage: "analyze", stageProgress: 0, updatedAt: new Date() })
    .where(eq(schema.projects.id, projectId));
  await svc.events.emit(projectId, "stage.completed", { stage: "refine", refine: t.refine });
  await svc.queue.enqueue(QUEUES.analyze, { projectId });
}

async function markRunning(ctx: StageContext, step: RefineStep) {
  await ctx.db
    .update(schema.transcripts)
    .set({ refine: sql`coalesce(${schema.transcripts.refine}, '{}'::jsonb) || ${JSON.stringify({ [step]: "running" })}::jsonb` })
    .where(eq(schema.transcripts.projectId, ctx.projectId));
  await ctx.svc.events.emit(ctx.projectId, "stage.progress", { stage: "refine", step, message: `${step} running` });
}

async function loadTranscript(ctx: StageContext) {
  const t = await ctx.db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, ctx.projectId) });
  if (!t) throw new Error("Transcript missing; transcribe must run first");
  return t;
}

export async function refineEntities(ctx: StageContext) {
  const { svc } = ctx;
  const t = await loadTranscript(ctx);
  if (t.refine.entities === "done") return;
  await markRunning(ctx, "entities");
  const project = await ctx.project();
  const raw = t.rawWords ?? t.words;
  const res = await correctTranscript(
    await svc.ai.languageModel(),
    raw,
    t.entities,
    { title: project.title, uploader: project.sourceMeta?.uploader as string | undefined },
    { signal: ctx.signal, telemetry: svc.otel.enabled, autoConfidence: svc.config.TRANSCRIPT_AUTO_FIX_CONFIDENCE, log: ctx.log },
  );
  ctx.log.info({ step: "entities", auto: res.applied.length, pending: res.flags.length - res.applied.length, candidates: res.candidates }, "refine step done");
  await mergeRefine(svc, ctx.projectId, "entities", { status: "done", flags: res.flags });
}

export async function refineDisfluency(ctx: StageContext) {
  const { svc } = ctx;
  const t = await loadTranscript(ctx);
  if (t.refine.disfluency === "done") return;
  await markRunning(ctx, "disfluency");
  const raw = t.rawWords ?? t.words;
  const reserved = new Set<number>();
  for (const f of t.flags) if (f.kind === "entity") for (let k = 0; k < f.span; k++) reserved.add(f.wordIndex + k);
  const flags = await detectDisfluencies(svc.config.DISFLUENCY_LLM ? await svc.ai.languageModel() : null, raw, {
    signal: ctx.signal,
    telemetry: svc.otel.enabled,
    autoConfidence: svc.config.TRANSCRIPT_AUTO_FIX_CONFIDENCE,
    reserved,
  });
  ctx.log.info({ step: "disfluency", removed: flags.filter((f) => f.status === "auto").length, flagged: flags.filter((f) => f.status === "pending").length }, "refine step done");
  await mergeRefine(svc, ctx.projectId, "disfluency", { status: "done", flags });
}

export async function refineScenes(ctx: StageContext) {
  const { svc } = ctx;
  const t = await loadTranscript(ctx);
  if (t.refine.scenes === "done") return;
  await markRunning(ctx, "scenes");
  const project = await ctx.project();
  const sourcePath = await ctx.ensureSource(project);
  const sceneCuts = project.width ? await svc.media.detectScenes(sourcePath, undefined, ctx.signal) : [];
  // burned-in captions / watermarks: best effort, never fails the step
  let overlays: SourceOverlay[] = [];
  if (svc.text && project.width && project.durationSec) {
    try {
      const scan = await detectOverlays({ detector: svc.text, ffmpegPath: svc.config.FFMPEG_PATH, signal: ctx.signal }, sourcePath, project.durationSec, sceneCuts);
      overlays = scan.overlays;
      ctx.log.info({ step: "scenes", frames: scan.frames, shots: scan.scenes, overlays }, "on-screen text scan");
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warn({ err }, "on-screen text scan failed, continuing without it");
    }
  }
  ctx.log.info({ step: "scenes", cuts: sceneCuts.length, overlays: overlays.length }, "refine step done");
  await mergeRefine(svc, ctx.projectId, "scenes", { status: "done", sceneCuts, overlays });
}

/** Called by the worker when a refine job has exhausted its retries. */
export async function refineStepFailed(svc: Services, projectId: string, step: RefineStep, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  svc.log.error({ stage: "refine", step, projectId, error: message }, "refine step gave up");
  await svc.events.emit(projectId, "stage.failed", { stage: "refine", step, error: message.slice(0, 500), attempt: 0, max: 0, final: true });
  await mergeRefine(svc, projectId, step, { status: "failed" });
}
