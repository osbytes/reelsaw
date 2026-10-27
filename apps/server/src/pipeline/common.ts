import { and, eq, isNull, sql } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import { schema, type Db, type Project } from "../db/index.js";
import type { Services } from "../services.js";
import type { PipelineStage, ProjectStatus } from "@reelsaw/shared";
import type { Logger } from "../log.js";
import type { DiskLease } from "../resources.js";
import type { UnitOfWork } from "../uow.js";
import { isSelfHostedModel } from "../ai/self-hosted.js";
import { StepRunner, dbStepStore, stageTimeoutMessage, type StageDetail, type StageTimeoutInfo, type StepKeyInput, type StepOptions, type StepsOptions } from "./steps.js";

/**
 * A failure that trying again cannot fix (the source is gone, a quota refuses the video). Workers end the run at
 * once instead of spending retries on it.
 */
export class NonRetryableError extends Error {}

/** A stage ran out of time: one model call past its limit, or no unit of work finished for the idle limit. */
export class StageTimeoutError extends Error {
  readonly stage: string;
  readonly done: number;
  readonly total: number;
  readonly model: string;
  readonly unitMs: number | null;
  readonly kind: "unit" | "idle";
  readonly elapsedMs: number;
  constructor(info: StageTimeoutInfo) {
    super(stageTimeoutMessage(info));
    this.stage = info.stage;
    this.done = info.done;
    this.total = info.total;
    this.model = info.model;
    this.unitMs = info.unitMs;
    this.kind = info.kind;
    this.elapsedMs = info.elapsedMs;
  }
}

/**
 * The stored source was removed by retention (SOURCE_RETENTION_DAYS). Retrying the job cannot bring it
 * back, so workers fail the clip or step at once and point at the project's Retry, which fetches it again.
 */
export class SourceExpiredError extends NonRetryableError {
  constructor(days: number) {
    super(`The source video was removed after ${days} days of inactivity (SOURCE_RETENTION_DAYS). Use Retry on the project to fetch it again, then re-render.`);
  }
}

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

/**
 * Scratch a source of `knownBytes` needs on disk, with headroom for the container's own files (MB); a source of
 * unknown size (a link not probed yet) is budgeted at 2 GB. What ingest and a pull from the store lease.
 */
export function sourceScratchMB(knownBytes?: number | null): number {
  if (knownBytes && knownBytes > 0) return Math.max(128, Math.ceil(knownBytes / 1048576) + 128);
  return 2048;
}

/** Shared helpers for pipeline stages; thin wrappers over the injected services. */
export class StageContext {
  /** the job's signal, plus the stage's own idle timeout (see `step`): aborting either ends the attempt */
  readonly signal: AbortSignal;
  private readonly idle = new AbortController();
  private _runner?: StepRunner;

  constructor(
    readonly svc: Services,
    readonly projectId: string,
    readonly stage: PipelineStage,
    jobSignal: AbortSignal,
    /** extra ids carried on every line of ctx.log: jobId, runSeq, clipId, queue */
    readonly ids: Record<string, string | number> = {},
    /** projects.stage_seq this job belongs to; its state writes commit only while it is current (undefined: unversioned) */
    readonly seq?: number,
  ) {
    this.signal = AbortSignal.any([jobSignal, this.idle.signal]);
  }

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

  private leases: DiskLease[] = [];
  private lease(kind: string, needDiskMB: number, extra: Record<string, unknown>): Promise<DiskLease> {
    return this.svc.resources.acquire({
      kind,
      needDiskMB,
      signal: this.signal,
      onWait: (r) => void this.progress(0, `Waiting for resources: ${r}`, extra).catch(() => {}),
      ids: { jobId: this.ids.jobId === undefined ? undefined : String(this.ids.jobId), projectId: this.projectId },
    });
  }

  /**
   * Wait for CPU, memory and disk, and lease the `needDiskMB` of scratch this stage is about to write
   * (resources.ts): the claim keeps a second job from starting on the same free bytes. Held until `release()`,
   * which the job wrapper calls when the stage ends; a stage may call it sooner, once its bytes are on disk.
   */
  async acquire(kind: string, needDiskMB: number, extra: Record<string, unknown> = {}): Promise<void> {
    this.leases.push(await this.lease(kind, needDiskMB, extra));
  }

  /** Give back the disk leased by `acquire` (idempotent; a lease never outlives the job either way). */
  async release(): Promise<void> {
    for (const lease of this.leases.splice(0)) await lease.release();
  }

  /**
   * Local scratch path for the source video, pulled from storage if missing on this node. With an S3 store
   * that pull is the biggest write a transcribe or render makes (the whole source), so it is leased like an
   * ingest's download and given back once the bytes are on disk; the local store hardlinks and writes nothing.
   */
  async ensureSource(project: Project): Promise<string> {
    if (project.sourceExpiredAt) throw new SourceExpiredError(this.svc.settings.get().SOURCE_RETENTION_DAYS);
    if (!project.sourceKey) throw new Error("Project has no source; ingest must run first");
    const local = path.join(await this.dir(), path.posix.basename(project.sourceKey));
    if (this.svc.storage.driver === "s3" && !(await exists(local))) {
      const lease = await this.lease(`${this.stage}.source`, sourceScratchMB(project.sourceBytes), {});
      try {
        return await this.svc.storage.ensureLocal(project.sourceKey, local);
      } finally {
        await lease.release();
      }
    }
    return this.svc.storage.ensureLocal(project.sourceKey, local);
  }

  async start(status: ProjectStatus) {
    await this.svc.tx(async (u) => {
      const [row] = await u.db
        .update(schema.projects)
        .set({ status, stage: this.stage, stageProgress: 0, stageDetail: null, error: null, stageStartedAt: sql`now()`, updatedAt: new Date() })
        .where(currentStage(this.projectId, this.seq))
        .returning({ id: schema.projects.id });
      if (!row) throw new StaleJobError(this.projectId, this.seq);
      await u.emit(this.projectId, "stage.started", { stage: this.stage, status });
    });
  }

  private lastProgressAt = 0;
  async progress(fraction: number, message?: string, extra: Record<string, unknown> = {}, detail?: StageDetail) {
    const pct = Math.max(0, Math.min(1, fraction));
    const now = Date.now();
    if (pct < 1 && now - this.lastProgressAt < 1500) return; // throttle writes
    this.lastProgressAt = now;
    // a superseded job's ticks must not move the newer run's bar
    const [row] = await this.db.update(schema.projects).set({ stageProgress: pct, ...(detail ? { stageDetail: detail } : {}), updatedAt: new Date() }).where(currentStage(this.projectId, this.seq)).returning({ id: schema.projects.id });
    if (!row) return;
    // the column above is the state a reload reads; the tick itself is live-only (NOTIFY, no event row)
    await this.svc.events.progress(this.projectId, { stage: this.stage, progress: pct, message, ...(detail ? { detail } : {}), ...(typeof extra.clipId === "string" ? { clipId: extra.clipId } : {}) });
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
      await u.db.update(schema.projects).set({ stageProgress: 1, stageDetail: null, updatedAt: new Date() }).where(eq(schema.projects.id, this.projectId));
      // durationSec is the stage's wall clock by contract (docs/PRINCIPLES.md); it goes last so no stage payload can redefine it
      await u.emit(this.projectId, "stage.completed", { stage: this.stage, ...extra, ...(durationSec !== undefined ? { durationSec } : {}) });
      if (handoff) await handoff(u);
    });
  }

  /** Seconds one model call may take: LLM_CALL_TIMEOUT_SECONDS, else 120 for a hosted model and 600 for a self-hosted one. */
  unitTimeoutMs(model: string): number {
    const set = this.svc.settings.get().LLM_CALL_TIMEOUT_SECONDS;
    if (set > 0) return set * 1000;
    return isSelfHostedModel({ AI_MODEL: model, OPENAI_BASE_URL: this.svc.providers.get("openai").baseUrl }) ? 600_000 : 120_000;
  }

  private get runner(): StepRunner {
    return (this._runner ??= new StepRunner({
      stage: this.stage,
      store: dbStepStore(this.db, this.projectId, this.stage, this.seq),
      signal: this.signal,
      log: this.log,
      progress: (fraction, message, detail) => this.progress(fraction, message, {}, detail),
      idleMs: (unitMs) => {
        const min = this.svc.settings.get().STAGE_IDLE_TIMEOUT_MINUTES;
        return min > 0 ? min * 60_000 : Math.round(unitMs * 1.5);
      },
      timeoutError: (info) => new StageTimeoutError({ stage: this.stage, ...info }),
      onIdle: (err) => this.idle.abort(err),
      stale: () => new StaleJobError(this.projectId, this.seq),
    }));
  }

  /**
   * One checkpointed unit of work. If this project already holds a saved result for the same content, model, prompt
   * version and parameters (`keyInput`), that comes back without calling `fn`; otherwise `fn` runs under its own time
   * limit and its result is saved (only while this job's stage version is current). Aborts and timeouts are never
   * swallowed: a unit past `timeoutMs` throws a StageTimeoutError, a cancelled job rethrows as it was.
   */
  step<T>(name: string, keyInput: StepKeyInput, fn: (signal: AbortSignal) => Promise<T>, o: StepOptions<T>): Promise<T> {
    return this.runner.step(name, keyInput, fn, o);
  }

  /** `step` over many items with bounded concurrency; reports progress, with the time left, as they finish. */
  steps<I, R>(items: readonly I[], o: Pick<StepsOptions, "concurrency"> & Partial<StepsOptions>, fn: (item: I, index: number, signal: AbortSignal) => Promise<R>): Promise<R[]> {
    return this.runner.steps(items, { concurrency: o.concurrency, range: o.range ?? [0, 1], message: o.message ?? ((d, t) => `${d} of ${t}`) }, fn);
  }

  /** The error that ended this attempt when the stage idled out (the worker reports it instead of whatever the abort surfaced as). */
  get timedOut(): Error | undefined {
    return this._runner?.idled;
  }

  /** Steps this attempt finished and saved (not counting reused ones). */
  get stepsCompleted(): number {
    return this._runner?.completed ?? 0;
  }

  /** End of the attempt: give back the disk and stop the idle timer. */
  async close() {
    this._runner?.stop();
    await this.release();
  }

  throwIfAborted() {
    if (this.signal.aborted) throw this.timedOut ?? new Error("job aborted (expired or cancelled)");
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
