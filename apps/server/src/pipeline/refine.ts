import { detectOverlays } from "./overlays.js";
import type { SourceOverlay, TextProfile } from "@reelsaw/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { QUEUES } from "../queue/boss.js";
import { StageContext, StaleJobError, currentStage, lockCurrentStage, modelsUsed, stageElapsed } from "./common.js";
import { correctTranscript, applyFlags } from "./entities.js";
import { detectDisfluencies, type DisfluencyTraceEntry } from "./disfluency.js";
import { toSentences } from "./transcript.js";
import { skipReason, supports, type LanguageStage } from "./language.js";
import { REFINE_STEPS, type RefineStep, type RefineStatus, type TranscriptFlag } from "@reelsaw/shared";
import { refineStepOn, resolveRefineOptions, type RefineOptions } from "./refine-options.js";

/**
 * Refine stage = three independent jobs after transcription:
 *   entities   – misheard names → flags (kind "entity")
 *   disfluency – fillers / repeats / false starts → flags (kind "disfluency")
 *   scenes     – ffmpeg scene cuts
 * Each writes its result through `mergeRefine`, which serialises on the transcript row, resolves
 * overlapping flags (entity wins), recomputes words/segments, and enqueues analyze once every step
 * is done or has given up. A step that exhausts its retries is marked failed but never blocks the
 * project: these are enhancements, not requirements.
 *
 * Which steps run: instance gates (env → Settings → System → Pipeline) then the project's
 * refineEntities / refineDisfluency / disfluencyLlm / refineScenes (see refine-options.ts).
 */

export const REFINE_QUEUE: Record<RefineStep, (typeof QUEUES)[keyof typeof QUEUES]> = {
  entities: QUEUES.refineEntities,
  disfluency: QUEUES.refineDisfluency,
  scenes: QUEUES.refineScenes,
};

async function optionsFor(svc: Services, db: Db, projectId: string): Promise<RefineOptions> {
  const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId), columns: { settings: true } });
  return resolveRefineOptions(svc.settings.get(), p?.settings ?? {});
}

export interface EnqueueRefineOptions {
  /**
   * A user-initiated call: flip the project to refining only while it is idle (done / failed) or already refining, and
   * return false (nothing written, nothing queued) when something else is running. Pipeline callers flip unconditionally.
   */
  onlyIfIdle?: boolean;
}

/**
 * Mark the project as refining and queue every enabled step that is not already done. `seq` is the stage version the
 * caller belongs to: the project flip commits only while it is current (StaleJobError otherwise); undefined takes any.
 * Returns false only for `onlyIfIdle` when the project was busy.
 */
export async function enqueueRefine(svc: Services, projectId: string, seq: number | undefined, steps: readonly RefineStep[] = REFINE_STEPS, u?: UnitOfWork, o: EnqueueRefineOptions = {}): Promise<boolean> {
  if (!u) return svc.tx((tx) => enqueueRefine(svc, projectId, seq, steps, tx, o));
  const db = u.db;
  const [t] = await db.select({ refine: schema.transcripts.refine }).from(schema.transcripts).where(eq(schema.transcripts.projectId, projectId)).for("update");
  if (!t) throw new Error("no transcript to refine");
  const opts = await optionsFor(svc, db, projectId);
  const refine: RefineStatus = { ...t.refine };
  const toRun = steps.filter((s) => refineStepOn(opts, s) && refine[s] !== "done");
  for (const s of REFINE_STEPS) if (!refineStepOn(opts, s)) refine[s] = "done"; // disabled steps count as done
  for (const s of toRun) refine[s] = "queued";
  const idle = o.onlyIfIdle ? inArray(schema.projects.status, ["done", "failed", "refining"]) : undefined;
  const [flipped] = await db
    .update(schema.projects)
    .set({ status: "refining", stage: "refine", stageProgress: 0, error: null, stageStartedAt: sql`now()`, updatedAt: new Date() })
    .where(and(currentStage(projectId, seq), idle))
    .returning({ id: schema.projects.id });
  if (!flipped) {
    if (o.onlyIfIdle && (await db.select({ id: schema.projects.id }).from(schema.projects).where(currentStage(projectId, seq))).length) return false;
    throw new StaleJobError(projectId, seq);
  }
  await db.update(schema.transcripts).set({ refine }).where(eq(schema.transcripts.projectId, projectId));
  await u.emit(projectId, "stage.started", { stage: "refine", status: "refining", steps: toRun });
  for (const s of toRun) await u.enqueue(REFINE_QUEUE[s], { projectId });
  if (!toRun.length) await finishIfComplete(svc, projectId, u);
  return true;
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

const SKIP_LABEL: Partial<Record<RefineStep, string>> = { entities: "Name fixes", disfluency: "Filler and repeat removal" };
function skipMessage(step: RefineStep, reason: string, language: string | null) {
  return `${SKIP_LABEL[step] ?? step} skipped: ${reason}${language ? ` (the video was transcribed as ${language})` : ""}. Review the transcript by hand if you need it.`;
}

/** Steps whose rules and word lists only exist for some languages are skipped for others, not run blind. */
const STEP_LANGUAGE_STAGE: Partial<Record<RefineStep, LanguageStage>> = { entities: "entityPhonetics", disfluency: "disfluencyRules" };
function unsupportedLanguage(step: RefineStep, language: string | null): string | null {
  const stage = STEP_LANGUAGE_STAGE[step];
  return stage && !supports(stage, language) ? skipReason(language) : null;
}

/**
 * Apply a step's result under a row lock, recompute the derived transcript, and advance the
 * project when all steps are finished.
 */
export async function mergeRefine(
  svc: Services,
  projectId: string,
  step: RefineStep,
  result: { status: "done" | "failed"; error?: string; flags?: TranscriptFlag[]; sceneCuts?: number[]; overlays?: SourceOverlay[]; textProfile?: TextProfile; skipped?: string; artifact?: { data: unknown; models: Record<string, string> } },
  /** the step job's projects.stage_seq: a superseded step merges nothing and hands nothing to analyze */
  seq?: number,
) {
  // one unit: merged flags, step status, progress event and (if last) the hand-off to analyze
  await svc.tx(async (u) => {
    const tx = u.db;
    const [t] = await tx.select().from(schema.transcripts).where(eq(schema.transcripts.projectId, projectId)).for("update");
    if (!t) return;
    if (!(await lockCurrentStage(tx, projectId, seq))) return svc.log.child({ module: "refine", projectId }).info({ step, seq }, "refine step superseded; result dropped"); // transcript, then project
    if (result.status === "failed" && result.error !== undefined) {
      // a step that gave up: its stage.failed commits with the "failed" status it announces
      const durationSec = await stageElapsed(tx, projectId, "refine");
      await u.emit(projectId, "stage.failed", { stage: "refine", step, error: result.error.slice(0, 500), attempt: 0, max: 0, final: true, ...(durationSec !== undefined ? { durationSec } : {}) });
    }
    if (result.artifact) await u.artifact(projectId, "refine", step, result.artifact.data, result.artifact.models);
    const raw = t.rawWords ?? t.words;
    let flags = t.flags;
    if (result.flags) {
      const kind = step === "entities" ? "entity" : "disfluency";
      // manual cuts are the user's, not the detector's: they survive a re-run
      const isManual = (f: (typeof flags)[number]) => f.subkind === "manual";
      const kept = flags.filter((f) => f.kind !== kind || isManual(f));
      let incoming = carryDecisions(flags.filter((f) => f.kind === kind && !isManual(f)), result.flags);
      // fixes the user deleted stay deleted when the detector finds them again
      incoming = incoming.filter((f) => !(t.deletedFlags ?? []).some((d) => d.kind === f.kind && d.wordIndex === f.wordIndex && d.span === f.span));
      // nothing the detector finds may overlap a fix the user made by hand
      incoming = incoming.filter((f) => !kept.some((k) => isManual(k) && overlaps(k, f)));
      if (kind === "disfluency") incoming = incoming.filter((f) => !kept.some((k) => (k.kind === "entity" || k.kind === "loop") && overlaps(k, f)));
      else {
        // entity flags win over detector cuts; loop collapses stay (rawWords still has the run)
        flags = kept.filter((k) => !(k.kind === "disfluency" && !isManual(k) && incoming.some((f) => overlaps(k, f))));
        incoming = incoming.filter((f) => !kept.some((k) => k.kind === "loop" && overlaps(k, f)));
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
        ...(result.textProfile !== undefined ? { textProfile: result.textProfile } : {}),
      })
      .where(eq(schema.transcripts.projectId, projectId));
    const finished = REFINE_STEPS.filter((s) => refine[s] === "done" || refine[s] === "failed").length;
    await u.emit(projectId, "stage.progress", { stage: "refine", progress: finished / REFINE_STEPS.length, message: `${step} ${result.status}`, step, refine });
    if (result.skipped) await u.emit(projectId, "stage.progress", { stage: "refine", step, skipped: { status: "skipped", reason: result.skipped }, message: skipMessage(step, result.skipped, t.language) });
    if (finished === REFINE_STEPS.length) await finishIfComplete(svc, projectId, u);
  });
}

/**
 * Hand a fully refined project to analyze. The status flip is conditional (refining → analyzing),
 * so when the last step and the reconciler race, exactly one emits and enqueues.
 */
export async function finishIfComplete(svc: Services, projectId: string, u?: UnitOfWork): Promise<void> {
  if (!u) return svc.tx((tx) => finishIfComplete(svc, projectId, tx));
  const t = await u.db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId), columns: { refine: true } });
  if (!t || !REFINE_STEPS.every((s) => t.refine[s] === "done" || t.refine[s] === "failed")) return;
  const durationSec = await stageElapsed(u.db, projectId, "refine");
  const moved = await u.db
    .update(schema.projects)
    .set({ status: "analyzing", stage: "analyze", stageProgress: 0, stageStartedAt: sql`now()`, updatedAt: new Date() })
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.status, "refining")))
    .returning({ id: schema.projects.id });
  if (!moved.length) return;
  await u.emit(projectId, "stage.completed", { stage: "refine", ...(durationSec !== undefined ? { durationSec } : {}), refine: t.refine });
  await u.enqueue(QUEUES.analyze, { projectId });
}

/** The step's status and its event commit together (atomic jsonb merge, so no row lock is needed for the write). */
async function markRunning(ctx: StageContext, step: RefineStep) {
  await ctx.svc.tx(async (u) => {
    await u.db
      .update(schema.transcripts)
      .set({ refine: sql`coalesce(${schema.transcripts.refine}, '{}'::jsonb) || ${JSON.stringify({ [step]: "running" })}::jsonb` })
      .where(eq(schema.transcripts.projectId, ctx.projectId));
    await u.emit(ctx.projectId, "stage.progress", { stage: "refine", step, message: `${step} running` });
  });
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
  const skip = unsupportedLanguage("entities", t.language);
  if (skip) {
    ctx.log.info({ step: "entities", language: t.language, skipped: skip }, "refine step skipped");
    return mergeRefine(svc, ctx.projectId, "entities", { status: "done", skipped: skip }, ctx.seq);
  }
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
  ctx.log.debug(
    {
      entities: t.entities.length,
      applied: res.applied.map((a) => ({ heard: a.heard, entity: a.entity, at: Number(a.at.toFixed(1)) })),
      pending: res.flags.filter((f) => f.status === "pending").map((f) => ({ heard: f.heard, suggested: f.suggested, confidence: f.confidence, at: Number(f.start.toFixed(1)) })),
    },
    "entity corrections",
  );
  ctx.log.info({ step: "entities", auto: res.applied.length, pending: res.flags.length - res.applied.length, candidates: res.candidates }, "refine step done");
  await mergeRefine(svc, ctx.projectId, "entities", { status: "done", flags: res.flags, artifact: { data: res.trace ?? null, models: modelsUsed(svc, "language") } }, ctx.seq);
}

/**
 * Cuts the user rejected in their other projects, as "… [words] …" snippets: the verifier sees them
 * as examples of what not to cut, so the detector learns this user's taste over time.
 */
async function rejectedCutExamples(svc: Services, projectId: string, max = 8): Promise<string[]> {
  const db = svc.database.db;
  const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId), columns: { userId: true } });
  if (!p) return [];
  const others = await db.query.projects.findMany({ where: eq(schema.projects.userId, p.userId), columns: { id: true }, orderBy: desc(schema.projects.updatedAt), limit: 20 });
  const out: string[] = [];
  for (const o of others) {
    if (o.id === projectId || out.length >= max) continue;
    const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, o.id), columns: { flags: true, rawWords: true, words: true } });
    const ws = t?.rawWords ?? t?.words ?? [];
    for (const f of t?.flags ?? []) {
      if (f.kind !== "disfluency" || f.status !== "rejected" || f.subkind === "manual" || out.length >= max) continue;
      const a = f.wordIndex;
      const b = f.wordIndex + f.span;
      out.push(`…${ws.slice(Math.max(0, a - 6), a).map((w) => w.text).join(" ")} [${ws.slice(a, b).map((w) => w.text).join(" ")}] ${ws.slice(b, b + 5).map((w) => w.text).join(" ")}…`);
    }
  }
  return out;
}

export async function refineDisfluency(ctx: StageContext) {
  const { svc } = ctx;
  const t = await loadTranscript(ctx);
  if (t.refine.disfluency === "done") return;
  const skip = unsupportedLanguage("disfluency", t.language);
  if (skip) {
    ctx.log.info({ step: "disfluency", language: t.language, skipped: skip }, "refine step skipped");
    return mergeRefine(svc, ctx.projectId, "disfluency", { status: "done", skipped: skip }, ctx.seq);
  }
  await markRunning(ctx, "disfluency");
  const opts = await optionsFor(svc, svc.database.db, ctx.projectId);
  const useLlm = opts.disfluencyLlm;
  const raw = t.rawWords ?? t.words;
  const reserved = new Set<number>();
  for (const f of t.flags) if (f.kind === "entity" || f.kind === "loop" || f.subkind === "manual") for (let k = 0; k < f.span; k++) reserved.add(f.wordIndex + k);
  const trace: DisfluencyTraceEntry[] = [];
  const flags = await detectDisfluencies(useLlm ? await svc.ai.languageModel() : null, raw, {
    signal: ctx.signal,
    telemetry: svc.otel.enabled,
    autoConfidence: svc.config.TRANSCRIPT_AUTO_FIX_CONFIDENCE,
    reserved,
    rejectedExamples: await rejectedCutExamples(svc, ctx.projectId).catch(() => []),
  }, trace);
  const byOutcome: Record<string, number> = {};
  for (const e of trace) byOutcome[e.outcome] = (byOutcome[e.outcome] ?? 0) + 1;
  ctx.log.debug({ candidates: trace.length, rules: trace.filter((e) => e.source === "rule").length, model: trace.filter((e) => e.source === "model").length, byOutcome, reservedWords: reserved.size, llm: useLlm }, "disfluency candidates");
  // every cut accepted or rejected, and why (bounded; the stage artifact keeps the full list)
  for (const e of trace.slice(0, 200)) ctx.log.trace({ wordIndex: e.wordIndex, text: e.text, subkind: e.subkind, source: e.source, why: e.why, prior: e.prior, verdict: e.verdict ?? null, outcome: e.outcome }, "disfluency decision");
  ctx.log.info({ step: "disfluency", removed: flags.filter((f) => f.status === "auto").length, flagged: flags.filter((f) => f.status === "pending").length }, "refine step done");
  await mergeRefine(svc, ctx.projectId, "disfluency", { status: "done", flags, artifact: { data: { candidates: trace }, models: useLlm ? modelsUsed(svc, "language") : { language: "none (rules only)" } } }, ctx.seq);
}

export async function refineScenes(ctx: StageContext) {
  const { svc } = ctx;
  const t = await loadTranscript(ctx);
  if (t.refine.scenes === "done") return;
  await markRunning(ctx, "scenes");
  const project = await ctx.project();
  const sourcePath = await ctx.ensureSource(project);
  // the cuts were detected before selection (analyze.ts ensureSceneCuts); a project from before that gets them here
  const sceneCuts = t.sceneCuts ?? (project.width ? await svc.media.detectScenes(sourcePath, undefined, ctx.signal) : []);
  // burned-in captions / watermarks: best effort, never fails the step
  let overlays: SourceOverlay[] = [];
  let textProfile: TextProfile | undefined;
  if (svc.text && project.width && project.durationSec) {
    try {
      const scan = await detectOverlays({ detector: svc.text, ffmpegPath: svc.config.FFMPEG_PATH, signal: ctx.signal, faces: svc.faces }, sourcePath, project.durationSec, sceneCuts);
      overlays = scan.overlays;
      textProfile = scan.textProfile;
      ctx.log.info({ step: "scenes", frames: scan.frames, shots: scan.scenes, slides: scan.slides, faceDropped: scan.faceDropped, moving: scan.moving, textProfile: scan.textProfile, overlays }, "on-screen text scan");
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log.warn({ err }, "on-screen text scan failed, continuing without it");
    }
  }
  ctx.log.debug({ cuts: sceneCuts.length, first: sceneCuts.slice(0, 12).map((c) => Number(c.toFixed(1))), skipped: !project.width ? "no video width" : undefined }, "scene cuts");
  ctx.log.info({ step: "scenes", cuts: sceneCuts.length, overlays: overlays.length }, "refine step done");
  await mergeRefine(svc, ctx.projectId, "scenes", { status: "done", sceneCuts, overlays, textProfile }, ctx.seq);
}

/** Called by the worker when a refine job has exhausted its retries. */
export async function refineStepFailed(svc: Services, projectId: string, step: RefineStep, err: unknown, seq?: number) {
  const message = err instanceof Error ? err.message : String(err);
  svc.log.child({ module: "refine", projectId }).error({ step, err }, "refine step gave up");
  await mergeRefine(svc, projectId, step, { status: "failed", error: message }, seq);
}
