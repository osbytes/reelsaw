/**
 * Deleting is reversible. A deleted project, or a clip a re-analyze replaced, keeps its row and files with
 * `deleted_at` set: every read path leaves it out, its jobs are cancelled, and restore clears the mark. After
 * DELETED_RETENTION_DAYS the hourly purge (`purgeDeleted`, run with the storage sweep) removes the rows and only
 * then the files. Storage still counts until remove-for-good (`purgeOwnedProject`). tRPC (`projects.delete` /
 * `restore` / `purge` / `reanalyze` / `update` / `create` / `retry` / `refine` / `setSourceText` / `setBumpers` / `updateStyle`,
 * `clips.delete` / `restore` / `purge`), the MCP tools and the CLI all call these functions. Clip edits (`clips.update`,
 * `create`, `rerender`, `setBumpersMany`) are in `clips/service.ts`.
 */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { REFINE_STEPS, adjustOf, bumperSecondsSchema, formatBytes, projectSettingsSchema, styleOverrideSchema, styleSchema, type ClearableSetting, type CreateProjectInput, type LayoutSection, type ProjectSettings, type ProjectSettingsPatch, type SectionAdjustFields, type SectionMode } from "@reelsaw/shared";
import { checkAnnouncedMinutes, checkProjectQuota, checkRestoreQuota, hasMinuteLimits, projectStoredBytes, recordProjectCreated } from "../quota.js";
import { assertPublicHttpUrl } from "../lib/safe-url.js";
import { takeTxLock, txLock } from "../locks.js";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { QUEUES, type QueueName } from "../queue/boss.js";
import { keys } from "../storage/index.js";
import { releaseUpload } from "../storage/uploads.js";
import { removeScratchClip } from "../storage/sweep.js";
import { keepReason, listClips } from "../pipeline/analyze.js";
import { finalizeProjectIfDone, lockProjectClips, requestPrepare, requestRender, stageSeqOf, startRun, supersedeStages } from "../pipeline/lifecycle.js";
import { needsPrepare } from "../pipeline/manual.js";
import { enqueueRefine, REFINE_QUEUE } from "../pipeline/refine.js";
import { resolveProjectSettings, userDefaults } from "../pipeline/settings.js";
import { syncProjectRefs } from "../library/refs.js";
import { assetVisibleTo } from "../library/visible.js";
import { announcedDuration, peekUrlMeta } from "./peek.js";
import { runFacts } from "../pipeline/common.js";
import { deadlineIn, keysetLoop } from "../lib/batch.js";
import { getLayerTemplate } from "../library/templates.js";
import { clipDecisions, forgetDecisions, recordDecisions } from "../decisions/service.js";

const STAGE_QUEUES = [QUEUES.ingest, QUEUES.transcribe, QUEUES.refineEntities, QUEUES.refineDisfluency, QUEUES.refineScenes, QUEUES.analyze] as const;
const WORKING = ["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"] as const;
const IN_FLIGHT = ["preparing", "pending", "rendering"] as const;

/** Who is asking: the owner, an admin (any project), or the operator CLI (null). */
export type Actor = { id: string; admin: boolean } | null;

/** The project's owner acting (not an admin or the operator CLI): only their own choices go in their decision log. */
export function byOwner(actor: Actor, p: { userId: string }): boolean {
  return !!actor && actor.id === p.userId;
}

const days = (svc: Services) => svc.settings.get().DELETED_RETENTION_DAYS;
/** "for 7 days" / "until you purge it", for messages and tool results. */
export const restorableFor = (svc: Services) => (days(svc) > 0 ? `for ${days(svc)} day${days(svc) === 1 ? "" : "s"}` : "until it is purged");

/**
 * Where a retry resumes, from what the project already has. Live clips mean render, except when the project failed in
 * analyze and none of them is an AI pick: only clips the user made or kept survived a failed re-analyze, so picking
 * moments still has to run. A source that retention removed is fetched again first, whatever else exists.
 */
export function retryQueueFor(s: { clips: ReadonlyArray<{ origin: string }>; transcript: boolean; refineDone: boolean; stage: string | null; sourceKey: string | null; sourceExpired?: boolean }): QueueName {
  if (s.sourceExpired) return QUEUES.ingest;
  const picked = s.clips.some((c) => c.origin === "ai");
  if (s.clips.length && !(s.stage === "analyze" && !picked)) return QUEUES.render;
  if (s.transcript && s.refineDone) return QUEUES.analyze;
  if (s.transcript) return QUEUES.refineEntities;
  if (s.sourceKey) return QUEUES.transcribe;
  return QUEUES.ingest;
}

/**
 * Resume a project from the furthest completed stage (each stage skips work that already exists).
 * Same path as the owner's Retry button; admin bulk retry and MCP retry_project call this too.
 * Lock order is transcript → clip → project. Returns null when the project is gone or deleted.
 */
export async function retryProject(svc: Services, u: UnitOfWork, projectId: string): Promise<{ ok: true; queue: QueueName } | null> {
  const [p] = await u.db
    .select({ id: schema.projects.id, sourceKey: schema.projects.sourceKey, sourceExpiredAt: schema.projects.sourceExpiredAt, stage: schema.projects.stage, status: schema.projects.status })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  if (!p) return null;
  const [transcript] = await u.db
    .select({ projectId: schema.transcripts.projectId, refine: schema.transcripts.refine })
    .from(schema.transcripts)
    .where(eq(schema.transcripts.projectId, p.id))
    .for("update");
  await lockProjectClips(u, p.id);
  // deleted while we waited for the locks (deleting locks the clips first, so it is settled now): resume nothing
  const [live] = await u.db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, p.id), isNull(schema.projects.deletedAt))).for("no key update");
  if (!live) return null;
  const clips = await listClips(u.db, p.id);
  const refineDone = !!transcript && REFINE_STEPS.every((s) => transcript.refine[s] === "done" || transcript.refine[s] === "failed");
  const queue = retryQueueFor({ clips, transcript: !!transcript, refineDone, stage: p.stage, sourceKey: p.sourceKey, sourceExpired: !!p.sourceExpiredAt });

  if (queue === QUEUES.render) {
    await startRun(u, p.id, { reason: "retry", status: "rendering", stage: "render", continueActive: true });
    for (const c of clips) {
      if (c.status === "done") continue;
      if (needsPrepare(c)) {
        await requestPrepare(svc, u, p.id, c.id);
        continue;
      }
      await requestRender(svc, u, p.id, c.id, {}, "retry");
    }
  } else if (queue === QUEUES.refineEntities) {
    await supersedeStages(u, p.id);
    await startRun(u, p.id, { reason: "retry", status: "refining", stage: "refine", continueActive: true });
    for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, p.id);
    await enqueueRefine(svc, p.id, await stageSeqOf(u.db, p.id), undefined, u);
  } else {
    for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, p.id);
    await supersedeStages(u, p.id); // a cancelled job that is still running must not commit, or fail this retry
    await startRun(u, p.id, { reason: "retry", status: "queued", continueActive: true });
    await u.enqueue(queue, { projectId: p.id });
  }
  await u.emit(p.id, "stage.started", { stage: queue, retried: true });
  return { ok: true, queue };
}

/**
 * Soft-delete a project in the caller's unit of work: mark it, cancel its jobs, stop work in progress (a working
 * project becomes failed with a plain reason, in-flight clips get a newer render generation so a render already
 * running discards its output), emit `project.deleted`. Files stay until the purge. Returns false if it was
 * already deleted.
 */
export async function deleteProject(svc: Services, u: UnitOfWork, projectId: string, opts: { forgetDecisions?: boolean } = {}): Promise<boolean> {
  await lockProjectClips(u, projectId); // clips before the project row, like a render completion
  const [before] = await u.db.select({ status: schema.projects.status, stage: schema.projects.stage }).from(schema.projects).where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  if (!before) return false;
  for (const c of await listClips(u.db, projectId)) {
    await u.cancelLiveJobs(QUEUES.render, c.id);
    await u.cancelLiveJobs(QUEUES.prepare, c.id);
  }
  for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, projectId);
  const stopped = "Stopped because the project was deleted. Retry to continue.";
  await u.db
    .update(schema.clips)
    .set({ status: "failed", error: stopped, renderGen: sql`${schema.clips.renderGen} + 1`, updatedAt: new Date() })
    .where(and(eq(schema.clips.projectId, projectId), inArray(schema.clips.status, [...IN_FLIGHT]), isNull(schema.clips.deletedAt)));
  const working = (WORKING as readonly string[]).includes(before.status);
  const facts = working ? await runFacts(u.db, projectId) : null;
  // stage_seq too: a stage job still running stays stale after a restore, which resumes only through Retry
  await u.db
    .update(schema.projects)
    .set({ deletedAt: new Date(), forgetDecisionsOnPurge: !!opts.forgetDecisions, stageSeq: sql`${schema.projects.stageSeq} + 1`, updatedAt: new Date(), ...(working ? { status: "failed" as const, error: stopped } : {}) })
    .where(eq(schema.projects.id, projectId));
  // the run it interrupted ends here, so its history reads as stopped rather than running forever
  if (facts) await u.emit(projectId, "project.failed", { stage: before.stage ?? "ingest", error: stopped, ...facts });
  await u.emit(projectId, "project.deleted", { days: days(svc), stopped: working });
  return true;
}

/**
 * Owner-facing delete: ownership checked in the same unit of work as the write. `forgetDecisions` marks the project so
 * whichever purge removes it (Delete forever, or the retention sweep) forgets its decisions too; until then they stay
 * out of learning and exports, and a restore keeps them after all.
 */
export async function deleteOwnedProject(svc: Services, actor: Actor, projectId: string, opts: { forgetDecisions?: boolean } = {}) {
  return svc.tx(async (u) => {
    await findProject(u.db, actor, projectId, { deleted: false });
    const stored = await projectStoredBytes(u.db, projectId);
    const changed = await deleteProject(svc, u, projectId, opts);
    const base = stored ? `Deleted. It can be restored ${restorableFor(svc)}. It still uses ${formatBytes(stored)} until you delete it forever.` : `Deleted. It can be restored ${restorableFor(svc)}.`;
    return {
      ok: true,
      changed,
      restorable: restorableFor(svc),
      storedBytes: stored,
      forgetDecisions: !!opts.forgetDecisions,
      message: opts.forgetDecisions ? `${base} What Reelsaw learned from it is forgotten when it is deleted forever.` : base,
    };
  });
}

/** Bring a deleted project back (owner or admin). A project that was working comes back failed: Retry resumes it. Operator CLI (actor null) skips the live-slot check. */
export async function restoreProject(svc: Services, actor: Actor, projectId: string) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: true });
    if (!p.deletedAt) return { ok: true, changed: false, status: p.status };
    if (actor) await checkRestoreQuota(u.db, svc.settings.get(), p.userId, { lock: true, ent: svc.entitlements });
    else await takeTxLock(u.db, txLock.quota(p.userId));
    await u.db.update(schema.projects).set({ deletedAt: null, forgetDecisionsOnPurge: false, updatedAt: new Date() }).where(and(eq(schema.projects.id, projectId), isNotNull(schema.projects.deletedAt)));
    await u.emit(projectId, "project.restored", {});
    return { ok: true, changed: true, status: p.status };
  });
}

/** Remove a already-deleted project for good (owner or admin): rows and files go, storage is freed. Minutes already counted stay on the usage ledger. */
export async function purgeOwnedProject(svc: Services, actor: Actor, projectId: string, opts: { forgetDecisions?: boolean } = {}) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: true });
    if (!p.deletedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Delete it first. Only projects already in Deleted can be deleted forever." });
    // re-check under the row lock (clips first, then the project, like deleteProject): a restore that committed since
    // the read above wins, instead of this deleting a project that is live again for good
    await lockProjectClips(u, projectId);
    const [still] = await u.db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, projectId), isNotNull(schema.projects.deletedAt))).for("update");
    if (!still) throw new TRPCError({ code: "CONFLICT", message: "It was restored meanwhile, so nothing was deleted." });
    const stored = await projectStoredBytes(u.db, projectId);
    const forget = opts.forgetDecisions || p.forgetDecisionsOnPurge;
    const { forgottenDecisions } = await purgeProject(svc, u, projectId, { forgetDecisions: forget });
    const freed = stored ? `Deleted forever. ${formatBytes(stored)} is free now.` : "Deleted forever.";
    return { ok: true, storedBytes: stored, forgottenDecisions, message: forget ? `${freed} What Reelsaw learned from it is forgotten too.` : freed };
  });
}

/**
 * Hard-delete one already-deleted clip: the row first, files after commit. `before` is the sweep cutoff (ISO);
 * omitted = any deleted clip (the owner's Remove for good). Returns null if it was restored or already gone.
 */
export async function purgeClip(svc: Services, u: UnitOfWork, clipId: string, opts: { before?: string } = {}): Promise<{ projectId: string; files: string[] } | null> {
  const [c] = await u.db
    .delete(schema.clips)
    .where(and(eq(schema.clips.id, clipId), isNotNull(schema.clips.deletedAt), opts.before ? sql`${schema.clips.deletedAt} < ${opts.before}::timestamptz` : undefined))
    .returning({ projectId: schema.clips.projectId, outputKey: schema.clips.outputKey, thumbnailKey: schema.clips.thumbnailKey });
  if (!c) return null;
  const files = [c.outputKey, c.thumbnailKey].filter((k): k is string => !!k);
  const log = svc.log.child({ module: "sweep" });
  u.afterCommit(async () => {
    for (const key of files) {
      await svc.storage.delete(key).catch((err) => log.warn({ err, clipId }, "could not delete a purged clip's file"));
      await removeScratchClip(svc, c.projectId, key);
    }
  });
  return { projectId: c.projectId, files };
}

/** Remove one already-deleted clip of a live project for good (owner or admin). Clips of a deleted project go with purge_project. */
export async function purgeOwnedClip(svc: Services, actor: Actor, clipId: string) {
  return svc.tx(async (u) => {
    const [c] = await u.db.select().from(schema.clips).where(eq(schema.clips.id, clipId)).for("update");
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: gone(svc, "clip") });
    await findProject(u.db, actor, c.projectId, { deleted: false });
    if (!c.deletedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Delete it first. Only clips already in Deleted can be deleted forever." });
    const stored = c.outputKey && c.outputBytes ? c.outputBytes : 0;
    await purgeClip(svc, u, clipId);
    return { ok: true as const, storedBytes: stored, message: stored ? `Deleted forever. ${formatBytes(stored)} is free now.` : "Deleted forever." };
  });
}

function clipStored(c: { outputKey: string | null; outputBytes: number | null }) {
  return c.outputKey && c.outputBytes ? c.outputBytes : 0;
}

/** Soft-delete one live clip under an already-taken clip lock. Returns false if it was already deleted. */
async function markClipDeleted(svc: Services, u: UnitOfWork, c: typeof schema.clips.$inferSelect) {
  if (c.deletedAt) return false;
  await u.cancelLiveJobs(QUEUES.render, c.id);
  await u.cancelLiveJobs(QUEUES.prepare, c.id);
  const unfinished = c.status !== "done" && c.status !== "failed";
  await u.db
    .update(schema.clips)
    .set({ deletedAt: new Date(), renderGen: sql`${schema.clips.renderGen} + 1`, ...(unfinished ? { status: "failed", error: "Deleted before it finished" } : {}), updatedAt: new Date() })
    .where(eq(schema.clips.id, c.id));
  await u.emit(c.projectId, "clip.deleted", { clipId: c.id, index: c.index, title: c.title, days: days(svc) });
  return true;
}

/**
 * Soft-delete one clip (owner or admin): hidden from the project, its render or preparation stopped (a newer generation
 * makes a running render discard its output), restorable with `restoreClip` until the purge. A project that was only
 * waiting for this clip finishes. Returns changed: false if it was already deleted.
 */
export async function deleteClip(svc: Services, actor: Actor, clipId: string) {
  return svc.tx(async (u) => {
    // clip first, the project row last (finalize): the same order as a render completion
    const [c] = await u.db.select().from(schema.clips).where(eq(schema.clips.id, clipId)).for("update");
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: gone(svc, "clip") });
    const p = await findProject(u.db, actor, c.projectId, { deleted: false });
    const changed = await markClipDeleted(svc, u, c);
    if (changed) await finalizeProjectIfDone(svc, u, c.projectId);
    if (changed && byOwner(actor, p)) await recordDecisions(svc, u.db, p, () => clipDecisions(u.db, p.id, "clip.delete", [c]));
    const stored = clipStored(c);
    return {
      ok: true,
      changed,
      clipId,
      /** a render or preparation that was in flight was stopped */
      stoppedRender: changed && c.status !== "done" && c.status !== "failed",
      restorable: restorableFor(svc),
      storedBytes: stored,
      message: `Deleted. restore_clip brings it back ${restorableFor(svc)}.`,
    };
  });
}

/**
 * Soft-delete several clips of one live project (the selection bar). One transaction, clip locks first then the
 * project row (finalize). Already-deleted ids are counted as skipped. tRPC `clips.deleteMany`, the BatchBar.
 */
export async function deleteClips(svc: Services, actor: Actor, projectId: string, clipIds: string[]) {
  const ids = [...new Set(clipIds)].slice(0, 200);
  if (!ids.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one clip" });
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    await lockProjectClips(u, projectId);
    const rows = await u.db.select().from(schema.clips).where(and(eq(schema.clips.projectId, projectId), inArray(schema.clips.id, ids)));
    if (rows.length !== ids.length) throw new TRPCError({ code: "NOT_FOUND", message: "A selected clip is not on this project" });
    let deleted = 0;
    let skipped = 0;
    let stoppedRenders = 0;
    let storedBytes = 0;
    const gone: typeof rows = [];
    for (const c of rows) {
      if (await markClipDeleted(svc, u, c)) {
        gone.push(c);
        deleted++;
        storedBytes += clipStored(c);
        if (c.status !== "done" && c.status !== "failed") stoppedRenders++;
      } else skipped++;
    }
    if (deleted) await finalizeProjectIfDone(svc, u, projectId);
    if (byOwner(actor, p)) await recordDecisions(svc, u.db, p, () => clipDecisions(u.db, p.id, "clip.delete", gone));
    return { ok: true as const, deleted, skipped, stoppedRenders, restorable: restorableFor(svc), storedBytes };
  });
}

/** Bring back a clip a re-analyze replaced (or that was deleted). It goes to the end of the project's list; a clip that never finished rendering needs a re-render. */
export async function restoreClip(svc: Services, actor: Actor, clipId: string) {
  return svc.tx(async (u) => {
    const [c] = await u.db.select().from(schema.clips).where(eq(schema.clips.id, clipId)).for("update");
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: gone(svc, "clip") });
    const p = await findProject(u.db, actor, c.projectId, { deleted: true });
    if (p.deletedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Its project is deleted. Restore the project (restore_project) to bring its clips back." });
    if (!c.deletedAt) return { ok: true, changed: false, clipId, status: c.status };
    const [{ next }] = await u.db.select({ next: sql<number>`coalesce(max(${schema.clips.index}) + 1, 0)::int` }).from(schema.clips).where(and(eq(schema.clips.projectId, c.projectId), isNull(schema.clips.deletedAt)));
    await u.db.update(schema.clips).set({ deletedAt: null, index: next, updatedAt: new Date() }).where(eq(schema.clips.id, clipId));
    await u.emit(c.projectId, "clip.restored", { clipId, index: next, title: c.title });
    if (byOwner(actor, p)) await recordDecisions(svc, u.db, p, () => clipDecisions(u.db, p.id, "clip.restore", [c], { side: "after" }));
    return { ok: true, changed: true, clipId, status: c.status, needsRerender: c.status !== "done" };
  });
}

/** Deleted projects across the install (operator CLI), newest first, with when each is purged. */
export async function deletedProjects(svc: Services, limit = 100) {
  const rows = await svc.database.db
    .select({ id: schema.projects.id, title: schema.projects.title, status: schema.projects.status, userId: schema.projects.userId, email: schema.user.email, deletedAt: schema.projects.deletedAt })
    .from(schema.projects)
    .innerJoin(schema.user, eq(schema.user.id, schema.projects.userId))
    .where(isNotNull(schema.projects.deletedAt))
    .orderBy(sql`${schema.projects.deletedAt} desc`)
    .limit(limit);
  return rows.map((r) => ({ ...r, purgeAt: days(svc) > 0 ? new Date(r.deletedAt!.getTime() + days(svc) * 86_400_000) : null }));
}

/** Clips of a project that were deleted or a re-analyze replaced and that can still be restored, newest first. */
export async function deletedClips(db: Db, projectId: string) {
  return db
    .select({ id: schema.clips.id, index: schema.clips.index, title: schema.clips.title, startSec: schema.clips.startSec, endSec: schema.clips.endSec, status: schema.clips.status, deletedAt: schema.clips.deletedAt })
    .from(schema.clips)
    .where(and(eq(schema.clips.projectId, projectId), isNotNull(schema.clips.deletedAt)))
    .orderBy(sql`${schema.clips.deletedAt} desc`, schema.clips.index, schema.clips.createdAt, schema.clips.id)
    .limit(200);
}

export { keepReason };

/**
 * Keep the transcript and pick moments again (optionally with new settings). Untouched AI picks are soft-deleted
 * (restorable); clips the user made or edited stay, keep rendering, and new picks go around them. What was kept
 * and replaced is in the `stage.started` event and the analyze "kept" artifact.
 */
export async function reanalyzeProject(svc: Services, actor: Actor, projectId: string, patch?: ProjectSettingsPatch) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    const transcript = await u.db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, p.id), columns: { projectId: true } });
    if (!transcript) throw new TRPCError({ code: "BAD_REQUEST", message: "Project has no transcript yet" });
    // validate the merged result, but write only the keys given (atomic jsonb merge), so a settings change made
    // meanwhile by another request is not overwritten with this read of the whole object
    const merged = projectSettingsSchema.parse({ ...p.settings, ...(patch ?? {}) });
    const write = Object.fromEntries(Object.keys(patch ?? {}).map((k) => [k, merged[k as keyof ProjectSettings]]));
    const settings = sql`${schema.projects.settings} || ${JSON.stringify(write)}::jsonb`;
    await lockProjectClips(u, p.id);
    // before listing: an analyze committing its picks right now finishes first and they are replaced below, and one
    // still working (or this re-analyze clicked twice) is superseded and inserts nothing
    await supersedeStages(u, p.id);
    const clips = await listClips(u.db, p.id);
    const kept = clips.map((c) => ({ c, why: keepReason(c) })).filter((x) => x.why);
    const replaced = clips.filter((c) => !keepReason(c));
    for (const c of replaced) {
      await u.cancelLiveJobs(QUEUES.render, c.id);
      await u.cancelLiveJobs(QUEUES.prepare, c.id);
    }
    await u.cancelLiveJobs(QUEUES.analyze, p.id);
    if (replaced.length)
      await u.db
        .update(schema.clips)
        // a newer generation makes a render still running discard its output; an unfinished clip comes back failed
        .set({ deletedAt: new Date(), renderGen: sql`${schema.clips.renderGen} + 1`, status: sql`case when ${schema.clips.status} in ('done', 'failed') then ${schema.clips.status} else 'failed' end`, error: sql`case when ${schema.clips.status} in ('done', 'failed') then ${schema.clips.error} else 'Replaced by a re-analyze before it finished' end`, updatedAt: new Date() })
        .where(inArray(schema.clips.id, replaced.map((c) => c.id)));
    await startRun(u, p.id, { reason: "reanalyze", status: "analyzing", stage: "analyze", set: { settings }, continueActive: true });
    await u.emit(p.id, "stage.started", { stage: "analyze", status: "analyzing", repick: true, kept: kept.length, replaced: replaced.length });
    // the user asked for different picks: the replaced ones are weak negatives, not deletes they chose one by one
    if (byOwner(actor, p)) await recordDecisions(svc, u.db, p, () => clipDecisions(u.db, p.id, "clip.replaced", replaced, { explicit: false }));
    await u.artifact(p.id, "analyze", "kept", { kept: kept.map(({ c, why }) => ({ clipId: c.id, index: c.index, title: c.title, why })), replaced: replaced.map((c) => c.id), restorable: restorableFor(svc) });
    await u.enqueue(QUEUES.analyze, { projectId: p.id });
    u.afterCommit(() => svc.log.child({ module: "analyze", projectId: p.id }).info({ kept: kept.length, replaced: replaced.length }, "re-analyze keeps the clips the user made or edited"));
    return { ok: true, kept: kept.length, replaced: replaced.length, restorable: restorableFor(svc) };
  });
}

/**
 * The jsonb expression that merges `write` into the settings column (atomic: only these keys change). A change to any
 * style key also drops the legacy `captionPosition`, which `resolveStyle` would otherwise let override the new
 * `captionY`. The one place that rule lives: `updateProject` and `updateProjectStyle` both write through it.
 */
function settingsWrite(base: SQL, write: Record<string, unknown>): SQL {
  const touchesStyle = Object.keys(write).some((k) => k in styleSchema.shape);
  const without = touchesStyle ? sql`(${base}) - 'captionPosition'` : base;
  return sql`(${without}) || ${JSON.stringify(write)}::jsonb`;
}

/** Settings that only change which clips are picked: they apply on the next re-analyze. */
const SELECTION_KEYS = new Set<string>(["maxClips", "minClipSeconds", "maxClipSeconds", "focus", "instructions"]);
/** Settings burned into the video: they apply on each clip's next render. */
const RENDER_KEYS = new Set<string>([...Object.keys(styleSchema.shape), "reframe", "reframeAdjust", "pauses", "sourceText"]);
/** Refine-stage toggles: they apply the next time refine runs (projects.refine / retry). */
const REFINE_KEYS = new Set<string>(["refineEntities", "refineDisfluency", "disfluencyLlm", "refineScenes"]);
/** Set through `projects.setBumpers`, which checks the library. */
const BUMPER_KEYS = new Set<string>(["introAssetId", "outroAssetId", "introSec", "outroSec"]);

/**
 * Rename a project and/or change its settings without re-running anything: selection settings (focus, instructions,
 * clip length, maxClips) apply on the next re-analyze, style / framing / pauses on each clip's next render, refine
 * toggles on the next refine. Writes only the keys given (atomic JSON merge), validated against the whole settings
 * object. Per-clip style overrides are kept.
 */
export async function updateProject(svc: Services, actor: Actor, projectId: string, input: { title?: string; settings?: ProjectSettingsPatch; clear?: ClearableSetting[] }) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    const patch = Object.fromEntries(Object.entries(input.settings ?? {}).filter(([, v]) => v !== undefined)) as ProjectSettingsPatch;
    const bumperKeys = Object.keys(patch).filter((k) => BUMPER_KEYS.has(k));
    if (bumperKeys.length) throw new TRPCError({ code: "BAD_REQUEST", message: `${bumperKeys.join(", ")}: set the intro/outro with set_project_bumpers` });
    // the template new clips get must be one of the owner's live templates (null = none)
    if (typeof patch.layerTemplateId === "string") await getLayerTemplate(u.db, p.userId, patch.layerTemplateId);
    const clear = [...new Set(input.clear ?? [])].filter((k) => !(k in patch));
    const next: Record<string, unknown> = { ...p.settings, ...patch };
    for (const k of clear) delete next[k];
    const parsed = projectSettingsSchema.safeParse(next);
    if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const merged: ProjectSettings = parsed.data;
    if (merged.minClipSeconds >= merged.maxClipSeconds) throw new TRPCError({ code: "BAD_REQUEST", message: "minClipSeconds must be below maxClipSeconds" });
    const before = p.settings as Record<string, unknown>;
    const changed = [
      ...Object.keys(patch).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(merged[k as keyof ProjectSettings])),
      ...clear.filter((k) => before[k] !== undefined),
    ];
    const title = input.title?.trim();
    const titleChanged = !!title && title !== p.title;
    if (titleChanged) changed.unshift("title");
    const needsRerender = changed.some((k) => RENDER_KEYS.has(k));
    const needsReanalyze = changed.some((k) => SELECTION_KEYS.has(k));
    const needsRefine = changed.some((k) => REFINE_KEYS.has(k));
    if (changed.length) {
      let expr = sql`${schema.projects.settings}`;
      for (const k of clear) expr = sql`(${expr}) - ${k}::text`;
      const write = Object.fromEntries(Object.keys(patch).map((k) => [k, merged[k as keyof ProjectSettings]]));
      await u.db
        .update(schema.projects)
        .set({ ...(titleChanged ? { title } : {}), settings: settingsWrite(expr, write), updatedAt: new Date() })
        .where(eq(schema.projects.id, p.id));
      await u.emit(p.id, "project.updated", { changed });
    }
    const followUps = [
      needsReanalyze && "reanalyze_project picks clips with the new selection settings",
      needsRefine && "refine_project (or Retry) applies the new refine toggles on the existing transcript",
      needsRerender && "rerender_clips applies the style/framing to finished clips",
    ].filter(Boolean);
    return { ok: true, changed, needsReanalyze, needsRefine, needsRerender, ...(followUps.length ? { hint: `Saved; nothing was re-run. ${followUps.join("; ")}.` } : {}) };
  });
}

/** What `applyProjectFraming` takes from one section of a clip: its mode and what the user adjusted on it. */
export interface FramingTemplate {
  reframe: SectionMode;
  adjust?: SectionAdjustFields;
}

/**
 * The framing of a clip's section (the one at `at` seconds into the source, else the first section that is not plain
 * automatic, else the first), as a template for the whole project.
 */
export function framingOfClip(clip: { startSec: number; layoutSections: LayoutSection[] | null; layoutOverride?: string | null }, at?: number): FramingTemplate {
  const sections = [...(clip.layoutSections ?? [])].sort((a, b) => a.start - b.start);
  const pick = at !== undefined ? sections.find((s) => at >= s.start && at < s.end) : (sections.find((s) => s.mode !== "auto" || adjustOf(s)) ?? sections[0]);
  if (pick) return { reframe: pick.mode, ...(adjustOf(pick) ? { adjust: adjustOf(pick) } : {}) };
  const legacy = clip.layoutOverride && clip.layoutOverride !== "auto" ? (clip.layoutOverride === "none" ? "fit" : clip.layoutOverride) : "auto";
  return { reframe: legacy as SectionMode };
}

/**
 * Make one framing the project's: `reframe` and `reframeAdjust` are set on the project, every clip's own sections and
 * legacy override are cleared (unless `keepOverrides`), and the finished clips are re-rendered. The same for every
 * clip the project creates from now on. One transaction: clips locked in id order, then the project row.
 */
export async function applyProjectFraming(svc: Services, actor: Actor, projectId: string, input: FramingTemplate & { keepOverrides?: boolean; rerender?: boolean }) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    const adjust = input.adjust ? adjustOf(input.adjust) : undefined;
    await lockProjectClips(u, p.id);
    let cleared = 0;
    if (!input.keepOverrides) {
      const rows = await u.db
        .update(schema.clips)
        .set({ layoutSections: null, layoutOverride: null, updatedAt: new Date() })
        .where(and(eq(schema.clips.projectId, p.id), isNull(schema.clips.deletedAt), sql`(${schema.clips.layoutSections} is not null or ${schema.clips.layoutOverride} is not null)`))
        .returning({ id: schema.clips.id });
      cleared = rows.length;
    }
    let rerendered = 0;
    if (input.rerender !== false) {
      for (const c of await listClips(u.db, p.id)) if ((c.status === "done" || c.status === "failed") && (await requestRender(svc, u, p.id, c.id)) !== null) rerendered++;
    }
    const write = { reframe: input.reframe, reframeAdjust: adjust ?? null };
    await u.db
      .update(schema.projects)
      .set({ settings: sql`${schema.projects.settings} || ${JSON.stringify(write)}::jsonb`, updatedAt: new Date() })
      .where(eq(schema.projects.id, p.id));
    await u.emit(p.id, "project.updated", { changed: ["reframe", "reframeAdjust"], framingCleared: cleared });
    u.afterCommit(() => svc.log.child({ module: "projects", projectId: p.id }).info({ reframe: input.reframe, adjust, cleared, rerendered }, "framing applied to the project"));
    return { ok: true, reframe: input.reframe, adjust: adjust ?? null, cleared, rerendered };
  });
}

/**
 * The project as `actor` may see it. `deleted: false` = only a live project; `true` = live or deleted (restore).
 * NOT_FOUND for someone else's project unless the actor is an admin or the operator.
 */
export async function findProject(db: Db, actor: Actor, projectId: string, o: { deleted: boolean }) {
  const mine = actor && !actor.admin ? eq(schema.projects.userId, actor.id) : undefined;
  const p = await db.query.projects.findFirst({ where: and(eq(schema.projects.id, projectId), mine, o.deleted ? undefined : isNull(schema.projects.deletedAt)) });
  if (p) return p;
  if (o.deleted) throw new TRPCError({ code: "NOT_FOUND", message: `${NO_PROJECT} A deleted project is gone for good once its restore window has passed.` });
  // only on the failure path: tell "deleted" from "never yours / never existed"
  const inDeleted = await db.query.projects.findFirst({ where: and(eq(schema.projects.id, projectId), mine, isNotNull(schema.projects.deletedAt)), columns: { id: true } });
  throw new TRPCError({ code: "NOT_FOUND", message: inDeleted ? "That project is deleted; restore_project (or Deleted in the app) brings it back." : NO_PROJECT });
}
/** The sentence for a project id that is not the caller's or never existed. */
export const NO_PROJECT = "No project with that id in your account.";
/** The same for a clip; deleted clips are listed under Deleted. */
export const NO_CLIP = "No clip with that id in your account (deleted clips are under Deleted; restore_clip brings one back).";
export const gone = (svc: Services, what: string) => `No such ${what}. Deleted items can be restored ${restorableFor(svc)}; after that they are gone for good.`;

// ── purge ──────────────────────────────────────────────────────────────────

/**
 * Remove a project for good in the caller's unit of work: jobs cancelled, the row (and its clips, transcript, events)
 * deleted, files after commit. Its decisions go too when `forgetDecisions` or the project was deleted with that
 * choice; returns how many were forgotten.
 */
export async function purgeProject(svc: Services, u: UnitOfWork, projectId: string, opts: { forgetDecisions?: boolean } = {}): Promise<{ forgottenDecisions: number }> {
  for (const c of await u.db.select({ id: schema.clips.id }).from(schema.clips).where(eq(schema.clips.projectId, projectId))) {
    await u.cancelLiveJobs(QUEUES.render, c.id);
    await u.cancelLiveJobs(QUEUES.prepare, c.id);
  }
  for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, projectId);
  const [gone] = await u.db.delete(schema.projects).where(eq(schema.projects.id, projectId)).returning({ sourceMeta: schema.projects.sourceMeta, userId: schema.projects.userId, forget: schema.projects.forgetDecisionsOnPurge });
  await releaseUpload(svc, u, projectId, gone?.sourceMeta?.uploadId);
  // decisions outlive the project (docs/specs/decision-log.md) unless the owner asked to forget them, now or when deleting it
  const forgotten = gone && (gone.forget || opts.forgetDecisions) ? await forgetDecisions(u.db, gone.userId, { projectId }) : 0;
  u.afterCommit(async () => {
    await fs.rm(svc.paths.project(projectId), { recursive: true, force: true });
    await svc.storage.deletePrefix(keys.projectPrefix(projectId));
  });
  return { forgottenDecisions: forgotten };
}

export const PURGE_BATCH = 200;
export const PURGE_BUDGET_MS = 30_000;

/**
 * Hard-delete projects and clips deleted more than DELETED_RETENTION_DAYS ago (0 = never), rows first and files
 * after commit. Keyset over (deleted_at, id) per table, bounded per run; the rest continues next time. Runs with
 * the hourly storage sweep and `reelsaw storage sweep` / `reelsaw purge`.
 */
export async function purgeDeleted(svc: Services, opts: { dryRun?: boolean; now?: number } = {}): Promise<{ projects: string[]; clips: string[] }> {
  const out = { projects: [] as string[], clips: [] as string[] };
  if (days(svc) <= 0) return out;
  const log = svc.log.child({ module: "sweep" });
  const cutoff = new Date((opts.now ?? Date.now()) - days(svc) * 86_400_000).toISOString();
  type Cur = { at: string; id: string };
  // the timestamp travels as text: a JS Date would round the cursor to milliseconds and re-read or skip rows
  await keysetLoop<{ id: string; at: string }, Cur>({
    size: PURGE_BATCH,
    deadline: deadlineIn(PURGE_BUDGET_MS),
    start: null,
    fetch: async (cur, size) =>
      (
        await svc.database.db.execute(sql`
          select id, deleted_at::text as at from projects where deleted_at is not null and deleted_at < ${cutoff}::timestamptz
            ${cur ? sql`and (deleted_at, id) > (${cur.at}::timestamptz, ${cur.id})` : sql``}
          order by deleted_at, id limit ${size}`)
      ).rows as Array<{ id: string; at: string }>,
    cursorOf: (r) => ({ at: r.at, id: r.id }),
    handle: async (rows) => {
      for (const r of rows) {
        if (opts.dryRun) {
          out.projects.push(r.id);
          continue;
        }
        const done = await svc.tx(async (u) => {
          // re-check under the row lock: a restore since the batch was read wins
          const [p] = await u.db.select({ id: schema.projects.id }).from(schema.projects).where(and(eq(schema.projects.id, r.id), isNotNull(schema.projects.deletedAt), sql`${schema.projects.deletedAt} < ${cutoff}::timestamptz`)).for("update");
          if (!p) return false;
          await purgeProject(svc, u, r.id);
          return true;
        });
        if (done) {
          out.projects.push(r.id);
          log.info({ projectId: r.id, days: days(svc) }, "purged a deleted project");
        }
      }
    },
  });
  await keysetLoop<{ id: string; projectId: string; at: string }, Cur>({
    size: PURGE_BATCH,
    deadline: deadlineIn(PURGE_BUDGET_MS),
    start: null,
    fetch: async (cur, size) =>
      (
        await svc.database.db.execute(sql`
          select id, project_id as "projectId", deleted_at::text as at from clips where deleted_at is not null and deleted_at < ${cutoff}::timestamptz
            ${cur ? sql`and (deleted_at, id) > (${cur.at}::timestamptz, ${cur.id})` : sql``}
          order by deleted_at, id limit ${size}`)
      ).rows as Array<{ id: string; projectId: string; at: string }>,
    cursorOf: (r) => ({ at: r.at, id: r.id }),
    handle: async (rows) => {
      for (const r of rows) {
        if (opts.dryRun) {
          out.clips.push(r.id);
          continue;
        }
        const files = await svc.tx(async (u) => purgeClip(svc, u, r.id, { before: cutoff }));
        if (files) {
          out.clips.push(r.id);
          log.info({ clipId: r.id, projectId: files.projectId, files: files.files.length, days: days(svc) }, "purged a replaced clip");
        }
      }
    },
  });
  return out;
}

// ── create, retry, refine and the settings that re-render ──────────────────

/** Re-render the clips matching `which` (default: finished or failed ones) in this unit of work. Returns how many were queued and how many live clips were left alone (still preparing or rendering: they finish with the old settings). */
export async function rerenderProjectClips(svc: Services, u: UnitOfWork, projectId: string, which: (c: typeof schema.clips.$inferSelect) => boolean = (c) => c.status === "done" || c.status === "failed") {
  let n = 0;
  let skipped = 0;
  await lockProjectClips(u, projectId);
  for (const c of await listClips(u.db, projectId)) {
    if (!which(c)) skipped++;
    else if ((await requestRender(svc, u, projectId, c.id)) !== null) n++;
  }
  return { queued: n, skipped };
}

/**
 * Start a project for `userId` from a link or an upload: quota, the new row, its `project.created` event, the run and
 * the first (ingest) job commit together, so there is never a "queued" project with no job behind it.
 * tRPC `projects.create`, the MCP create_project tool and `reelsaw create-project` call this.
 */
export async function createProject(svc: Services, userId: string, input: CreateProjectInput): Promise<typeof schema.projects.$inferSelect> {
  const db = svc.database.db;
  const log = svc.log.child({ module: "projects", userId });
  if (!input.sourceUrl && !input.uploadId) throw new TRPCError({ code: "BAD_REQUEST", message: "Give a sourceUrl (a link to the video) or an uploadId." });
  const quotaReached = (err: unknown): never => {
    log.warn({ reason: err instanceof Error ? err.message : String(err) }, "project quota reached");
    throw err;
  };
  // early refusal before the URL peek; the binding check runs again, locked, in the transaction that inserts
  await checkProjectQuota(db, svc.settings.get(), userId, { ent: svc.entitlements }).catch(quotaReached);
  let sourceMeta: (typeof schema.projects.$inferSelect)["sourceMeta"] = null;
  let title = input.title?.trim() || "";
  if (input.uploadId) {
    const up = await db.query.uploads.findFirst({ where: and(eq(schema.uploads.id, input.uploadId), eq(schema.uploads.userId, userId)) });
    if (!up) throw new TRPCError({ code: "NOT_FOUND", message: "No upload with that id in your account." });
    sourceMeta = { uploadId: up.id, filename: up.filename };
    title ||= up.filename.replace(/\.[^.]+$/, "");
  } else if (input.sourceUrl) {
    const [peek, announced] = await Promise.all([peekUrlMeta(input.sourceUrl), announcedMinutesFor(svc, userId, input.sourceUrl, log)]);
    // a video the account's minutes cannot cover is refused here, with the upgrade offer, not created and failed by ingest
    if (announced) await checkAnnouncedMinutes(db, svc.settings.get(), userId, announced, svc.entitlements).catch(quotaReached);
    sourceMeta = { ...(peek.thumbnail ? { thumbnail: peek.thumbnail } : {}), ...(peek.uploader ? { uploader: peek.uploader } : {}) };
    title ||= peek.title ?? "";
  }
  title ||= "Untitled";
  const id = randomUUID();
  return svc.tx(async (u) => {
    // counted under a per-user lock in the inserting transaction, so concurrent creates can't overshoot the cap
    await checkProjectQuota(u.db, svc.settings.get(), userId, { lock: true, ent: svc.entitlements }).catch(quotaReached);
    // defaults, caller values and the intro/outro ownership + liveness check see one snapshot
    const settings = await resolveProjectSettings(u.db, userId, input.settings);
    if (settings.minClipSeconds >= settings.maxClipSeconds) throw new TRPCError({ code: "BAD_REQUEST", message: "minClipSeconds must be below maxClipSeconds" });
    const [row] = await u.db
      .insert(schema.projects)
      .values({ id, userId, title, sourceType: input.uploadId ? "upload" : "url", sourceUrl: input.sourceUrl ?? null, sourceMeta, settings, status: "queued" })
      .returning();
    if (!row) throw new Error("the project row was not returned");
    await recordProjectCreated(u.db, userId, id, row.createdAt);
    await syncProjectRefs(u.db, row); // the defaults' intro/outro
    await u.emit(id, "project.created", { title });
    await startRun(u, id, { reason: "created", status: "queued" });
    await u.enqueue(QUEUES.ingest, { projectId: id });
    return row;
  });
}

/**
 * The length a link announces, in seconds, looked up only when the account has a minutes limit (no lookup, no wait, for
 * everyone else). Null when the site does not say, the link is not a public address, or the lookup is slow or fails:
 * ingest checks again before downloading and on the file itself.
 */
async function announcedMinutesFor(svc: Services, userId: string, url: string, log: Services["log"]): Promise<number | null> {
  if (!(await hasMinuteLimits(svc.database.db, svc.settings.get(), userId, svc.entitlements))) return null;
  try {
    await assertPublicHttpUrl(url, { allowPrivate: svc.settings.get().ALLOW_PRIVATE_SOURCE_URLS });
    return await announcedDuration(svc.media, url, AbortSignal.timeout(ANNOUNCED_LOOKUP_MS));
  } catch (err) {
    log.debug({ err }, "could not look up the video's length before creating the project");
    return null;
  }
}
/** How long creating a project from a link may wait for the site to say how long the video is. */
const ANNOUNCED_LOOKUP_MS = 12_000;

/** Resume a project from its furthest completed stage (the Retry button, retry_project, `reelsaw retry`). */
export async function retryOwnedProject(svc: Services, actor: Actor, projectId: string) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    const r = await retryProject(svc, u, p.id);
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "That project was deleted while it was being retried; restore_project brings it back." });
    return r;
  });
}

export const refineInput = {
  steps: z.array(z.enum(REFINE_STEPS)).optional().describe("Which refine steps to re-run; default all"),
  vocabulary: z.string().max(1000).optional().describe("Names and terms the transcript should spell this way; empty string clears it"),
};

/** Re-run some or all refine steps (names, disfluencies, scene cuts) on the existing transcript. */
export async function refineProject(svc: Services, actor: Actor, projectId: string, input: { steps?: ReadonlyArray<(typeof REFINE_STEPS)[number]>; vocabulary?: string }) {
  const steps = input.steps?.length ? [...new Set(input.steps)] : [...REFINE_STEPS];
  await svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    // transcript first, then the project row (vocabulary, startRun)
    const [cur] = await u.db.select({ refine: schema.transcripts.refine }).from(schema.transcripts).where(eq(schema.transcripts.projectId, p.id)).for("update");
    if (!cur) throw new TRPCError({ code: "BAD_REQUEST", message: "Project has no transcript yet" });
    // a refine already running restarts; anything else running (renders, picking) would have its status
    // overwritten and never finalize, so wait for it
    if (!["done", "failed", "refining"].includes(p.status)) throw new TRPCError({ code: "CONFLICT", message: `The project is busy (${p.status}); refine it when that finishes` });
    if (input.vocabulary !== undefined) {
      const vocabulary = input.vocabulary || undefined;
      const check = projectSettingsSchema.safeParse({ ...p.settings, vocabulary }); // validate the result; write only the key (atomic merge)
      if (!check.success) throw new TRPCError({ code: "BAD_REQUEST", message: check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      const settings = vocabulary ? sql`${schema.projects.settings} || ${JSON.stringify({ vocabulary })}::jsonb` : sql`${schema.projects.settings} - 'vocabulary'`;
      await u.db.update(schema.projects).set({ settings, updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
    }
    // a step of the refine being restarted that is still running is superseded too, so it runs again with the rest
    const rerun = [...new Set([...steps, ...REFINE_STEPS.filter((s) => cur.refine[s] !== "done" && cur.refine[s] !== "failed")])];
    for (const s of rerun) await u.cancelLiveJobs(REFINE_QUEUE[s], p.id);
    await supersedeStages(u, p.id);
    await startRun(u, p.id, { reason: "refine", status: "refining", stage: "refine" });
    const refine = { ...cur.refine };
    for (const s of steps) delete refine[s];
    await u.db.update(schema.transcripts).set({ refine }).where(eq(schema.transcripts.projectId, p.id));
    const started = await enqueueRefine(svc, p.id, await stageSeqOf(u.db, p.id), rerun, u, { onlyIfIdle: true });
    if (!started) throw new TRPCError({ code: "CONFLICT", message: "The project is busy; wait for it to finish before refining." });
  });
  return { ok: true as const, steps };
}

/** Hide or keep text burned into the source (captions, logos); re-renders the finished clips so the whole set agrees. */
export async function setProjectSourceText(svc: Services, actor: Actor, projectId: string, sourceText: "hide" | "keep" | "always") {
  const { queued: rerendered, skipped } = await svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    // clips first (locked in id order), the project row last; the jobs only start once this commits with the new setting
    const n = await rerenderProjectClips(svc, u, p.id);
    // atomic JSON merge: no read-modify-write, so concurrent settings edits can't drop each other
    await u.db.update(schema.projects).set({ settings: sql`${schema.projects.settings} || ${JSON.stringify({ sourceText })}::jsonb`, updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
    return n;
  });
  return { ok: true as const, rerendered, skipped };
}

const bumperChoice = z.string().min(1).max(100);
export const projectBumpersInput = z.object({
  intro: bumperChoice.optional(),
  outro: bumperChoice.optional(),
  introSec: bumperSecondsSchema.optional(),
  outroSec: bumperSecondsSchema.optional(),
  rerender: z.boolean().default(false),
});
export type ProjectBumpersInput = z.input<typeof projectBumpersInput>;

/**
 * Per-project intro/outro: for each slot "default" (the owner's current default), "none" (even if the default has one) or
 * a library asset id. Re-renders every finished clip only when `rerender` is set. The library is the project owner's.
 */
export async function setProjectBumpers(svc: Services, actor: Actor, projectId: string, input: ProjectBumpersInput) {
  const rerendered = await svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    const mine = await userDefaults(u.db, p.userId);
    let expr = sql`${schema.projects.settings}`;
    const patch: Record<string, string | number | null> = {};
    for (const [slot, key, choice, secs] of [["intro", "introAssetId", input.intro, input.introSec], ["outro", "outroAssetId", input.outro, input.outroSec]] as const) {
      if (choice === undefined) continue;
      expr = sql`(${expr}) - ${key}::text - ${`${slot}Sec`}::text`;
      if (secs !== undefined && choice !== "none") patch[`${slot}Sec`] = secs;
      if (choice === "none") patch[key] = null;
      else if (choice === "default") {
        if (mine[key]) patch[key] = mine[key]!;
      } else {
        // a library asset of this user; the one the project already uses stays valid even if it was since removed
        const [asset] = await u.db.select({ id: schema.assets.id, deletedAt: schema.assets.deletedAt }).from(schema.assets).where(and(eq(schema.assets.id, choice), assetVisibleTo(p.userId)));
        if (!asset || (asset.deletedAt && p.settings[key] !== choice)) throw new TRPCError({ code: "NOT_FOUND", message: `That ${slot} is not in your library` });
        patch[key] = choice;
      }
    }
    // clips first, the project row last (lock order clip → project)
    const n = input.rerender ? (await rerenderProjectClips(svc, u, p.id)).queued : 0;
    const [after] = await u.db.update(schema.projects).set({ settings: sql`(${expr}) || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() }).where(eq(schema.projects.id, p.id)).returning({ id: schema.projects.id, settings: schema.projects.settings });
    if (after) await syncProjectRefs(u.db, after);
    return n;
  });
  return { ok: true as const, rerendered };
}

export const projectStyleInput = z.object({ style: styleOverrideSchema, keepOverrides: z.boolean().optional(), rerender: z.boolean().default(true) });
export type ProjectStyleInput = z.input<typeof projectStyleInput>;

/**
 * Change the project-wide caption/hook style. Clears per-clip style overrides unless keepOverrides, and re-renders every
 * finished clip (unless rerender is false) so the whole set stays consistent.
 */
export async function updateProjectStyle(svc: Services, actor: Actor, projectId: string, input: ProjectStyleInput) {
  const { queued: rerendered, skipped } = await svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    // validate against the whole settings object, but write only the changed keys (atomic merge)
    const check = projectSettingsSchema.safeParse({ ...p.settings, ...input.style });
    if (!check.success) throw new TRPCError({ code: "BAD_REQUEST", message: check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const merged: Record<string, unknown> = { ...check.data };
    const patch = Object.fromEntries(Object.keys(input.style).map((k) => [k, merged[k]]));
    // clips first (locked in id order, then cleared and re-rendered), the project row last
    await lockProjectClips(u, p.id);
    if (!input.keepOverrides) await u.db.update(schema.clips).set({ style: null }).where(eq(schema.clips.projectId, p.id));
    const n = input.rerender !== false ? await rerenderProjectClips(svc, u, p.id) : { queued: 0, skipped: 0 };
    await u.db.update(schema.projects).set({ settings: settingsWrite(sql`${schema.projects.settings}`, patch), updatedAt: new Date() }).where(eq(schema.projects.id, p.id));
    return n;
  });
  return { ok: true as const, rerendered, skipped };
}
