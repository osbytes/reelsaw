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
import { and, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import {
  REFINE_STEPS,
  adjustOf,
  bumperSecondsSchema,
  formatBytes,
  projectSettingsSchema,
  withSpokenLanguage,
  styleOverrideSchema,
  styleSchema,
  type ClearableSetting,
  type CreateProjectInput,
  type LayoutSection,
  type ProjectSettings,
  type ProjectSettingsPatch,
  type SectionAdjustFields,
  type SectionMode,
  type PartialSource,
  formatDay,
  processedEndSec,
  spansCover,
  transcriptSpans,
  replayPeaks,
  type HeatBin,
  type ReplayPeak,
  type RangeChange,
  type SourceRangeInput,
  MAX_RANGES,
  planRanges,
  rangeSchema,
} from "@reelsaw/shared";
import {
  admitRanges,
  checkAnnouncedMinutes,
  checkProjectQuota,
  checkRestoreQuota,
  extensionRefusal,
  hasMinuteLimits,
  minutesAllowance,
  minutesOffer,
  minutesRoomSec,
  partialUntil,
  predictAdmission,
  projectStoredBytes,
  QuotaError,
  recordProjectCreated,
  recordSourceExtension,
  refusalEvent,
  type MinutesAllowance,
} from "../quota.js";
import type { QuotaRefusal } from "@reelsaw/shared";
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
import { coverageOf, projectNeededSpans } from "../pipeline/transcribe.js";
import { rangeProblemsText, rangesRefused } from "./ranges.js";
import { finalizeProjectIfDone, lockProjectClips, requestPrepare, requestRender, stageSeqOf, startRun, supersedeStages } from "../pipeline/lifecycle.js";
import { needsPrepare } from "../pipeline/manual.js";
import { enqueueRefine, REFINE_QUEUE } from "../pipeline/refine.js";
import { resolveProjectSettings, userDefaults } from "../pipeline/settings.js";
import { syncProjectRefs } from "../library/refs.js";
import { assetVisibleTo } from "../library/visible.js";
import { LIVE_SOURCE_MESSAGE, LiveSourceError, announcedDuration, announcedHeatmap, peekUrlMeta } from "./peek.js";
import { failedRow, runFacts } from "../pipeline/common.js";
import { deadlineIn, keysetLoop } from "../lib/batch.js";
import { getLayerTemplate } from "../library/templates.js";
import { clipDecisions, forgetDecisions, recordDecisions } from "../decisions/service.js";
import { msg, plural as icuPlural, select as icuSelect } from "@lingui/core/runtime-macro";
import { AppError, t } from "../i18n.js";

const STAGE_QUEUES = [QUEUES.ingest, QUEUES.transcribe, QUEUES.refineEntities, QUEUES.refineDisfluency, QUEUES.refineScenes, QUEUES.analyze] as const;
export const WORKING = ["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"] as const;
const IN_FLIGHT = ["preparing", "pending", "rendering"] as const;

/** Who is asking: the owner, an admin (any project), or the operator CLI (null). */
export type Actor = { id: string; admin: boolean } | null;

/** The project's owner acting (not an admin or the operator CLI): only their own choices go in their decision log. */
export function byOwner(actor: Actor, p: { userId: string }): boolean {
  return !!actor && actor.id === p.userId;
}

const days = (svc: Services) => svc.settings.get().DELETED_RETENTION_DAYS;
/** "for 7 days" / "until you purge it", for messages and tool results. */
/** "for 30 days" / "until it is purged": how long a deleted item can come back, for the sentences and the `restorable` field. */
export const restorableFor = (svc: Services) =>
  t(
    msg({
      id: "deleted.restorable_for",
      message: icuPlural({ days: Math.max(0, days(svc)) }, { 0: "until it is purged", one: "for # day", other: "for # days" }),
    }),
  );

/**
 * Where a retry resumes, from what the project already has. Live clips mean render, except when the project failed in
 * analyze and none of them is an AI pick: only clips the user made or kept survived a failed re-analyze, so picking
 * moments still has to run. A source that retention removed is fetched again first, whatever else exists.
 */
export function retryQueueFor(s: {
  clips: ReadonlyArray<{ origin: string }>;
  transcript: boolean;
  refineDone: boolean;
  stage: string | null;
  sourceKey: string | null;
  sourceExpired?: boolean;
  /** the transcript has every word up to the project's limit (false: an extension stopped before its words were in) */
  transcriptCovers?: boolean;
  /** an extension is waiting for its picks (`extend_from_sec`): the clips that exist are the old part's, not this run's */
  extending?: boolean;
}): QueueName {
  if (s.sourceExpired) return QUEUES.ingest;
  if (s.transcript && s.transcriptCovers === false) return QUEUES.transcribe;
  if (s.transcript && s.extending) return s.refineDone ? QUEUES.analyze : QUEUES.refineEntities;
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
 * The project's retry lock comes first (advisory, before any row lock), then transcript → clip → project. Returns
 * null when the project is gone or deleted, or, with `onlyIfFailed` (admin and automatic retries), when it is no
 * longer failed: a retry that waited on the lock sees the run the other one started and leaves it alone.
 */
export async function retryProject(
  svc: Services,
  u: UnitOfWork,
  projectId: string,
  opts: { onlyIfFailed?: boolean } = {},
): Promise<{ ok: true; queue: QueueName } | null> {
  await takeTxLock(u.db, txLock.retry(projectId));
  const [p] = await u.db
    .select({
      id: schema.projects.id,
      sourceKey: schema.projects.sourceKey,
      sourceExpiredAt: schema.projects.sourceExpiredAt,
      stage: schema.projects.stage,
      status: schema.projects.status,
      sourceLimitSec: schema.projects.sourceLimitSec,
      extendFromSec: schema.projects.extendFromSec,
      durationSec: schema.projects.durationSec,
    })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  if (!p || (opts.onlyIfFailed && p.status !== "failed")) return null;
  const [transcript] = await u.db
    .select({ projectId: schema.transcripts.projectId, refine: schema.transcripts.refine, covered: schema.transcripts.covered })
    .from(schema.transcripts)
    .where(eq(schema.transcripts.projectId, p.id))
    .for("update");
  await lockProjectClips(u, p.id);
  // deleted while we waited for the locks (deleting locks the clips first, so it is settled now): resume nothing
  const [live] = await u.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, p.id), isNull(schema.projects.deletedAt)))
    .for("no key update");
  if (!live) return null;
  const clips = await listClips(u.db, p.id);
  const covers = !transcript || spansCover(coverageOf(transcript.covered), await projectNeededSpans(u.db, p));
  const refineDone = !!transcript && REFINE_STEPS.every((s) => transcript.refine[s] === "done" || transcript.refine[s] === "failed");
  const queue = retryQueueFor({
    clips,
    transcript: !!transcript,
    refineDone,
    stage: p.stage,
    sourceKey: p.sourceKey,
    sourceExpired: !!p.sourceExpiredAt,
    transcriptCovers: covers,
    extending: p.extendFromSec !== null,
  });

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
  await u.emit("stage.started", { projectId: p.id, stage: queue, retried: true });
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
  const [before] = await u.db
    .select({ status: schema.projects.status, stage: schema.projects.stage })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  if (!before) return false;
  for (const c of await listClips(u.db, projectId)) {
    await u.cancelLiveJobs(QUEUES.render, c.id);
    await u.cancelLiveJobs(QUEUES.prepare, c.id);
  }
  for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, projectId);
  const stopped = "Stopped because the project was deleted. Retry to continue.";
  await u.db
    .update(schema.clips)
    .set({ ...failedRow(stopped), renderGen: sql`${schema.clips.renderGen} + 1` })
    .where(and(eq(schema.clips.projectId, projectId), inArray(schema.clips.status, [...IN_FLIGHT]), isNull(schema.clips.deletedAt)));
  const working = (WORKING as readonly string[]).includes(before.status);
  const facts = working ? await runFacts(u.db, projectId) : null;
  // stage_seq too: a stage job still running stays stale after a restore, which resumes only through Retry
  await u.db
    .update(schema.projects)
    .set({
      deletedAt: new Date(),
      forgetDecisionsOnPurge: !!opts.forgetDecisions,
      stageSeq: sql`${schema.projects.stageSeq} + 1`,
      updatedAt: new Date(),
      ...(working ? failedRow(stopped) : {}),
    })
    .where(eq(schema.projects.id, projectId));
  // the run it interrupted ends here, so its history reads as stopped rather than running forever
  if (facts) await u.emit("project.failed", { projectId: projectId, stage: before.stage ?? "ingest", error: stopped, cancelled: true, ...facts });
  await u.emit("project.deleted", { projectId: projectId, days: days(svc), stopped: working });
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
    const restorable = restorableFor(svc);
    const base = stored
      ? t(msg`Deleted. It can be restored ${{ restorable }}. It still uses ${{ size: formatBytes(stored) }} until you delete it forever.`)
      : t(msg`Deleted. It can be restored ${{ restorable }}.`);
    return {
      ok: true,
      changed,
      restorable: restorableFor(svc),
      storedBytes: stored,
      forgetDecisions: !!opts.forgetDecisions,
      message: opts.forgetDecisions ? `${base} ${t(msg`What Reelsaw learned from it is forgotten when it is deleted forever.`)}` : base,
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
    await u.db
      .update(schema.projects)
      .set({ deletedAt: null, forgetDecisionsOnPurge: false, updatedAt: new Date() })
      .where(and(eq(schema.projects.id, projectId), isNotNull(schema.projects.deletedAt)));
    await u.emit("project.restored", { projectId: projectId });
    return { ok: true, changed: true, status: p.status };
  });
}

/** Remove a already-deleted project for good (owner or admin): rows and files go, storage is freed. Minutes already counted stay on the usage ledger. */
export async function purgeOwnedProject(svc: Services, actor: Actor, projectId: string, opts: { forgetDecisions?: boolean } = {}) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: true });
    if (!p.deletedAt)
      throw new AppError(
        "BAD_REQUEST",
        msg({ id: "project.purge_needs_delete", message: "Delete it first. Only projects already in Deleted can be deleted forever." }),
      );
    // re-check under the row lock (clips first, then the project, like deleteProject): a restore that committed since
    // the read above wins, instead of this deleting a project that is live again for good
    await lockProjectClips(u, projectId);
    const [still] = await u.db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, projectId), isNotNull(schema.projects.deletedAt)))
      .for("update");
    if (!still) throw new AppError("CONFLICT", msg({ id: "project.restored_meanwhile", message: "It was restored meanwhile, so nothing was deleted." }));
    const stored = await projectStoredBytes(u.db, projectId);
    const forget = opts.forgetDecisions || p.forgetDecisionsOnPurge;
    const { forgottenDecisions } = await purgeProject(svc, u, projectId, { forgetDecisions: forget });
    const freed = deletedForever(stored);
    return {
      ok: true,
      storedBytes: stored,
      forgottenDecisions,
      message: forget ? `${freed} ${t(msg`What Reelsaw learned from it is forgotten too.`)}` : freed,
    };
  });
}

/**
 * Hard-delete one already-deleted clip: the row first, files after commit. `before` is the sweep cutoff (ISO);
 * omitted = any deleted clip (the owner's Remove for good). Returns null if it was restored or already gone.
 */
export async function purgeClip(
  svc: Services,
  u: UnitOfWork,
  clipId: string,
  opts: { before?: string } = {},
): Promise<{ projectId: string; files: string[] } | null> {
  const [c] = await u.db
    .delete(schema.clips)
    .where(
      and(
        eq(schema.clips.id, clipId),
        isNotNull(schema.clips.deletedAt),
        opts.before ? sql`${schema.clips.deletedAt} < ${opts.before}::timestamptz` : undefined,
      ),
    )
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
    if (!c) throw new AppError("NOT_FOUND", clipGone(svc));
    await findProject(u.db, actor, c.projectId, { deleted: false });
    if (!c.deletedAt)
      throw new AppError(
        "BAD_REQUEST",
        msg({ id: "clip.purge_needs_delete", message: "Delete it first. Only clips already in Deleted can be deleted forever." }),
      );
    const stored = c.outputKey && c.outputBytes ? c.outputBytes : 0;
    await purgeClip(svc, u, clipId);
    return { ok: true as const, storedBytes: stored, message: deletedForever(stored) };
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
    .set({
      deletedAt: new Date(),
      renderGen: sql`${schema.clips.renderGen} + 1`,
      ...(unfinished ? failedRow("Deleted before it finished") : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.clips.id, c.id));
  await u.emit("clip.deleted", { projectId: c.projectId, clipId: c.id, index: c.index, title: c.title, days: days(svc) });
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
    if (!c) throw new AppError("NOT_FOUND", clipGone(svc));
    const p = await findProject(u.db, actor, c.projectId, { deleted: false });
    const changed = await markClipDeleted(svc, u, c);
    if (changed) await finalizeProjectIfDone(svc, u, c.projectId);
    if (changed && byOwner(actor, p)) await recordDecisions(svc, u, p, () => clipDecisions(u.db, p.id, "clip.delete", [c]));
    const stored = clipStored(c);
    return {
      ok: true,
      changed,
      clipId,
      /** a render or preparation that was in flight was stopped */
      stoppedRender: changed && c.status !== "done" && c.status !== "failed",
      restorable: restorableFor(svc),
      storedBytes: stored,
      message: t(msg`Deleted. restore_clip brings it back ${{ restorable: restorableFor(svc) }}.`),
    };
  });
}

/**
 * Soft-delete several clips of one live project (the selection bar). One transaction, clip locks first then the
 * project row (finalize). Already-deleted ids are counted as skipped. tRPC `clips.deleteMany`, the BatchBar.
 */
export async function deleteClips(svc: Services, actor: Actor, projectId: string, clipIds: string[]) {
  const ids = [...new Set(clipIds)].slice(0, 200);
  if (!ids.length) throw new AppError("BAD_REQUEST", msg({ id: "clip.pick_at_least_one", message: "Pick at least one clip" }));
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    await lockProjectClips(u, projectId);
    const rows = await u.db
      .select()
      .from(schema.clips)
      .where(and(eq(schema.clips.projectId, projectId), inArray(schema.clips.id, ids)));
    if (rows.length !== ids.length)
      throw new AppError("NOT_FOUND", msg({ id: "clip.selected_not_on_project", message: "A selected clip is not on this project" }));
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
    if (byOwner(actor, p)) await recordDecisions(svc, u, p, () => clipDecisions(u.db, p.id, "clip.delete", gone));
    return { ok: true as const, deleted, skipped, stoppedRenders, restorable: restorableFor(svc), storedBytes };
  });
}

/**
 * Bring back a clip a re-analyze replaced (or that was deleted). It keeps its number when no live clip took it
 * since (an Undo puts clip #1 back as #1), else it goes to the end of the project's list; a clip that never
 * finished rendering needs a re-render.
 */
export async function restoreClip(svc: Services, actor: Actor, clipId: string) {
  return svc.tx(async (u) => {
    const [c] = await u.db.select().from(schema.clips).where(eq(schema.clips.id, clipId)).for("update");
    if (!c) throw new AppError("NOT_FOUND", clipGone(svc));
    const p = await findProject(u.db, actor, c.projectId, { deleted: true });
    if (p.deletedAt)
      throw new AppError(
        "BAD_REQUEST",
        msg({ id: "clip.restore_project_deleted", message: "Its project is deleted. Restore the project (restore_project) to bring its clips back." }),
      );
    if (!c.deletedAt) return { ok: true, changed: false, clipId, status: c.status };
    const [{ next, taken } = { next: 0, taken: false }] = await u.db
      .select({
        next: sql<number>`coalesce(max(${schema.clips.index}) + 1, 0)::int`,
        taken: sql<boolean>`coalesce(bool_or(${schema.clips.index} = ${c.index}), false)`,
      })
      .from(schema.clips)
      .where(and(eq(schema.clips.projectId, c.projectId), isNull(schema.clips.deletedAt)));
    const index = taken ? next : c.index;
    await u.db.update(schema.clips).set({ deletedAt: null, index, updatedAt: new Date() }).where(eq(schema.clips.id, clipId));
    await u.emit("clip.restored", { projectId: c.projectId, clipId, index, title: c.title });
    if (byOwner(actor, p)) await recordDecisions(svc, u, p, () => clipDecisions(u.db, p.id, "clip.restore", [c], { side: "after" }));
    return { ok: true, changed: true, clipId, status: c.status, needsRerender: c.status !== "done" };
  });
}

/** Deleted projects across the install (operator CLI), newest first, with when each is purged. */
export async function deletedProjects(svc: Services, limit = 100) {
  const rows = await svc.database.db
    .select({
      id: schema.projects.id,
      title: schema.projects.title,
      status: schema.projects.status,
      userId: schema.projects.userId,
      email: schema.user.email,
      deletedAt: schema.projects.deletedAt,
    })
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
    .select({
      id: schema.clips.id,
      index: schema.clips.index,
      title: schema.clips.title,
      startSec: schema.clips.startSec,
      endSec: schema.clips.endSec,
      status: schema.clips.status,
      deletedAt: schema.clips.deletedAt,
    })
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
    const transcript = await u.db.query.transcripts.findFirst({
      where: eq(schema.transcripts.projectId, p.id),
      columns: { projectId: true, covered: true },
    });
    if (!transcript) throw new AppError("BAD_REQUEST", msg({ id: "project.no_transcript_yet", message: "Project has no transcript yet" }));
    // picking again before the rest of the video's words are in would pick from the old part only, and its picks
    // would be replaced again by the extension's
    if (!spansCover(coverageOf(transcript.covered), await projectNeededSpans(u.db, p)))
      throw new AppError(
        "CONFLICT",
        msg({ id: "project.still_transcribing_rest", message: "Reelsaw is still transcribing the rest of this video. Pick moments again when it is done." }),
      );
    // validate the merged result, but write only the keys given (atomic jsonb merge), so a settings change made
    // meanwhile by another request is not overwritten with this read of the whole object
    const given = withSpokenLanguage(patch ?? {});
    const merged = projectSettingsSchema.parse({ ...p.settings, ...given });
    const write = Object.fromEntries(Object.keys(given).map((k) => [k, merged[k as keyof ProjectSettings]]));
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
        .set({
          deletedAt: new Date(),
          renderGen: sql`${schema.clips.renderGen} + 1`,
          status: sql`case when ${schema.clips.status} in ('done', 'failed') then ${schema.clips.status} else 'failed' end`,
          error: sql`case when ${schema.clips.status} in ('done', 'failed') then ${schema.clips.error} else 'Replaced by a re-analyze before it finished' end`,
          updatedAt: new Date(),
        })
        .where(
          inArray(
            schema.clips.id,
            replaced.map((c) => c.id),
          ),
        );
    // a re-pick covers everything processed (every range is picked from again), so an extension waiting for its picks is folded into it
    await u.db.update(schema.projectRanges).set({ pickedAt: null }).where(eq(schema.projectRanges.projectId, p.id));
    await startRun(u, p.id, { reason: "reanalyze", status: "analyzing", stage: "analyze", set: { settings, extendFromSec: null }, continueActive: true });
    await u.emit("stage.started", {
      projectId: p.id,
      stage: "analyze",
      status: "analyzing",
      repick: true,
      kept: kept.length,
      replaced: replaced.length,
      keptClipIds: kept.map(({ c }) => c.id),
      replacedClipIds: replaced.map((c) => c.id),
    });
    // the user asked for different picks: the replaced ones are weak negatives, not deletes they chose one by one
    if (byOwner(actor, p)) await recordDecisions(svc, u, p, () => clipDecisions(u.db, p.id, "clip.replaced", replaced, { explicit: false }));
    await u.artifact(p.id, "analyze", "kept", {
      kept: kept.map(({ c, why }) => ({ clipId: c.id, index: c.index, title: c.title, why })),
      replaced: replaced.map((c) => c.id),
      restorable: restorableFor(svc),
    });
    await u.enqueue(QUEUES.analyze, { projectId: p.id });
    u.afterCommit(() =>
      svc.log
        .child({ module: "analyze", projectId: p.id })
        .info({ kept: kept.length, replaced: replaced.length }, "re-analyze keeps the clips the user made or edited"),
    );
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
export async function updateProject(
  svc: Services,
  actor: Actor,
  projectId: string,
  input: {
    title?: string | undefined;
    settings?: ProjectSettingsPatch | undefined;
    clear?: ClearableSetting[] | undefined;
    /** replaces the whole map (no merge); {} clears it */
    metadata?: Record<string, string> | undefined;
  },
) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    const patch = withSpokenLanguage(Object.fromEntries(Object.entries(input.settings ?? {}).filter(([, v]) => v !== undefined)) as ProjectSettingsPatch);
    const bumperKeys = Object.keys(patch).filter((k) => BUMPER_KEYS.has(k));
    if (bumperKeys.length)
      throw new AppError(
        "BAD_REQUEST",
        msg({ id: "project.bumpers_elsewhere", message: msg`${{ keys: bumperKeys.join(", ") }}: set the intro/outro with set_project_bumpers` }),
      );
    // the template new clips get must be one of the owner's live templates (null = none)
    if (typeof patch.layerTemplateId === "string") await getLayerTemplate(u.db, p.userId, patch.layerTemplateId);
    const clear = [...new Set(input.clear ?? [])].filter((k) => !(k in patch));
    const next: Record<string, unknown> = { ...p.settings, ...patch };
    for (const k of clear) delete next[k];
    const parsed = projectSettingsSchema.safeParse(next);
    if (!parsed.success) throw new TRPCError({ code: "BAD_REQUEST", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    const merged: ProjectSettings = parsed.data;
    if (merged.minClipSeconds >= merged.maxClipSeconds)
      throw new AppError("BAD_REQUEST", msg({ id: "project.min_below_max", message: "minClipSeconds must be below maxClipSeconds" }));
    const before = p.settings as Record<string, unknown>;
    const changed = [
      ...Object.keys(patch).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(merged[k as keyof ProjectSettings])),
      ...clear.filter((k) => before[k] !== undefined),
    ];
    const title = input.title?.trim();
    const titleChanged = !!title && title !== p.title;
    if (titleChanged) changed.unshift("title");
    const metadataChanged = input.metadata !== undefined && JSON.stringify(input.metadata) !== JSON.stringify(p.metadata);
    if (metadataChanged) changed.push("metadata");
    const needsRerender = changed.some((k) => RENDER_KEYS.has(k));
    const needsReanalyze = changed.some((k) => SELECTION_KEYS.has(k));
    const needsRefine = changed.some((k) => REFINE_KEYS.has(k));
    if (changed.length) {
      let expr = sql`${schema.projects.settings}`;
      for (const k of clear) expr = sql`(${expr}) - ${k}::text`;
      const write = Object.fromEntries(Object.keys(patch).map((k) => [k, merged[k as keyof ProjectSettings]]));
      await u.db
        .update(schema.projects)
        .set({
          ...(titleChanged ? { title } : {}),
          ...(metadataChanged ? { metadata: input.metadata } : {}),
          settings: settingsWrite(expr, write),
          updatedAt: new Date(),
        })
        .where(eq(schema.projects.id, p.id));
      await u.emit("project.updated", { projectId: p.id, changed });
    }
    const followUps = [
      needsReanalyze && "reanalyze_project picks clips with the new selection settings",
      needsRefine && "refine_project (or Retry) applies the new refine toggles on the existing transcript",
      needsRerender && "rerender_clips applies the style/framing to finished clips",
    ].filter(Boolean);
    return {
      ok: true,
      changed,
      needsReanalyze,
      needsRefine,
      needsRerender,
      ...(followUps.length ? { hint: `Saved; nothing was re-run. ${followUps.join("; ")}.` } : {}),
    };
  });
}

/** What `applyProjectFraming` takes from one section of a clip: its mode and what the user adjusted on it. */
export interface FramingTemplate {
  reframe: SectionMode;
  adjust?: SectionAdjustFields | undefined;
}

/**
 * The framing of a clip's section (the one at `at` seconds into the source, else the first section that is not plain
 * automatic, else the first), as a template for the whole project.
 */
export function framingOfClip(
  clip: { startSec: number; layoutSections: LayoutSection[] | null; layoutOverride?: string | null },
  at?: number,
): FramingTemplate {
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
export async function applyProjectFraming(
  svc: Services,
  actor: Actor,
  projectId: string,
  input: FramingTemplate & { keepOverrides?: boolean | undefined; rerender?: boolean },
) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    const adjust = input.adjust ? adjustOf(input.adjust) : undefined;
    await lockProjectClips(u, p.id);
    let cleared = 0;
    if (!input.keepOverrides) {
      const rows = await u.db
        .update(schema.clips)
        .set({ layoutSections: null, layoutOverride: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.clips.projectId, p.id),
            isNull(schema.clips.deletedAt),
            sql`(${schema.clips.layoutSections} is not null or ${schema.clips.layoutOverride} is not null)`,
          ),
        )
        .returning({ id: schema.clips.id });
      cleared = rows.length;
    }
    let rerendered = 0;
    if (input.rerender !== false) {
      for (const c of await listClips(u.db, p.id))
        if ((c.status === "done" || c.status === "failed") && (await requestRender(svc, u, p.id, c.id)) !== null) rerendered++;
    }
    const write = { reframe: input.reframe, reframeAdjust: adjust ?? null };
    await u.db
      .update(schema.projects)
      .set({ settings: sql`${schema.projects.settings} || ${JSON.stringify(write)}::jsonb`, updatedAt: new Date() })
      .where(eq(schema.projects.id, p.id));
    await u.emit("project.updated", { projectId: p.id, changed: ["reframe", "reframeAdjust"], framingCleared: cleared });
    u.afterCommit(() =>
      svc.log.child({ module: "projects", projectId: p.id }).info({ reframe: input.reframe, adjust, cleared, rerendered }, "framing applied to the project"),
    );
    return { ok: true, reframe: input.reframe, adjust: adjust ?? null, cleared, rerendered };
  });
}

/**
 * The project as `actor` may see it. `deleted: false` = only a live project; `true` = live or deleted (restore).
 * NOT_FOUND for someone else's project unless the actor is an admin or the operator.
 */
export async function findProject(db: Db, actor: Actor, projectId: string, o: { deleted: boolean }) {
  const mine = actor && !actor.admin ? eq(schema.projects.userId, actor.id) : undefined;
  const p = await db.query.projects.findFirst({
    where: and(eq(schema.projects.id, projectId), mine, o.deleted ? undefined : isNull(schema.projects.deletedAt)),
  });
  if (p) return p;
  if (o.deleted)
    throw new AppError(
      "NOT_FOUND",
      msg({
        id: "project.not_found_gone",
        message: "No project with that id in your account. A deleted project is gone for good once its restore window has passed.",
      }),
    );
  // only on the failure path: tell "deleted" from "never yours / never existed"
  const inDeleted = await db.query.projects.findFirst({
    where: and(eq(schema.projects.id, projectId), mine, isNotNull(schema.projects.deletedAt)),
    columns: { id: true },
  });
  throw new AppError(
    "NOT_FOUND",
    inDeleted ? msg({ id: "project.in_deleted", message: "That project is deleted; restore_project (or Deleted in the app) brings it back." }) : noProject(),
  );
}
/** The sentence for a project id that is not the caller's or never existed. */
export const noProject = () => msg({ id: "project.not_found", message: "No project with that id in your account." });
/** The same for a clip; deleted clips are listed under Deleted. */
export const noClip = () =>
  msg({ id: "clip.not_found", message: "No clip with that id in your account (deleted clips are under Deleted; restore_clip brings one back)." });
const clipGone = (svc: Services) =>
  msg({ id: "clip.gone", message: msg`No such clip. Deleted items can be restored ${{ restorable: restorableFor(svc) }}; after that they are gone for good.` });

/** "Deleted forever." with the space it freed, when it held any. */
const deletedForever = (stored: number) => (stored ? t(msg`Deleted forever. ${{ size: formatBytes(stored) }} is free now.`) : t(msg`Deleted forever.`));

// ── purge ──────────────────────────────────────────────────────────────────

/**
 * Remove a project for good in the caller's unit of work: jobs cancelled, the row (and its clips, transcript)
 * deleted, files after commit. Its events and decisions outlive it (what Reelsaw learned from it), and go too
 * when `forgetDecisions` or the project was deleted with that choice; returns how many decisions were forgotten.
 */
export async function purgeProject(
  svc: Services,
  u: UnitOfWork,
  projectId: string,
  opts: { forgetDecisions?: boolean } = {},
): Promise<{ forgottenDecisions: number }> {
  for (const c of await u.db.select({ id: schema.clips.id }).from(schema.clips).where(eq(schema.clips.projectId, projectId))) {
    await u.cancelLiveJobs(QUEUES.render, c.id);
    await u.cancelLiveJobs(QUEUES.prepare, c.id);
  }
  for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, projectId);
  const [gone] = await u.db
    .delete(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .returning({ sourceMeta: schema.projects.sourceMeta, userId: schema.projects.userId, forget: schema.projects.forgetDecisionsOnPurge });
  await releaseUpload(svc, u, projectId, gone?.sourceMeta?.["uploadId"]);
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
          const [p] = await u.db
            .select({ id: schema.projects.id })
            .from(schema.projects)
            .where(and(eq(schema.projects.id, r.id), isNotNull(schema.projects.deletedAt), sql`${schema.projects.deletedAt} < ${cutoff}::timestamptz`))
            .for("update");
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
export async function rerenderProjectClips(
  svc: Services,
  u: UnitOfWork,
  projectId: string,
  which: (c: typeof schema.clips.$inferSelect) => boolean = (c) => c.status === "done" || c.status === "failed",
) {
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
/** What creating a project with ranges planned: the billed seconds and what the planner changed (merges, clamps). */
interface CreatedRanges {
  billedSec: number;
  changes: RangeChange[];
}

/**
 * Start a project. With `ranges` (docs/specs/range-clipping.md) only those parts are processed: they are planned
 * (`planRanges`: checked, clamped to the announced length, merged, priced) and admitted whole against the minutes, or
 * refused with the upgrade offer; ingest settles them again on the file. `rangeOrigin` says who chose them: a person
 * (the web timeline) or a caller (MCP, API, CLI).
 */
export async function createProject(
  svc: Services,
  userId: string,
  input: CreateProjectInput,
  o: { rangeOrigin?: "user" | "api" } = {},
): Promise<typeof schema.projects.$inferSelect & { ranges?: CreatedRanges }> {
  const db = svc.database.db;
  const log = svc.log.child({ module: "projects", userId });
  if (!input.sourceUrl && !input.uploadId)
    throw new AppError("BAD_REQUEST", msg({ id: "project.source_required", message: "Give a sourceUrl (a link to the video) or an uploadId." }));
  const quotaReached = (err: unknown): never => {
    log.warn({ reason: err instanceof Error ? err.message : String(err) }, "project quota reached");
    throw err;
  };
  // early refusal before the URL peek; the binding check runs again, locked, in the transaction that inserts
  await checkProjectQuota(db, svc.settings.get(), userId, { ent: svc.entitlements }).catch(quotaReached);
  let sourceMeta: (typeof schema.projects.$inferSelect)["sourceMeta"] = null;
  let title = input.title?.trim() || "";
  /** the length the site announced; null for a file (ingest settles ranges on it) or a site that does not say */
  let announcedSec: number | null = null;
  /** ranges from the video's Most replayed peaks (`rangesFrom`), added to the caller's */
  let peakRanges: SourceRangeInput[] = [];
  if (input.rangesFrom && !input.sourceUrl)
    throw new AppError("BAD_REQUEST", msg({ id: "ranges.most_replayed_upload", message: "Most replayed needs a link to the video, not an upload." }));
  if (input.uploadId) {
    const up = await db.query.uploads.findFirst({ where: and(eq(schema.uploads.id, input.uploadId), eq(schema.uploads.userId, userId)) });
    if (!up) throw new AppError("NOT_FOUND", msg({ id: "upload.not_in_account", message: "No upload with that id in your account." }));
    sourceMeta = { uploadId: up.id, filename: up.filename };
    title ||= up.filename.replace(/\.[^.]+$/, "");
  } else if (input.sourceUrl) {
    const [peek, announced] = await Promise.all([
      peekUrlMeta(input.sourceUrl),
      // ranges are planned against the video's length, so it is looked up for them whatever the account's limits
      (input.ranges || input.rangesFrom ? announcedLengthFor(svc, input.sourceUrl, log) : announcedMinutesFor(svc, userId, input.sourceUrl, log)).catch(
        (err: unknown) => {
          if (err instanceof LiveSourceError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
          throw err;
        },
      ),
    ]);
    announcedSec = announced;
    if (input.rangesFrom?.mostReplayed) {
      const heat = await announcedHeatmapFor(svc, input.sourceUrl);
      const peaks = replayPeaks(heat, { top: input.rangesFrom.mostReplayed });
      if (!peaks.length)
        throw new AppError(
          "BAD_REQUEST",
          msg({
            id: "ranges.no_heatmap",
            message: "This video has no Most replayed heatmap (new or small videos, and most sites other than YouTube, have none). Give ranges instead.",
          }),
        );
      peakRanges = peaks.map((p, i) => ({ startSec: p.startSec, endSec: p.endSec, mode: "clip" as const, label: `Most replayed #${i + 1}` }));
    }
    // a video the account's minutes cannot cover is refused here, with the upgrade offer, not created and failed by ingest
    // (ranges are admitted whole below instead, once the project's settings say how long a clip may be)
    if (announced && !input.ranges && !input.rangesFrom)
      await checkAnnouncedMinutes(db, svc.settings.get(), userId, announced, svc.config.TRANSCRIBE_CHUNK_SECONDS, svc.entitlements).catch(quotaReached);
    sourceMeta = { ...(peek.thumbnail ? { thumbnail: peek.thumbnail } : {}), ...(peek.uploader ? { uploader: peek.uploader } : {}) };
    title ||= peek.title ?? "";
  }
  title ||= "Untitled";
  const id = randomUUID();
  return svc.tx(async (u) => {
    // counted under a per-user lock in the inserting transaction, so concurrent creates can't overshoot the cap
    await checkProjectQuota(u.db, svc.settings.get(), userId, { lock: true, ent: svc.entitlements }).catch(quotaReached);
    // defaults, caller values and the intro/outro ownership + liveness check see one snapshot
    const settings = await resolveProjectSettings(u.db, userId, input.settings, input.clear);
    if (settings.minClipSeconds >= settings.maxClipSeconds)
      throw new AppError("BAD_REQUEST", msg({ id: "project.min_below_max", message: "minClipSeconds must be below maxClipSeconds" }));
    const given = input.ranges ?? [];
    const asked = [...given, ...peakRanges];
    const plan = asked.length ? planRanges(asked, { durationSec: announcedSec, maxClipSec: settings.maxClipSeconds }) : null;
    if (plan && !plan.ok) throw rangesRefused(plan.problems);
    // advisory, like the whole video's check above: ingest admits the ranges again, bound, under the quota lock
    if (plan) await admitRanges(u.db, svc.settings.get(), userId, null, plan.billedSec, svc.entitlements).catch(quotaReached);
    const [row] = await u.db
      .insert(schema.projects)
      .values({
        id,
        userId,
        title,
        sourceType: input.uploadId ? "upload" : "url",
        sourceUrl: input.sourceUrl ?? null,
        sourceMeta,
        settings,
        status: "queued",
        metadata: input.metadata ?? {},
      })
      .returning();
    if (!row) throw new Error("the project row was not returned");
    await recordProjectCreated(u.db, userId, id, row.createdAt);
    if (plan?.ok && plan.ranges.length)
      await u.db.insert(schema.projectRanges).values(
        plan.ranges.map((r) => ({
          id: randomUUID(),
          projectId: id,
          startSec: r.startSec,
          endSec: r.endSec,
          mode: r.mode,
          // a range merged from a Most replayed peak and one of the caller's is the caller's
          origin: r.inputs.every((i) => i >= given.length) ? ("most_replayed" as const) : (o.rangeOrigin ?? "api"),
          label: r.label ?? null,
          ref: r.ref ?? null,
          billedSec: r.billedSec,
        })),
      );
    await syncProjectRefs(u.db, row); // the defaults' intro/outro
    await u.emit("project.created", { projectId: id, title, sourceType: row.sourceType });
    await startRun(u, id, { reason: "created", status: "queued" });
    await u.enqueue(QUEUES.ingest, { projectId: id });
    if (plan?.ok)
      // the funnel: how many ranges, from where, and how much of the video they cover (no per-user detail)
      svc.telemetry.capture("project.ranges", userId, {
        projectId: id,
        ranges: plan.ranges.length,
        billedMinutes: Math.round(plan.billedSec / 60),
        share: announcedSec ? Math.round((plan.billedSec / announcedSec) * 100) / 100 : null,
        mostReplayed: peakRanges.length,
        surface: o.rangeOrigin ?? "api",
      });
    return plan?.ok ? { ...row, ranges: { billedSec: plan.billedSec, changes: plan.changes } } : row;
  });
}

/**
 * The length a link announces, in seconds, looked up only when the account has a minutes limit (no lookup, no wait, for
 * everyone else). Null when the site does not say, the link is not a public address, or the lookup is slow or fails:
 * ingest checks again before downloading and on the file itself. Throws `LiveSourceError` for a live or scheduled stream.
 */
async function announcedMinutesFor(svc: Services, userId: string, url: string, log: Services["log"]): Promise<number | null> {
  if (!(await hasMinuteLimits(svc.database.db, svc.settings.get(), userId, svc.entitlements))) return null;
  return announcedLengthFor(svc, url, log);
}

/** The length a link announces, looked up whatever the account's limits (ranges are planned against it); as above. */
/**
 * A link's replay heatmap (Most replayed), behind the same public-address check as its length: an internal or
 * private address is never looked up, and anything that fails reads as no heatmap.
 */
async function announcedHeatmapFor(svc: Services, url: string): Promise<HeatBin[]> {
  try {
    await assertPublicHttpUrl(url, { allowPrivate: svc.settings.get().ALLOW_PRIVATE_SOURCE_URLS });
    return await announcedHeatmap(svc.media, url, AbortSignal.timeout(ANNOUNCED_LOOKUP_MS));
  } catch {
    return [];
  }
}

async function announcedLengthFor(svc: Services, url: string, log: Services["log"]): Promise<number | null> {
  try {
    await assertPublicHttpUrl(url, { allowPrivate: svc.settings.get().ALLOW_PRIVATE_SOURCE_URLS });
    return await announcedDuration(svc.media, url, AbortSignal.timeout(ANNOUNCED_LOOKUP_MS));
  } catch (err) {
    if (err instanceof LiveSourceError) throw err;
    log.debug({ err }, "could not look up the video's length before creating the project");
    return null;
  }
}
/** How long creating a project from a link may wait for the site to say how long the video is. */
const ANNOUNCED_LOOKUP_MS = 12_000;

export const checkSourceInput = z
  .object({
    sourceUrl: z.url().optional().describe("Link to the video you are about to add; its length is looked up without downloading it"),
    durationSec: z.number().positive().max(86_400).optional().describe("Length of a file you are about to upload, in seconds (instead of sourceUrl)"),
    ranges: z
      .array(rangeSchema)
      .min(1)
      .max(MAX_RANGES)
      .optional()
      .describe("The parts you would clip (as create_project takes them): priced and checked against your minutes instead of the whole video"),
    lookupLength: z
      .boolean()
      .optional()
      .describe("Look the link's length up even without a minutes limit (the range timeline needs it); durationSec in the answer"),
  })
  .refine((v) => !!v.sourceUrl !== (v.durationSec !== undefined), { message: "Give sourceUrl or durationSec, not both" });

/** A video that will be processed only from its start (see `PartialSource`): what is processed now and how to get the rest. */
export interface SourcePartial {
  /** minutes processed from the start */
  minutes: number;
  /** the whole video, in minutes */
  totalMinutes: number;
  /** the first-video allowance covers the start (else the minutes left this period) */
  firstVideo: boolean;
  /** what the New project form says, above the button that creates it */
  sentence: string;
  /** the plan that covers the whole video, when there is one */
  upgrade: { label: string; href: string } | null;
}

export interface SourceCheck {
  /** the video's length in minutes, when it is known (a link whose site does not say has none) */
  minutes: number | null;
  /** the same length in seconds (the range timeline is drawn from it) */
  durationSec: number | null;
  /** the video's Most replayed peaks, hottest first, when the length was looked up for ranges and the site has them */
  mostReplayed: ReplayPeak[];
  /** the video is accepted, but only its start is processed now; null when all of it is (or it is refused) */
  partial: SourcePartial | null;
  /** false: creating the project now would be refused (message and quota say why and what to do; no quota for a live stream); null: the length is unknown, so ingest decides */
  fits: boolean | null;
  message: string | null;
  quota: QuotaRefusal | null;
  /** the monthly minutes this account has, when a minutes limit applies */
  allowance: MinutesAllowance | null;
  /**
   * With `ranges`: what they cost and what the planner changed; `fits` and `message` are then about the ranges (no
   * partial: ranges are admitted whole or refused). `problems`: ranges that cannot be ranges (each in a sentence).
   */
  ranges: { seconds: number; minutes: number; changes: RangeChange[]; problems: string[] } | null;
}

/**
 * Would a project from this link (or a file of this length) be accepted right now? The same checks `createProject` and
 * ingest run (project count, storage, minutes), answered before anything is created or uploaded, with the refusal's
 * sentence and upgrade offer when it would not. Nothing is reserved: the binding check still runs at creation and ingest.
 * tRPC `projects.checkSource`, the MCP check_source tool and `reelsaw check-source` call this. A predicted refusal is a
 * `quota.warned` product event, with the same properties as the `quota.refused` it heads off.
 */
export async function checkSource(svc: Services, userId: string, input: z.infer<typeof checkSourceInput>, surface: string): Promise<SourceCheck> {
  const db = svc.database.db;
  const s = svc.settings.get();
  const log = svc.log.child({ module: "projects", userId });
  const [allowance, durationSec] = await Promise.all([
    minutesAllowance(db, s, userId, svc.entitlements),
    input.durationSec ??
      (input.sourceUrl
        ? (input.ranges || input.lookupLength ? announcedLengthFor(svc, input.sourceUrl, log) : announcedMinutesFor(svc, userId, input.sourceUrl, log)).catch(
            (err: unknown) => {
              if (err instanceof LiveSourceError) return "live" as const;
              throw err;
            },
          )
        : null),
  ]);
  if (durationSec === "live")
    return {
      minutes: null,
      durationSec: null,
      mostReplayed: [],
      partial: null,
      fits: false,
      message: LIVE_SOURCE_MESSAGE,
      quota: null,
      allowance,
      ranges: null,
    };
  const minutes = durationSec ? Math.round((durationSec / 60) * 10) / 10 : null;
  const lengthSec = durationSec || null;
  // the peaks come with the length lookup (the same yt-dlp answer, remembered): only when it ran for ranges
  const mostReplayed = input.sourceUrl && (input.ranges || input.lookupLength) ? replayPeaks(await announcedHeatmapFor(svc, input.sourceUrl)) : [];
  const refused = (err: QuotaError): SourceCheck => {
    svc.telemetry.capture("quota.warned", userId, refusalEvent(err.limit, surface, err.quota, err.props));
    return {
      minutes,
      durationSec: lengthSec,
      mostReplayed,
      partial: null,
      fits: false,
      message: err.message,
      quota: err.quota ?? null,
      allowance,
      ranges: null,
    };
  };
  try {
    await checkProjectQuota(db, s, userId, { ent: svc.entitlements });
  } catch (err) {
    if (err instanceof QuotaError) return refused(err);
    throw err;
  }
  if (input.ranges) {
    // priced the way createProject plans them: the account's default longest clip, the length when it is known
    const settings = await resolveProjectSettings(db, userId, undefined, undefined);
    const plan = planRanges(input.ranges, { durationSec: durationSec || null, maxClipSec: settings.maxClipSeconds });
    if (!plan.ok) {
      const problems = rangeProblemsText(plan.problems);
      return {
        minutes,
        durationSec: lengthSec,
        mostReplayed,
        partial: null,
        fits: false,
        message: problems.join(" "),
        quota: null,
        allowance,
        ranges: { seconds: 0, minutes: 0, changes: [], problems },
      };
    }
    const priced = { seconds: plan.billedSec, minutes: Math.round((plan.billedSec / 60) * 10) / 10, changes: plan.changes, problems: [] };
    try {
      await admitRanges(db, s, userId, null, plan.billedSec, svc.entitlements);
    } catch (err) {
      if (err instanceof QuotaError) return { ...refused(err), ranges: priced };
      throw err;
    }
    return { minutes, durationSec: lengthSec, mostReplayed, partial: null, fits: true, message: null, quota: null, allowance, ranges: priced };
  }
  if (!durationSec) return { minutes, durationSec: lengthSec, mostReplayed, partial: null, fits: null, message: null, quota: null, allowance, ranges: null };
  const r = await predictAdmission(db, s, userId, durationSec, svc.config.TRANSCRIBE_CHUNK_SECONDS, svc.entitlements);
  if ("refused" in r) return refused(r.refused);
  const until = r.admission.until;
  if (until === null) return { minutes, durationSec: lengthSec, mostReplayed, partial: null, fits: true, message: null, quota: null, allowance, ranges: null };
  const offer = await minutesOffer(db, s, userId, svc.entitlements, r.admission.binding);
  const upgrade = offer.refusal.primary?.kind === "upgrade" ? { label: offer.refusal.primary.label, href: offer.refusal.primary.href } : null;
  const partial: SourcePartial = {
    minutes: Math.round(until / 60),
    totalMinutes: Math.round(durationSec / 60),
    firstVideo: r.admission.firstVideo,
    sentence: partialPrecheckSentence(
      until,
      durationSec,
      r.admission.firstVideo ? "first_video" : r.admission.binding === "MAX_SOURCE_MINUTES_PER_DAY" ? "day" : "month",
      !!upgrade,
    ),
    upgrade,
  };
  // the same moment a refusal used to warn at: whoever pastes a long video, and what they are offered instead
  svc.telemetry.capture("quota.partial_offered", userId, {
    surface,
    firstVideo: partial.firstVideo,
    minutes: partial.minutes,
    totalMinutes: partial.totalMinutes,
  });
  return { minutes, durationSec: lengthSec, mostReplayed, partial, fits: true, message: null, quota: null, allowance, ranges: null };
}

/**
 * What New project says about a video only the start of which the minutes cover. `untilSec` is whole transcription
 * chunks, a little under the minutes left, so the sentence says what is clipped and which allowance set it (the first
 * video's, today's or this period's minutes), never a "minutes left" number it would get wrong.
 */
export function partialPrecheckSentence(untilSec: number, durationSec: number, why: "first_video" | "day" | "month", canUpgrade: boolean): string {
  const now = Math.round(untilSec / 60);
  const total = Math.round(durationSec / 60);
  const first = t(
    msg`This video is ${icuPlural({ total }, { one: "# minute", other: "# minutes" })}. Reelsaw clips the first ${icuPlural({ now }, { one: "# minute", other: "# minutes" })} now, ${icuSelect({ why }, { first_video: "free as your first video", day: "as far as today's minutes go", other: "as far as this period's minutes go" })}.`,
  );
  const rest = canUpgrade
    ? t(msg`Upgrade any time to clip the rest; Reelsaw picks up where it stopped.`)
    : t(msg`Reelsaw clips the rest when your minutes reset.`);
  return `${first} ${rest}`;
}

/**
 * A partly processed video's state for its screen, `get_project` and `reelsaw project`: what was processed, what is left,
 * what "Clip the rest" would process now and the plan that covers the rest when the minutes do not. Null for a project
 * that covers its whole video.
 */
export async function partialSourceOf(
  svc: Services,
  p: Pick<typeof schema.projects.$inferSelect, "id" | "userId" | "durationSec" | "sourceLimitSec" | "extendFromSec" | "status" | "runReason">,
): Promise<PartialSource | null> {
  if (p.sourceLimitSec === null || p.durationSec === null) return null;
  const processedSec = processedEndSec(p) ?? 0;
  // to the tenth of a second: a float difference (601.4 - 540) would show as 61.39999999999998 on every surface
  const remainingSec = Math.max(0, Math.round((p.durationSec - processedSec) * 10) / 10);
  const db = svc.database.db;
  const s = svc.settings.get();
  // from the state, not the run's reason (a retry or re-pick of an extension has another): the rest's words are not in
  // yet, or its picks are not made yet, while the project works
  const [tr] = await db.select({ covered: schema.transcripts.covered }).from(schema.transcripts).where(eq(schema.transcripts.projectId, p.id));
  const extending =
    (WORKING as readonly string[]).includes(p.status) &&
    (p.runReason === "extend" || p.extendFromSec !== null || (!!tr && !spansCover(coverageOf(tr.covered), await projectNeededSpans(db, p))));
  const room = await minutesRoomSec(db, s, p.userId, { extension: true, ent: svc.entitlements });
  const plan = partialUntil(p.durationSec, processedSec, room.sec, svc.config.TRANSCRIBE_CHUNK_SECONDS);
  const extendableSec = plan === "none" ? null : (plan.until ?? p.durationSec) - processedSec;
  const covered = extendableSec !== null && extendableSec >= remainingSec - 0.5;
  const offer = covered ? null : await minutesOffer(db, s, p.userId, svc.entitlements, room.binding);
  const primary = offer?.refusal.primary;
  const upgrade = primary?.kind === "upgrade" ? { label: primary.label, href: primary.href } : null;
  const m = (sec: number) => Math.round(sec / 60);
  const processed = m(processedSec);
  const total = m(p.durationSec);
  const remaining = m(remainingSec);
  const head = t(msg`Reelsaw clipped the first ${{ processed }} of ${icuPlural({ total }, { one: "# minute", other: "# minutes" })}.`);
  const tail = (): string => {
    if (covered) return t(msg`Clip the remaining ${icuPlural({ remaining }, { one: "# minute", other: "# minutes" })} now.`);
    if (extendableSec !== null) {
      const more = m(extendableSec);
      return upgrade
        ? t(msg`Your minutes cover ${{ more }} more now; upgrade to clip all ${{ remaining }}.`)
        : t(msg`Your minutes cover ${{ more }} more now.`);
    }
    if (upgrade) return t(msg`Upgrade to clip the remaining ${icuPlural({ remaining }, { one: "# minute", other: "# minutes" })}.`);
    if (offer!.key === "MAX_SOURCE_MINUTES_PER_DAY")
      return t(
        msg`The remaining ${icuPlural({ remaining }, { one: "# minute", other: "# minutes" })} can be clipped when your minutes reset at ${{ time: offer!.resetsOn.toISOString().slice(11, 16) }} UTC.`,
      );
    return t(
      msg`The remaining ${icuPlural({ remaining }, { one: "# minute", other: "# minutes" })} can be clipped when your minutes reset on ${{ day: formatDay(offer!.resetsOn, { year: false, utc: true }) }}.`,
    );
  };
  const sentence = extending ? t(msg`Clipping more of the video, up to minute ${{ processed }} of ${{ total }}.`) : `${head} ${tail()}`;
  return { processedSec, durationSec: p.durationSec, remainingSec, extending, extendableSec, upgrade, sentence };
}

export interface ExtendResult {
  /** the second the new part starts at */
  fromSec: number;
  /** where processing now ends (the whole video when `whole`) */
  untilSec: number;
  durationSec: number;
  /** the rest of the video is covered: nothing will be left after this run */
  whole: boolean;
  /** ranges added (extendProject with ranges): what they count and what the planner changed */
  ranges?: CreatedRanges;
}

/**
 * Process more of a partly processed video: as much of the rest as the account's minutes cover now (all of it, or
 * whole transcription chunks of it), refused with the upgrade offer when not even one chunk fits. Picks up where it
 * stopped: the transcript gets the new words appended (fixes and decisions on the old part stay), refine runs again
 * (carrying decisions over), and analyze picks moments only in the new part around every clip that exists (or the
 * whole video, when no moments were picked yet). The extension's minutes are a ledger row dated now.
 * The project may be idle or rendering (its renders go on); a project still in its first run is restarted from
 * transcription with the new limit. tRPC `projects.extend`, MCP `extend_project`, `reelsaw extend-project` and the
 * handler that follows an upgrade for the project it started from (after-upgrade.ts `finishPartialWork`) call this.
 */
export async function extendProject(
  svc: Services,
  actor: Actor,
  projectId: string,
  o: { automatic?: boolean; ranges?: SourceRangeInput[] | undefined; rangeOrigin?: "user" | "api" } = {},
): Promise<ExtendResult> {
  if (o.ranges?.length) return addRanges(svc, actor, projectId, o.ranges, o.rangeOrigin ?? "api");
  const chunkSec = svc.config.TRANSCRIBE_CHUNK_SECONDS;
  const result = await svc.tx(async (u) => {
    const owner = await findProject(u.db, actor, projectId, { deleted: false });
    // advisory locks first (the account's minutes, then this project's retries), then transcript → clips → project
    await takeTxLock(u.db, txLock.quota(owner.userId));
    await takeTxLock(u.db, txLock.retry(owner.id));
    await u.db.select({ id: schema.transcripts.projectId }).from(schema.transcripts).where(eq(schema.transcripts.projectId, owner.id)).for("update");
    await lockProjectClips(u, owner.id);
    const [p] = await u.db
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.id, owner.id), isNull(schema.projects.deletedAt)))
      .for("no key update");
    if (!p) throw new AppError("NOT_FOUND", msg({ id: "project.missing", message: "Project not found" }));
    if (p.sourceLimitSec === null || p.durationSec === null) {
      const [chosen] = await u.db
        .select({ id: schema.projectRanges.id })
        .from(schema.projectRanges)
        .where(and(eq(schema.projectRanges.projectId, p.id), ne(schema.projectRanges.origin, "whole")))
        .limit(1);
      throw new AppError(
        "BAD_REQUEST",
        chosen
          ? msg({ id: "project.clips_ranges", message: "This project clips ranges of its video: give the ranges to clip next." })
          : msg({ id: "project.already_whole", message: "This project already covers the whole video." }),
      );
    }
    const fromSec = Math.min(p.durationSec, p.sourceLimitSec);
    const room = await minutesRoomSec(u.db, svc.settings.get(), p.userId, { extension: true, ent: svc.entitlements });
    const plan = partialUntil(p.durationSec, fromSec, room.sec, chunkSec);
    if (plan === "none")
      throw await extensionRefusal(u.db, svc.settings.get(), p.userId, p.durationSec - fromSec, room.sec ?? 0, svc.entitlements, room.binding);
    const untilSec = plan.until ?? p.durationSec;
    await recordSourceExtension(u.db, p.userId, p.id, untilSec - fromSec);
    // the part added is a range of its own (docs/specs/range-clipping.md), picked from by the run this starts
    await u.db
      .insert(schema.projectRanges)
      .values({ id: randomUUID(), projectId: p.id, startSec: fromSec, endSec: untilSec, mode: "find", origin: "whole", billedSec: untilSec - fromSec });
    // moments picked before (even ones deleted since) mean the old part is done: the new picks go only in the new part.
    // None picked yet (the first run had not got that far): the whole processed video is picked from.
    const [picked] = await u.db
      .select({ id: schema.clips.id })
      .from(schema.clips)
      .where(and(eq(schema.clips.projectId, p.id), eq(schema.clips.origin, "ai")))
      .limit(1);
    const extendFromSec = picked ? Math.min(p.extendFromSec ?? fromSec, fromSec) : null;
    for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, p.id);
    await supersedeStages(u, p.id); // a stage still running for the old limit commits nothing
    await startRun(u, p.id, {
      reason: "extend",
      status: "queued",
      stage: "transcribe",
      set: { sourceLimitSec: plan.until, extendFromSec },
      continueActive: true,
    });
    await u.emit("project.extended", { projectId: p.id, fromSec, untilSec, durationSec: p.durationSec, ...(o.automatic ? { automatic: true } : {}) });
    // a source retention removed is fetched again first; ingest keeps what the video was admitted as and hands on
    await u.enqueue(p.sourceExpiredAt || !p.sourceKey ? QUEUES.ingest : QUEUES.transcribe, { projectId: p.id });
    const r: ExtendResult & { userId: string } = { fromSec, untilSec, durationSec: p.durationSec, whole: plan.until === null, userId: p.userId };
    return r;
  });
  svc.log
    .child({ module: "projects", projectId })
    .info({ fromSec: result.fromSec, untilSec: result.untilSec, whole: result.whole, automatic: !!o.automatic }, "processing more of a partly processed video");
  svc.telemetry.capture("project.extended", result.userId, {
    projectId,
    automatic: !!o.automatic,
    addedMinutes: Math.round((result.untilSec - result.fromSec) / 60),
    whole: result.whole,
  });
  const { userId: _u, ...out } = result;
  return out;
}

/**
 * Clip more of a project by ranges (docs/specs/range-clipping.md): only time no range of the project covers yet is
 * fetched, transcribed and counted; the ranges are admitted whole or refused with the upgrade offer, never cut short.
 * Picks up where the project stands: its clips, fixes and decisions stay, and new clips are picked only in the new
 * ranges (around every clip there). The project may be idle or rendering; one still in its first run is restarted from
 * transcription with the new ranges. tRPC `projects.extend`, MCP `extend_project` and `reelsaw extend-project --range`.
 */
async function addRanges(svc: Services, actor: Actor, projectId: string, input: SourceRangeInput[], origin: "user" | "api"): Promise<ExtendResult> {
  const result = await svc.tx(async (u) => {
    const owner = await findProject(u.db, actor, projectId, { deleted: false });
    // advisory locks first (the account's minutes, then this project's retries), then transcript → clips → project
    await takeTxLock(u.db, txLock.quota(owner.userId));
    await takeTxLock(u.db, txLock.retry(owner.id));
    await u.db.select({ id: schema.transcripts.projectId }).from(schema.transcripts).where(eq(schema.transcripts.projectId, owner.id)).for("update");
    await lockProjectClips(u, owner.id);
    const [p] = await u.db
      .select()
      .from(schema.projects)
      .where(and(eq(schema.projects.id, owner.id), isNull(schema.projects.deletedAt)))
      .for("no key update");
    if (!p) throw new AppError("NOT_FOUND", msg({ id: "project.missing", message: "Project not found" }));
    if (p.durationSec === null)
      throw new AppError(
        "CONFLICT",
        msg({ id: "ranges.length_unknown", message: "Reelsaw does not know this video's length yet. Add ranges once it is downloaded." }),
      );
    const existing = await u.db.select().from(schema.projectRanges).where(eq(schema.projectRanges.projectId, p.id)).for("update");
    const plan = planRanges(input, {
      durationSec: p.durationSec,
      maxClipSec: p.settings.maxClipSeconds,
      processed: existing.map((r): [number, number] => [r.startSec, r.endSec]),
    });
    if (!plan.ok) throw rangesRefused(plan.problems);
    if (plan.billedSec <= 0) throw new AppError("BAD_REQUEST", msg({ id: "ranges.already_clipped", message: "Those ranges were clipped already." }));
    // counted against every project's minutes, this one's too: only the new time is billed
    await admitRanges(u.db, svc.settings.get(), p.userId, null, plan.billedSec, svc.entitlements);
    await recordSourceExtension(u.db, p.userId, p.id, plan.billedSec);
    await u.db.insert(schema.projectRanges).values(
      plan.ranges
        .filter((r) => r.billedSec > 0)
        .map((r) => ({
          id: randomUUID(),
          projectId: p.id,
          startSec: r.startSec,
          endSec: r.endSec,
          mode: r.mode,
          origin,
          label: r.label ?? null,
          ref: r.ref ?? null,
          billedSec: r.billedSec,
        })),
    );
    // a sparse source (a link that downloaded only its ranges) holds none of the new time: download again first
    const held = (p.sourceMeta?.["sparse"] as { spans?: [number, number][] } | undefined)?.spans;
    const all = [...existing, ...plan.ranges.map((r) => ({ ...r, origin }))];
    const fetch = !!p.sourceExpiredAt || !p.sourceKey || (!!held && !spansCover(held, transcriptSpans(all, p.durationSec)));
    for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, p.id);
    await supersedeStages(u, p.id); // a stage still running for the old ranges commits nothing
    await startRun(u, p.id, { reason: "extend", status: "queued", stage: fetch ? "ingest" : "transcribe", continueActive: true });
    const fromSec = Math.min(...plan.ranges.map((r) => r.startSec));
    const untilSec = Math.max(...plan.ranges.map((r) => r.endSec));
    await u.emit("project.extended", { projectId: p.id, fromSec, untilSec, durationSec: p.durationSec });
    // ingest keeps what the video was admitted as and hands on to transcribe
    await u.enqueue(fetch ? QUEUES.ingest : QUEUES.transcribe, { projectId: p.id });
    return {
      fromSec,
      untilSec,
      durationSec: p.durationSec,
      whole: false,
      ranges: { billedSec: plan.billedSec, changes: plan.changes },
      userId: p.userId,
    };
  });
  svc.log.child({ module: "projects", projectId }).info({ billedSec: result.ranges.billedSec, ranges: input.length }, "ranges added to a project");
  svc.telemetry.capture("project.extended", result.userId, {
    projectId,
    automatic: false,
    addedMinutes: Math.round(result.ranges.billedSec / 60),
    whole: false,
    ranges: input.length,
  });
  const { userId: _u, ...out } = result;
  return out;
}

/** Resume a project from its furthest completed stage (the Retry button, retry_project, `reelsaw retry`). */
export async function retryOwnedProject(svc: Services, actor: Actor, projectId: string) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    const r = await retryProject(svc, u, p.id);
    if (!r)
      throw new AppError(
        "NOT_FOUND",
        msg({ id: "project.deleted_during_retry", message: "That project was deleted while it was being retried; restore_project brings it back." }),
      );
    return r;
  });
}

export const refineInput = {
  steps: z.array(z.enum(REFINE_STEPS)).optional().describe("Which refine steps to re-run; default all"),
  vocabulary: z.string().max(1000).optional().describe("Names and terms the transcript should spell this way; empty string clears it"),
};

/** Re-run some or all refine steps (names, disfluencies, scene cuts) on the existing transcript. */
export async function refineProject(
  svc: Services,
  actor: Actor,
  projectId: string,
  input: { steps?: ReadonlyArray<(typeof REFINE_STEPS)[number]> | undefined; vocabulary?: string | undefined },
) {
  const steps = input.steps?.length ? [...new Set(input.steps)] : [...REFINE_STEPS];
  await svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    // transcript first, then the project row (vocabulary, startRun)
    const [cur] = await u.db.select({ refine: schema.transcripts.refine }).from(schema.transcripts).where(eq(schema.transcripts.projectId, p.id)).for("update");
    if (!cur) throw new AppError("BAD_REQUEST", msg({ id: "project.no_transcript_yet", message: "Project has no transcript yet" }));
    // a refine already running restarts; anything else running (renders, picking) would have its status
    // overwritten and never finalize, so wait for it
    if (!["done", "failed", "refining"].includes(p.status))
      throw new AppError(
        "CONFLICT",
        msg({ id: "project.busy_refine_later", message: msg`The project is busy (${{ status: p.status }}); refine it when that finishes` }),
      );
    if (input.vocabulary !== undefined) {
      const vocabulary = input.vocabulary || undefined;
      const check = projectSettingsSchema.safeParse({ ...p.settings, vocabulary }); // validate the result; write only the key (atomic merge)
      if (!check.success) throw new TRPCError({ code: "BAD_REQUEST", message: check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      const settings = vocabulary
        ? sql`${schema.projects.settings} || ${JSON.stringify({ vocabulary })}::jsonb`
        : sql`${schema.projects.settings} - 'vocabulary'`;
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
    if (!started) throw new AppError("CONFLICT", msg({ id: "project.busy_refine", message: "The project is busy; wait for it to finish before refining." }));
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
    await u.db
      .update(schema.projects)
      .set({ settings: sql`${schema.projects.settings} || ${JSON.stringify({ sourceText })}::jsonb`, updatedAt: new Date() })
      .where(eq(schema.projects.id, p.id));
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
    for (const [slot, key, choice, secs] of [
      ["intro", "introAssetId", input.intro, input.introSec],
      ["outro", "outroAssetId", input.outro, input.outroSec],
    ] as const) {
      if (choice === undefined) continue;
      expr = sql`(${expr}) - ${key}::text - ${`${slot}Sec`}::text`;
      if (secs !== undefined && choice !== "none") patch[`${slot}Sec`] = secs;
      if (choice === "none") patch[key] = null;
      else if (choice === "default") {
        if (mine[key]) patch[key] = mine[key]!;
      } else {
        // a library asset of this user; the one the project already uses stays valid even if it was since removed
        const [asset] = await u.db
          .select({ id: schema.assets.id, deletedAt: schema.assets.deletedAt })
          .from(schema.assets)
          .where(and(eq(schema.assets.id, choice), assetVisibleTo(p.userId)));
        if (!asset || (asset.deletedAt && p.settings[key] !== choice))
          throw new AppError(
            "NOT_FOUND",
            slot === "intro"
              ? msg({ id: "library.intro_not_found", message: "That intro is not in your library" })
              : msg({ id: "library.outro_not_found", message: "That outro is not in your library" }),
          );
        patch[key] = choice;
      }
    }
    // clips first, the project row last (lock order clip → project)
    const n = input.rerender ? (await rerenderProjectClips(svc, u, p.id)).queued : 0;
    const [after] = await u.db
      .update(schema.projects)
      .set({ settings: sql`(${expr}) || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() })
      .where(eq(schema.projects.id, p.id))
      .returning({ id: schema.projects.id, settings: schema.projects.settings });
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
    await u.db
      .update(schema.projects)
      .set({ settings: settingsWrite(sql`${schema.projects.settings}`, patch), updatedAt: new Date() })
      .where(eq(schema.projects.id, p.id));
    return n;
  });
  return { ok: true as const, rerendered, skipped };
}
