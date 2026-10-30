/**
 * Transactional state transitions shared by the API, workers and the reconciler. Each runs inside
 * a unit of work (svc.tx) so the row change, its event and its job commit together.
 */
import { and, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { needsPrepare, prepareModeOf } from "./manual.js";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { QUEUES } from "../queue/boss.js";
import { cleanupWorkdir, runFacts } from "./common.js";
import type { PipelineStage, ProjectStatus, RunReason } from "@reelsaw/shared";
import { removeScratchClip } from "../storage/sweep.js";

/** False once the project is deleted: no run starts and no job is queued for it (restore it, then Retry). */
async function projectIsLive(u: UnitOfWork, projectId: string): Promise<boolean> {
  const [r] = await u.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  return !!r;
}

/**
 * Ask for a fresh render of a clip. Bumps clips.render_gen so any render still running for an
 * older version can't commit, cancels queued/running jobs, marks the clip pending, enqueues the
 * new job, and moves a finished project back to "rendering". `patch` applies clip edits in the same
 * transaction (e.g. new bounds). Superseded output files are deleted after commit.
 */
export async function requestRender(
  svc: Services,
  u: UnitOfWork,
  projectId: string,
  clipId: string,
  patch: Partial<typeof schema.clips.$inferInsert> = {},
  reason: RunReason = "rerender",
): Promise<number | null> {
  const [prev] = await u.db
    .select({ outputKey: schema.clips.outputKey, thumbnailKey: schema.clips.thumbnailKey })
    .from(schema.clips)
    .where(and(eq(schema.clips.id, clipId), eq(schema.clips.projectId, projectId), isNull(schema.clips.deletedAt)))
    .for("update");
  if (!prev) return null; // gone, or soft-deleted (restore it first)
  // deleting a project locks its clips first, so with this clip locked the flag is settled: no work for a deleted project
  if (!(await projectIsLive(u, projectId))) return null;
  const [row] = await u.db
    .update(schema.clips)
    .set({
      ...patch,
      status: "pending",
      error: null,
      outputKey: null,
      thumbnailKey: null,
      reconcileRequeues: 0,
      renderGen: sql`${schema.clips.renderGen} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.clips.id, clipId))
    .returning({ gen: schema.clips.renderGen });
  await u.cancelLiveJobs(QUEUES.render, clipId);
  await u.enqueue(QUEUES.render, { projectId, clipId, gen: row!.gen });
  await startRun(u, projectId, { reason, status: "rendering", stage: "render" });
  // the store copy and the scratch copy (a hardlink locally) both go, or no disk is freed
  for (const key of [prev.outputKey, prev.thumbnailKey]) {
    if (!key) continue;
    u.afterCommit(async () => {
      await svc.storage.delete(key);
      await removeScratchClip(svc, projectId, key);
    });
  }
  return row!.gen;
}

export interface PrepareOptions {
  /** "exact" keeps the bounds, "ai" searches inside them; defaults to the clip's origin */
  mode?: "exact" | "ai";
  /**
   * true (a user or operator asked): cancel any queued/running prepare and render jobs and queue a fresh prepare.
   * false (a worker or the reconciler found the clip unprepared): keep a prepare job that is already live.
   */
  restart?: boolean;
  /** start (or join) a run with this reason; omit when the project is already rendering */
  reason?: RunReason;
}

/**
 * Send a clip (back) through clip.prepare: the one path for the "preparing" transition. The clip row is locked first
 * (clip before project), the status flip happens under that lock so only the caller that changes it emits, and the job is
 * enqueued in the same unit of work. clip.prepare renders the clip once its metadata and bounds exist.
 * Returns false when the clip is gone (or was replaced by a re-analyze).
 */
export async function requestPrepare(_svc: Services, u: UnitOfWork, projectId: string, clipId: string, o: PrepareOptions = {}): Promise<boolean> {
  const c = schema.clips;
  // locked, so the status read here is the one the update replaces: exactly one caller sees the flip and emits
  const [clip] = await u.db
    .select({ origin: c.origin, status: c.status })
    .from(c)
    .where(and(eq(c.id, clipId), eq(c.projectId, projectId), isNull(c.deletedAt)))
    .for("update");
  if (!clip) return false;
  if (!(await projectIsLive(u, projectId))) return false; // see requestRender
  const restart = o.restart ?? true;
  if (restart) {
    await u.cancelLiveJobs(QUEUES.render, clipId);
    await u.cancelLiveJobs(QUEUES.prepare, clipId);
  }
  const flipped = clip.status !== "preparing";
  // a user or operator restart gives the clip a fresh reconciler budget; the reconciler's own re-queue (restart: false) keeps counting
  if (flipped || restart)
    await u.db
      .update(c)
      .set({ status: "preparing", error: null, ...(restart ? { reconcileRequeues: 0 } : {}), updatedAt: new Date() })
      .where(eq(c.id, clipId));
  const mode = o.mode ?? prepareModeOf(clip);
  if (restart || !(await u.hasLiveJob(QUEUES.prepare, clipId))) await u.enqueue(QUEUES.prepare, { projectId, clipId, mode });
  if (o.reason) await startRun(u, projectId, { reason: o.reason, status: "rendering", stage: "render" });
  if (flipped) await u.emit(projectId, "stage.started", { stage: "prepare", clipId, mode });
  return true;
}

export interface RenderManyResult {
  requested: number;
  /** clips queued for a fresh render */
  rerendered: number;
  /** left alone: still rendering/queued, or never prepared (those go through clip.prepare) */
  skipped: number;
}

/**
 * Re-render a set of clips of one project in the caller's transaction: finished and failed clips go through
 * `requestRender` (so the first one starts the run and emits `run.started` once; the rest see it already running).
 * The rows are locked in id order so two overlapping batches can't deadlock. Shared by the API, MCP and CLI.
 */
export async function requestRenders(svc: Services, u: UnitOfWork, projectId: string, clipIds: string[]): Promise<RenderManyResult> {
  const ids = [...new Set(clipIds)].sort();
  const rows = await u.db
    .select({ id: schema.clips.id, status: schema.clips.status, origin: schema.clips.origin, reasoning: schema.clips.reasoning, scores: schema.clips.scores })
    .from(schema.clips)
    .where(and(eq(schema.clips.projectId, projectId), inArray(schema.clips.id, ids), isNull(schema.clips.deletedAt)))
    .orderBy(schema.clips.id)
    .for("update");
  if (rows.length !== ids.length) throw new RenderManyMissing();
  let rerendered = 0;
  for (const c of rows) {
    if ((c.status !== "done" && c.status !== "failed") || needsPrepare(c)) continue;
    if ((await requestRender(svc, u, projectId, c.id)) !== null) rerendered++;
  }
  return { requested: ids.length, rerendered, skipped: ids.length - rerendered };
}

export class RenderManyMissing extends Error {
  constructor() {
    super("Some of those clips no longer exist");
  }
}

export interface StartRunOptions {
  reason: RunReason;
  status: ProjectStatus;
  /** the stage the run begins in; omitted leaves the project's stage as it is */
  stage?: PipelineStage | null;
  /** other project columns to write in the same statement (e.g. new settings) */
  set?: { [K in keyof typeof schema.projects.$inferInsert]?: (typeof schema.projects.$inferInsert)[K] | SQL };
  /** when the project is already mid-run, still apply status/stage/set (no new run). For resumes of a stuck run. */
  continueActive?: boolean;
}

/**
 * Begin a run: the one place an idle project starts working. A run is the stretch of work from
 * leaving idle (created, or done / failed) to being done / failed again. The flip is a conditional
 * update (`done`/`failed` for a restart, `run_seq = 0` for a project just created), so when several
 * callers ask at once (six clips re-rendered in one request, a retry racing a re-render) exactly one
 * gets a row back and only it bumps `run_seq` and emits `run.started`. Returns the new sequence
 * number, or null when the project was already running (the request joins the current run) or is deleted.
 */
export async function startRun(u: UnitOfWork, projectId: string, o: StartRunOptions): Promise<number | null> {
  const t = schema.projects;
  const values = { ...o.set, status: o.status, ...(o.stage !== undefined ? { stage: o.stage } : {}), error: null, reconcileRequeues: 0, updatedAt: new Date() }; // a new run or a retry gets a fresh reconciler budget
  const idle = o.reason === "created" ? sql`${t.runSeq} = 0` : sql`${t.status} in ('done', 'failed')`;
  const [row] = await u.db
    .update(t)
    .set({ ...values, runSeq: sql`${t.runSeq} + 1`, runStartedAt: sql`now()`, runReason: o.reason, stageStartedAt: sql`now()` })
    .where(and(eq(t.id, projectId), isNull(t.deletedAt), idle))
    .returning({ seq: t.runSeq });
  if (row) {
    await u.emit(projectId, "run.started", { seq: row.seq, reason: o.reason });
    return row.seq;
  }
  if (o.continueActive)
    await u.db
      .update(t)
      .set(values)
      .where(and(eq(t.id, projectId), isNull(t.deletedAt), sql`${t.status} not in ('done', 'failed')`));
  return null;
}

/**
 * Supersede the project's stage work (ingest → analyze): bump projects.stage_seq, so a stage job still running for
 * the old value commits nothing, fails nothing and queues nothing (cancelling a pg-boss job does not stop it). Jobs the
 * caller queues afterwards carry the new value. Lock clips (and the transcript) first: this takes the project row.
 */
export async function supersedeStages(u: UnitOfWork, projectId: string): Promise<void> {
  await u.db
    .update(schema.projects)
    .set({ stageSeq: sql`${schema.projects.stageSeq} + 1` })
    .where(eq(schema.projects.id, projectId));
}

/** The project's current stage version, for a caller that has just superseded the stages and queues work under the new one. */
export async function stageSeqOf(db: Db, projectId: string): Promise<number | undefined> {
  const [r] = await db.select({ seq: schema.projects.stageSeq }).from(schema.projects).where(eq(schema.projects.id, projectId));
  return r?.seq;
}

/**
 * Lock a project's clips in id order, before anything touches the project row. Any transaction that re-renders
 * or deletes several clips calls this first, so it takes locks in the same order as a render completion (clip,
 * then project) instead of project first and clip second, which deadlocks against a completion.
 */
export async function lockProjectClips(u: UnitOfWork, projectId: string): Promise<void> {
  await u.db.select({ id: schema.clips.id }).from(schema.clips).where(eq(schema.clips.projectId, projectId)).orderBy(schema.clips.id).for("update");
}

/**
 * Marks a project done (or failed) once every clip is terminal. The project row is locked, so when
 * two clips finish at once exactly one transaction sees "all terminal" and emits project.done.
 *
 * The lock is `for no key update`, not `for update`: `u.emit` (the caller's `clip.done`) inserts a
 * project_events row, whose foreign key takes `for key share` on the project. Two completions both hold
 * key share by the time they get here, and `for update` conflicts with it, so each waited for the other
 * to let go (deadlock). `for no key update` still serializes finalizers (it conflicts with itself) and
 * still blocks the project row update in startRun, but never conflicts with key share. Lock order is
 * clip, then project.
 */
export async function finalizeProjectIfDone(svc: Services, u: UnitOfWork, projectId: string) {
  const [project] = await u.db.select({ status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, projectId)).for("no key update");
  // only a rendering project finishes here: while a re-analyze is still picking (the clips it kept go on rendering),
  // the analyze hand-off moves it to rendering and the last render finalizes. A rendering project with no live
  // clips (the last one was deleted) is finished too: nothing is left that could finalize it later
  if (!project || project.status !== "rendering") return;
  const clips = await u.db
    .select({ status: schema.clips.status })
    .from(schema.clips)
    .where(and(eq(schema.clips.projectId, projectId), isNull(schema.clips.deletedAt)));
  if (!clips.every((c) => c.status === "done" || c.status === "failed")) return;
  const doneCount = clips.filter((c) => c.status === "done").length;
  if (doneCount === 0 && clips.length) {
    const facts = await runFacts(u.db, projectId);
    await u.db
      .update(schema.projects)
      .set({ status: "failed", error: "Every clip failed to render", updatedAt: new Date() })
      .where(eq(schema.projects.id, projectId));
    await u.emit(projectId, "project.failed", { stage: "render", error: "Every clip failed to render", ...facts });
    return;
  }
  // no live clips left (the last one was deleted while rendering) finishes as done with nothing, rather than stranding the status
  const facts = await runFacts(u.db, projectId);
  await u.db.update(schema.projects).set({ status: "done", stage: null, stageProgress: 1, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
  await u.emit(projectId, "project.done", { clips: doneCount, failed: clips.length - doneCount, ...facts });
  u.afterCommit(() => cleanupWorkdir(svc, projectId));
}

/** Current render generation of a clip, or null if the clip is gone. */
export async function currentGen(svc: Services, clipId: string): Promise<number | null> {
  const c = await svc.database.db.query.clips.findFirst({ where: eq(schema.clips.id, clipId), columns: { renderGen: true } });
  return c ? c.renderGen : null;
}
