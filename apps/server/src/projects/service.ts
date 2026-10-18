/**
 * Deleting is reversible. A deleted project, or a clip a re-analyze replaced, keeps its row and files with
 * `deleted_at` set: every read path leaves it out, its jobs are cancelled, and restore clears the mark. After
 * DELETED_RETENTION_DAYS the hourly purge (`purgeDeleted`, run with the storage sweep) removes the rows and only
 * then the files. tRPC (`projects.delete` / `restore` / `reanalyze`, `clips.restore`), the MCP tools and the CLI
 * all call these functions.
 */
import fs from "node:fs/promises";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { projectSettingsSchema, type ProjectSettingsPatch } from "@reelsaw/shared";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { QUEUES } from "../queue/boss.js";
import { keys } from "../storage/index.js";
import { releaseUpload } from "../storage/uploads.js";
import { removeScratchClip } from "../storage/sweep.js";
import { keepReason, listClips } from "../pipeline/analyze.js";
import { lockProjectClips, startRun } from "../pipeline/lifecycle.js";
import { runFacts } from "../pipeline/common.js";
import { deadlineIn, keysetLoop } from "../lib/batch.js";

const STAGE_QUEUES = [QUEUES.ingest, QUEUES.transcribe, QUEUES.refineEntities, QUEUES.refineDisfluency, QUEUES.refineScenes, QUEUES.analyze] as const;
const WORKING = ["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"] as const;
const IN_FLIGHT = ["preparing", "pending", "rendering"] as const;

/** Who is asking: the owner, an admin (any project), or the operator CLI (null). */
export type Actor = { id: string; admin: boolean } | null;

const days = (svc: Services) => svc.config.DELETED_RETENTION_DAYS;
/** "for 7 days" / "until you purge it", for messages and tool results. */
export const restorableFor = (svc: Services) => (days(svc) > 0 ? `for ${days(svc)} day${days(svc) === 1 ? "" : "s"}` : "until it is purged");

/**
 * Soft-delete a project in the caller's unit of work: mark it, cancel its jobs, stop work in progress (a working
 * project becomes failed with a plain reason, in-flight clips get a newer render generation so a render already
 * running discards its output), emit `project.deleted`. Files stay until the purge. Returns false if it was
 * already deleted.
 */
export async function deleteProject(svc: Services, u: UnitOfWork, projectId: string): Promise<boolean> {
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
  await u.db
    .update(schema.projects)
    .set({ deletedAt: new Date(), updatedAt: new Date(), ...(working ? { status: "failed" as const, error: stopped } : {}) })
    .where(eq(schema.projects.id, projectId));
  // the run it interrupted ends here, so its history reads as stopped rather than running forever
  if (facts) await u.emit(projectId, "project.failed", { stage: before.stage ?? "ingest", error: stopped, ...facts });
  await u.emit(projectId, "project.deleted", { days: days(svc), stopped: working });
  return true;
}

/** Owner-facing delete: ownership checked in the same unit of work as the write. */
export async function deleteOwnedProject(svc: Services, actor: Actor, projectId: string) {
  return svc.tx(async (u) => {
    await findProject(u.db, actor, projectId, { deleted: false });
    const changed = await deleteProject(svc, u, projectId);
    return { ok: true, changed, restorable: restorableFor(svc), message: `Deleted. It can be restored ${restorableFor(svc)}.` };
  });
}

/** Bring a deleted project back (owner or admin). A project that was working comes back failed: Retry resumes it. */
export async function restoreProject(svc: Services, actor: Actor, projectId: string) {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: true });
    if (!p.deletedAt) return { ok: true, changed: false, status: p.status };
    await u.db.update(schema.projects).set({ deletedAt: null, updatedAt: new Date() }).where(and(eq(schema.projects.id, projectId), isNotNull(schema.projects.deletedAt)));
    await u.emit(projectId, "project.restored", {});
    return { ok: true, changed: true, status: p.status };
  });
}

/** Bring back a clip a re-analyze replaced. It goes to the end of the project's list; a clip that never finished rendering needs a re-render. */
export async function restoreClip(svc: Services, actor: Actor, clipId: string) {
  return svc.tx(async (u) => {
    const [c] = await u.db.select().from(schema.clips).where(eq(schema.clips.id, clipId)).for("update");
    if (!c) throw new TRPCError({ code: "NOT_FOUND", message: gone(svc, "clip") });
    await findProject(u.db, actor, c.projectId, { deleted: false });
    if (!c.deletedAt) return { ok: true, changed: false, clipId, status: c.status };
    const [{ next }] = await u.db.select({ next: sql<number>`coalesce(max(${schema.clips.index}) + 1, 0)::int` }).from(schema.clips).where(and(eq(schema.clips.projectId, c.projectId), isNull(schema.clips.deletedAt)));
    await u.db.update(schema.clips).set({ deletedAt: null, index: next, updatedAt: new Date() }).where(eq(schema.clips.id, clipId));
    await u.emit(c.projectId, "clip.restored", { clipId, index: next, title: c.title });
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

/** Clips of a project that a re-analyze replaced and that can still be restored, newest first. */
export async function deletedClips(db: Db, projectId: string) {
  return db
    .select({ id: schema.clips.id, index: schema.clips.index, title: schema.clips.title, startSec: schema.clips.startSec, endSec: schema.clips.endSec, status: schema.clips.status, deletedAt: schema.clips.deletedAt })
    .from(schema.clips)
    .where(and(eq(schema.clips.projectId, projectId), isNotNull(schema.clips.deletedAt)))
    .orderBy(sql`${schema.clips.deletedAt} desc`, schema.clips.index)
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
    const settings = projectSettingsSchema.parse({ ...p.settings, ...(patch ?? {}) });
    await lockProjectClips(u, p.id);
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
    await u.artifact(p.id, "analyze", "kept", { kept: kept.map(({ c, why }) => ({ clipId: c.id, index: c.index, title: c.title, why })), replaced: replaced.map((c) => c.id), restorable: restorableFor(svc) });
    await u.enqueue(QUEUES.analyze, { projectId: p.id });
    u.afterCommit(() => svc.log.child({ module: "analyze", projectId: p.id }).info({ kept: kept.length, replaced: replaced.length }, "re-analyze keeps the clips the user made or edited"));
    return { ok: true, kept: kept.length, replaced: replaced.length, restorable: restorableFor(svc) };
  });
}

/**
 * The project as `actor` may see it. `deleted: false` = only a live project; `true` = live or deleted (restore).
 * NOT_FOUND for someone else's project unless the actor is an admin or the operator.
 */
async function findProject(db: Db, actor: Actor, projectId: string, o: { deleted: boolean }) {
  const p = await db.query.projects.findFirst({
    where: and(eq(schema.projects.id, projectId), actor && !actor.admin ? eq(schema.projects.userId, actor.id) : undefined, o.deleted ? undefined : isNull(schema.projects.deletedAt)),
  });
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: o.deleted ? "No such project. A deleted project is gone for good once its restore window has passed." : "No such project" });
  return p;
}
const gone = (svc: Services, what: string) => `No such ${what}. Deleted items can be restored ${restorableFor(svc)}; after that they are gone for good.`;

// ── purge ──────────────────────────────────────────────────────────────────

/** Remove a project for good in the caller's unit of work: jobs cancelled, the row (and its clips, transcript, events) deleted, files after commit. */
export async function purgeProject(svc: Services, u: UnitOfWork, projectId: string) {
  for (const c of await u.db.select({ id: schema.clips.id }).from(schema.clips).where(eq(schema.clips.projectId, projectId))) {
    await u.cancelLiveJobs(QUEUES.render, c.id);
    await u.cancelLiveJobs(QUEUES.prepare, c.id);
  }
  for (const q of STAGE_QUEUES) await u.cancelLiveJobs(q, projectId);
  const [gone] = await u.db.delete(schema.projects).where(eq(schema.projects.id, projectId)).returning({ sourceMeta: schema.projects.sourceMeta });
  await releaseUpload(svc, u, projectId, gone?.sourceMeta?.uploadId);
  u.afterCommit(async () => {
    await fs.rm(svc.paths.project(projectId), { recursive: true, force: true });
    await svc.storage.deletePrefix(keys.projectPrefix(projectId));
  });
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
        const files = await svc.tx(async (u) => {
          const [c] = await u.db
            .delete(schema.clips)
            .where(and(eq(schema.clips.id, r.id), isNotNull(schema.clips.deletedAt), sql`${schema.clips.deletedAt} < ${cutoff}::timestamptz`))
            .returning({ outputKey: schema.clips.outputKey, thumbnailKey: schema.clips.thumbnailKey });
          if (!c) return null;
          const list = [c.outputKey, c.thumbnailKey].filter((k): k is string => !!k);
          u.afterCommit(async () => {
            for (const key of list) {
              await svc.storage.delete(key).catch((err) => log.warn({ err, clipId: r.id }, "could not delete a purged clip's file"));
              await removeScratchClip(svc, r.projectId, key);
            }
          });
          return list;
        });
        if (files) {
          out.clips.push(r.id);
          log.info({ clipId: r.id, projectId: r.projectId, files: files.length, days: days(svc) }, "purged a replaced clip");
        }
      }
    },
  });
  return out;
}
