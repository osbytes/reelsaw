import { and, eq, isNull, sql } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import { schema, type Db, type Project } from "../db/index.js";
import type { Services } from "../services.js";
import type { PipelineStage, ProjectStatus } from "@reelsaw/shared";
import type { Logger } from "../log.js";
import type { UnitOfWork } from "../uow.js";

export class ProjectGoneError extends Error {
  constructor(id: string) {
    super(`project ${id} no longer exists`);
  }
}

/**
 * A stage job whose version is no longer the project's (a retry, re-analyze or delete superseded it while it ran):
 * the worker logs it at info and ends the job without writing, enqueueing or failing anything.
 */
export class StaleJobError extends Error {
  constructor(id: string, seq: number | undefined) {
    super(`project ${id}: stage work ${seq ?? "?"} was superseded`);
  }
}

/** The project row a stage job of version `seq` may still write: not deleted, stage_seq unchanged (undefined: any). */
export function currentStage(projectId: string, seq: number | undefined) {
  const t = schema.projects;
  return and(eq(t.id, projectId), isNull(t.deletedAt), seq === undefined ? undefined : eq(t.stageSeq, seq));
}

/**
 * Lock the project row while this job's version is current; false for a stale job. Taken before the stage's results
 * are written, so a superseding request (which bumps stage_seq on this row) either waits for the commit and then
 * sees its results, or commits first and this job writes nothing. `for no key update`, as in finalizeProjectIfDone.
 */
export async function lockCurrentStage(db: Db, projectId: string, seq: number | undefined): Promise<boolean> {
  const [r] = await db.select({ id: schema.projects.id }).from(schema.projects).where(currentStage(projectId, seq)).for("no key update");
  return !!r;
}

/** Shared helpers for pipeline stages; thin wrappers over the injected services. */
export class StageContext {
  constructor(
    readonly svc: Services,
    readonly projectId: string,
    readonly stage: PipelineStage,
    readonly signal: AbortSignal,
    /** extra ids carried on every line of ctx.log: jobId, runSeq, clipId, queue */
    readonly ids: Record<string, string | number> = {},
    /** projects.stage_seq this job belongs to; its state writes commit only while it is current (undefined: unversioned) */
    readonly seq?: number,
  ) {}

  /**
   * A context whose logger also carries the job id and the project's current run sequence. `seq` is the stage job's
   * version; a job queued before versions existed has none and takes the current one, so a deploy strands nothing.
   */
  static async open(svc: Services, projectId: string, stage: PipelineStage, signal: AbortSignal, ids: Record<string, string | number> = {}, seq?: number): Promise<StageContext> {
    const [r] = await svc.database.db.select({ run: schema.projects.runSeq, stage: schema.projects.stageSeq }).from(schema.projects).where(eq(schema.projects.id, projectId));
    return new StageContext(svc, projectId, stage, signal, { ...(r ? { runSeq: r.run } : {}), ...ids }, seq ?? r?.stage);
  }

  get db() {
    return this.svc.database.db;
  }

  private _log?: Logger;
  /** child logger carrying module (= the stage), projectId, jobId and runSeq on every line; add more with `.child()` */
  get log(): Logger {
    return (this._log ??= this.svc.log.child({ module: this.stage, stage: this.stage, projectId: this.projectId, ...this.ids }));
  }

  async project(): Promise<Project> {
    const p = await this.db.query.projects.findFirst({ where: eq(schema.projects.id, this.projectId) });
    if (!p || p.deletedAt) throw new ProjectGoneError(this.projectId); // deleted: its jobs stop (restore, then Retry, resumes)
    return p;
  }

  async dir(): Promise<string> {
    const dir = this.svc.paths.project(this.projectId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  /** Local scratch path for the source video, pulled from storage if missing on this node. */
  async ensureSource(project: Project): Promise<string> {
    if (!project.sourceKey) throw new Error("Project has no source; ingest must run first");
    const local = path.join(await this.dir(), path.posix.basename(project.sourceKey));
    return this.svc.storage.ensureLocal(project.sourceKey, local);
  }

  async start(status: ProjectStatus) {
    await this.svc.tx(async (u) => {
      const [row] = await u.db
        .update(schema.projects)
        .set({ status, stage: this.stage, stageProgress: 0, error: null, stageStartedAt: sql`now()`, updatedAt: new Date() })
        .where(currentStage(this.projectId, this.seq))
        .returning({ id: schema.projects.id });
      if (!row) throw new StaleJobError(this.projectId, this.seq);
      await u.emit(this.projectId, "stage.started", { stage: this.stage, status });
    });
  }

  private lastProgressAt = 0;
  async progress(fraction: number, message?: string, extra: Record<string, unknown> = {}) {
    const pct = Math.max(0, Math.min(1, fraction));
    const now = Date.now();
    if (pct < 1 && now - this.lastProgressAt < 1500) return; // throttle writes
    this.lastProgressAt = now;
    // a superseded job's ticks must not move the newer run's bar
    const [row] = await this.db.update(schema.projects).set({ stageProgress: pct, updatedAt: new Date() }).where(currentStage(this.projectId, this.seq)).returning({ id: schema.projects.id });
    if (!row) return;
    // the column above is the state a reload reads; the tick itself is live-only (NOTIFY, no event row)
    await this.svc.events.progress(this.projectId, { stage: this.stage, progress: pct, message, ...(typeof extra.clipId === "string" ? { clipId: extra.clipId } : {}) });
  }

  /**
   * Finish the stage. `handoff` runs in the same transaction: the results it writes, the
   * stage.completed event and the next stage's job commit together (or not at all, and the job
   * retries), so a crash can't leave "completed" with nothing queued after it.
   */
  async complete(extra: Record<string, unknown> = {}, handoff?: (u: UnitOfWork) => Promise<unknown>) {
    await this.svc.tx(async (u) => {
      // first, so the results below land only while this job's version is current (and a re-analyze waits for them)
      if (!(await lockCurrentStage(u.db, this.projectId, this.seq))) throw new StaleJobError(this.projectId, this.seq);
      const durationSec = await stageElapsed(u.db, this.projectId, this.stage);
      await u.db.update(schema.projects).set({ stageProgress: 1, updatedAt: new Date() }).where(eq(schema.projects.id, this.projectId));
      // durationSec is the stage's wall clock by contract (docs/PRINCIPLES.md); it goes last so no stage payload can redefine it
      await u.emit(this.projectId, "stage.completed", { stage: this.stage, ...extra, ...(durationSec !== undefined ? { durationSec } : {}) });
      if (handoff) await handoff(u);
    });
  }

  throwIfAborted() {
    if (this.signal.aborted) throw new Error("job aborted (expired or cancelled)");
  }
}

export async function exists(file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Seconds the stage now running has taken, from projects.stage_started_at (set by `stage.started`).
 * Durations are stored in event payloads so nothing downstream recomputes them from timestamps.
 * Undefined when `stage` is not the stage that row says is running.
 */
export async function stageElapsed(db: Db, projectId: string, stage: string): Promise<number | undefined> {
  const [r] = await db
    .select({ stage: schema.projects.stage, sec: sql<number | null>`round(extract(epoch from (clock_timestamp() - ${schema.projects.stageStartedAt}))::numeric, 1)::float8` })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  return r && r.stage === stage && r.sec !== null ? r.sec : undefined;
}

/** The current run's identity and age, for `project.done` / `project.failed` payloads. */
export async function runFacts(db: Db, projectId: string): Promise<{ runSeq: number; runReason: string | null; runSec?: number; renderSec?: number }> {
  const [r] = await db
    .select({
      seq: schema.projects.runSeq,
      reason: schema.projects.runReason,
      stage: schema.projects.stage,
      runSec: sql<number | null>`round(extract(epoch from (clock_timestamp() - ${schema.projects.runStartedAt}))::numeric, 1)::float8`,
      stageSec: sql<number | null>`round(extract(epoch from (clock_timestamp() - ${schema.projects.stageStartedAt}))::numeric, 1)::float8`,
    })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  if (!r) return { runSeq: 0, runReason: null };
  return { runSeq: r.seq, runReason: r.reason, ...(r.runSec !== null ? { runSec: r.runSec } : {}), ...(r.stage === "render" && r.stageSec !== null ? { renderSec: r.stageSec } : {}) };
}

/** Mark the run failed, unless the job that gave up was superseded (`seq` no longer current): then it was not this run's. */
export async function failProject(svc: Services, projectId: string, stage: PipelineStage, err: unknown, seq?: number) {
  const message = err instanceof Error ? err.message : String(err);
  await svc.tx(async (u) => {
    if (!(await lockCurrentStage(u.db, projectId, seq))) return svc.log.child({ module: stage, projectId }).info({ seq }, "stale job gave up; the newer run is left alone");
    const facts = await runFacts(u.db, projectId);
    await u.db.update(schema.projects).set({ status: "failed", error: message.slice(0, 4000), updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
    await u.emit(projectId, "project.failed", { stage, error: message.slice(0, 1000), ...facts });
  });
}

export async function stageFailedAttempt(svc: Services, projectId: string, stage: PipelineStage, err: unknown, attempt: number, max: number, seq?: number) {
  const message = err instanceof Error ? err.message : String(err);
  // a superseded job's failures are not the newer run's
  const [cur] = await svc.database.db.select({ id: schema.projects.id }).from(schema.projects).where(currentStage(projectId, seq));
  if (!cur) return;
  const durationSec = await stageElapsed(svc.database.db, projectId, stage);
  await svc.events.emit(projectId, "stage.failed", { stage, error: message.slice(0, 1000), attempt, max, ...(durationSec !== undefined ? { durationSec } : {}) });
}

/** Remove intermediates (audio, chunks, subtitle files) once a project is finished. */
export async function cleanupWorkdir(svc: Services, projectId: string) {
  if (!svc.config.CLEANUP_WORKDIR) return;
  const dir = svc.paths.project(projectId);
  await fs.rm(path.join(dir, "audio.mp3"), { force: true });
  await fs.rm(path.join(dir, "chunks"), { recursive: true, force: true });
  try {
    for (const f of await fs.readdir(path.join(dir, "clips"))) {
      if (f.endsWith(".ass") || f.endsWith(".tmp.mp4")) await fs.rm(path.join(dir, "clips", f), { force: true });
    }
  } catch {
    /* no clips dir */
  }
}

/** Host of a provider endpoint, without credentials, path or query (safe for artifacts/reports). */
export function endpointHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Which models a stage ran with: provider:model ids and, for self-hosted endpoints, the host.
 * Recorded with stage artifacts because the config at report time may differ from what ran.
 */
export function modelsUsed(svc: Services, ...which: Array<"language" | "transcription" | "align" | "aligner">): Record<string, string> {
  const c = svc.config;
  const out: Record<string, string> = {};
  const host = (model: string) => {
    const provider = model.split(":")[0];
    return provider === c.OPENAI_COMPATIBLE_NAME || provider === "openai" ? endpointHost(svc.providers.get(provider).baseUrl) : undefined;
  };
  const add = (key: string, model: string) => {
    out[key] = model;
    const h = host(model);
    if (h) out[`${key}Endpoint`] = h;
  };
  const m = svc.models.get();
  for (const w of which) {
    if (w === "language") add("language", m.language);
    if (w === "transcription") add("transcription", m.transcription);
    if (w === "align") add("align", m.align);
    if (w === "aligner" && svc.aligner) out.aligner = path.basename(c.ALIGN_MODEL_DIR ?? "wav2vec2");
  }
  return out;
}
