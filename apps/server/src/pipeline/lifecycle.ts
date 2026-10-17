/**
 * Transactional state transitions shared by the API, workers and the reconciler. Each runs inside
 * a unit of work (svc.tx) so the row change, its event and its job commit together.
 */
import { and, eq, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { QUEUES } from "../queue/boss.js";
import { cleanupWorkdir } from "./common.js";
import { removeScratchClip } from "../storage/sweep.js";

/**
 * Ask for a fresh render of a clip. Bumps clips.render_gen so any render still running for an
 * older version can't commit, cancels queued/running jobs, marks the clip pending, enqueues the
 * new job, and moves a finished project back to "rendering". `patch` applies clip edits in the same
 * transaction (e.g. new bounds). Superseded output files are deleted after commit.
 */
export async function requestRender(svc: Services, u: UnitOfWork, projectId: string, clipId: string, patch: Partial<typeof schema.clips.$inferInsert> = {}): Promise<number | null> {
  const [prev] = await u.db.select({ outputKey: schema.clips.outputKey, thumbnailKey: schema.clips.thumbnailKey }).from(schema.clips).where(and(eq(schema.clips.id, clipId), eq(schema.clips.projectId, projectId))).for("update");
  if (!prev) return null;
  const [row] = await u.db
    .update(schema.clips)
    .set({ ...patch, status: "pending", error: null, outputKey: null, thumbnailKey: null, renderGen: sql`${schema.clips.renderGen} + 1`, updatedAt: new Date() })
    .where(eq(schema.clips.id, clipId))
    .returning({ gen: schema.clips.renderGen });
  await u.cancelLiveJobs(QUEUES.render, clipId);
  await u.enqueue(QUEUES.render, { projectId, clipId, gen: row!.gen });
  await reopenProject(u, projectId);
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

/** A finished/failed project whose clips are being (re)rendered is "rendering" again. */
export async function reopenProject(u: UnitOfWork, projectId: string) {
  await u.db
    .update(schema.projects)
    .set({ status: "rendering", stage: "render", error: null, updatedAt: new Date() })
    .where(and(eq(schema.projects.id, projectId), sql`${schema.projects.status} in ('done', 'failed')`));
}

/**
 * Marks a project done (or failed) once every clip is terminal. The project row is locked, so when
 * two clips finish at once exactly one transaction sees "all terminal" and emits project.done.
 */
export async function finalizeProjectIfDone(svc: Services, u: UnitOfWork, projectId: string) {
  const [project] = await u.db.select({ status: schema.projects.status }).from(schema.projects).where(eq(schema.projects.id, projectId)).for("update");
  if (!project || project.status === "done" || project.status === "failed") return;
  const clips = await u.db.select({ status: schema.clips.status }).from(schema.clips).where(eq(schema.clips.projectId, projectId));
  if (!clips.length || !clips.every((c) => c.status === "done" || c.status === "failed")) return;
  const doneCount = clips.filter((c) => c.status === "done").length;
  if (doneCount === 0) {
    await u.db.update(schema.projects).set({ status: "failed", error: "Every clip failed to render", updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
    await u.emit(projectId, "project.failed", { stage: "render", error: "Every clip failed to render" });
    return;
  }
  await u.db.update(schema.projects).set({ status: "done", stage: null, stageProgress: 1, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
  await u.emit(projectId, "project.done", { clips: doneCount, failed: clips.length - doneCount });
  u.afterCommit(() => cleanupWorkdir(svc, projectId));
}

/** Current render generation of a clip, or null if the clip is gone. */
export async function currentGen(svc: Services, clipId: string): Promise<number | null> {
  const c = await svc.database.db.query.clips.findFirst({ where: eq(schema.clips.id, clipId), columns: { renderGen: true } });
  return c ? c.renderGen : null;
}
