import { eq } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import { schema, type Project } from "../db/index.js";
import type { Services } from "../services.js";
import type { PipelineStage, ProjectStatus } from "@reelsaw/shared";
import type { Logger } from "../log.js";
import type { UnitOfWork } from "../uow.js";

export class ProjectGoneError extends Error {
  constructor(id: string) {
    super(`project ${id} no longer exists`);
  }
}

/** Shared helpers for pipeline stages; thin wrappers over the injected services. */
export class StageContext {
  constructor(
    readonly svc: Services,
    readonly projectId: string,
    readonly stage: PipelineStage,
    readonly signal: AbortSignal,
  ) {}

  get db() {
    return this.svc.database.db;
  }

  private _log?: Logger;
  /** child logger carrying stage + projectId on every line */
  get log(): Logger {
    return (this._log ??= this.svc.log.child({ stage: this.stage, projectId: this.projectId }));
  }

  async project(): Promise<Project> {
    const p = await this.db.query.projects.findFirst({ where: eq(schema.projects.id, this.projectId) });
    if (!p) throw new ProjectGoneError(this.projectId);
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
      await u.db
        .update(schema.projects)
        .set({ status, stage: this.stage, stageProgress: 0, error: null, updatedAt: new Date() })
        .where(eq(schema.projects.id, this.projectId));
      await u.emit(this.projectId, "stage.started", { stage: this.stage, status });
    });
  }

  private lastProgressAt = 0;
  async progress(fraction: number, message?: string, extra: Record<string, unknown> = {}) {
    const pct = Math.max(0, Math.min(1, fraction));
    const now = Date.now();
    if (pct < 1 && now - this.lastProgressAt < 1500) return; // throttle writes
    this.lastProgressAt = now;
    await this.db.update(schema.projects).set({ stageProgress: pct, updatedAt: new Date() }).where(eq(schema.projects.id, this.projectId));
    await this.svc.events.emit(this.projectId, "stage.progress", { stage: this.stage, progress: pct, message, ...extra });
  }

  /**
   * Finish the stage. `handoff` runs in the same transaction: the results it writes, the
   * stage.completed event and the next stage's job commit together (or not at all, and the job
   * retries), so a crash can't leave "completed" with nothing queued after it.
   */
  async complete(extra: Record<string, unknown> = {}, handoff?: (u: UnitOfWork) => Promise<unknown>) {
    await this.svc.tx(async (u) => {
      await u.db.update(schema.projects).set({ stageProgress: 1, updatedAt: new Date() }).where(eq(schema.projects.id, this.projectId));
      await u.emit(this.projectId, "stage.completed", { stage: this.stage, ...extra });
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

export async function failProject(svc: Services, projectId: string, stage: PipelineStage, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  await svc.tx(async (u) => {
    await u.db.update(schema.projects).set({ status: "failed", error: message.slice(0, 4000), updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
    await u.emit(projectId, "project.failed", { stage, error: message.slice(0, 1000) });
  });
}

export async function stageFailedAttempt(svc: Services, projectId: string, stage: PipelineStage, err: unknown, attempt: number, max: number) {
  const message = err instanceof Error ? err.message : String(err);
  await svc.events.emit(projectId, "stage.failed", { stage, error: message.slice(0, 1000), attempt, max });
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
    return provider === "compat" ? endpointHost(c.OPENAI_COMPATIBLE_BASE_URL) : provider === "openai" ? endpointHost(c.OPENAI_BASE_URL) : undefined;
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
