import { and, inArray, eq, desc, isNull } from "drizzle-orm";
import { purgeDeleted } from "../projects/service.js";
import { needsPrepare } from "../pipeline/manual.js";
import { requestPrepare } from "../pipeline/lifecycle.js";
import { sweepRetention } from "../retention.js";
import { pruneHistory } from "../events-retention.js";
import { backfillAssetRefs } from "../library/refs.js";
import { sweepScratch, purgeBumperAssets } from "../storage/sweep.js";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import { flagAccounts, pruneRequestRate } from "../abuse.js";
import { libraryProviders } from "../library/import.js";
import { QUEUES, type QueueName } from "./boss.js";
import { finalizeProjectIfDone } from "../pipeline/render.js";
import { REFINE_QUEUE, finishIfComplete } from "../pipeline/refine.js";
import { REFINE_STEPS } from "@reelsaw/shared";
import type { ProjectStatus } from "@reelsaw/shared";

const statusQueue: Partial<Record<ProjectStatus, QueueName>> = {
  queued: QUEUES.ingest,
  ingesting: QUEUES.ingest,
  transcribing: QUEUES.transcribe,
  analyzing: QUEUES.analyze,
};

/**
 * Re-enqueue any project whose pipeline stage has no live job. Covers jobs lost to crashes
 * between "mark stage done" and "enqueue next stage", retries exhausted by a transient outage,
 * or manual DB edits. Every stage is idempotent, so double-runs are safe.
 */
export async function reconcile(svc: Services): Promise<{ requeued: number }> {
  const db = svc.database.db;
  let requeued = 0;
  const active = await db.query.projects.findMany({
    where: and(inArray(schema.projects.status, ["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"]), isNull(schema.projects.deletedAt)),
    columns: { id: true, status: true }, // not the whole row (settings etc.): only these two are read
  });
  for (const p of active) {
    if (p.status === "rendering") {
      const clips = await db.query.clips.findMany({ where: (t, { and, eq, isNull }) => and(eq(t.projectId, p.id), isNull(t.deletedAt)) });
      for (const c of clips) {
        if (c.status === "done" || c.status === "failed") continue;
        if (needsPrepare(c)) {
          if (await svc.queue.hasLiveJob(QUEUES.prepare, c.id)) continue;
          // restart: false re-checks for a live prepare job inside the transaction and keeps one that appeared meanwhile
          await svc.tx(async (u) => {
            await u.cancelLiveJobs(QUEUES.render, c.id);
            await requestPrepare(svc, u, p.id, c.id, { restart: false });
          });
          requeued++;
          continue;
        }
        if (await svc.queue.hasLiveJob(QUEUES.render, c.id)) continue;
        // re-queue the clip's current generation (no bump: nothing about the clip changed). Outside a unit of work on
        // purpose: no row changes here, and a duplicate is harmless only because pg-boss enqueues with
        // singletonKey = clip id on an exclusive queue (one live job per clip), so a race with another enqueue is a
        // no-op, and a render of a stale generation exits. Drop that singletonKey and this needs svc.tx + hasLiveJob.
        await svc.queue.enqueue(QUEUES.render, { projectId: p.id, clipId: c.id, gen: c.renderGen });
        requeued++;
      }
      await finalizeProjectIfDone(svc, p.id);
      continue;
    }
    if (p.status === "refining") {
      const t = await db.query.transcripts.findFirst({ where: (x, { eq }) => eq(x.projectId, p.id), columns: { refine: true } });
      if (!t) continue;
      for (const step of REFINE_STEPS) {
        const st = t.refine[step];
        if (st === "done" || st === "failed") continue;
        if (await svc.queue.hasLiveJob(REFINE_QUEUE[step], p.id)) continue;
        // outside a unit of work: safe only because of singletonKey = project id (exclusive queue), see above
        await svc.queue.enqueue(REFINE_QUEUE[step], { projectId: p.id });
        requeued++;
      }
      await finishIfComplete(svc, p.id);
      continue;
    }
    const queue = statusQueue[p.status];
    if (!queue || (await svc.queue.hasLiveJob(queue, p.id))) continue;
    // outside a unit of work: safe only because of singletonKey = project id (exclusive queue), see above
    await svc.queue.enqueue(queue, { projectId: p.id });
    requeued++;
  }
  if (requeued) svc.log.info({ module: "reconcile", requeued }, "re-enqueued orphaned jobs");
  return { requeued };
}

export function startReconciler(svc: Services, intervalMs = 5 * 60_000) {
  let lastSweep = 0;
  const tick = () =>
    reconcile(svc)
      .then(() => detectStalls(svc, svc.settings.get().STALL_MINUTES))
      .then(() => sweepRetention(svc))
      .then(() => pruneHistory(svc)) // daily per table, batched and resumable; a no-op between runs
      .then(() => backfillAssetRefs(svc)) // one-time, resumable, bounded per tick; a no-op once done
      .then(async () => {
        // leftover files nothing points at: at most hourly (a safety net for crashes between commit and delete)
        if (Date.now() - lastSweep < 60 * 60_000) return;
        lastSweep = Date.now();
        await sweepScratch(svc, { budgeted: true });
        await purgeBumperAssets(svc);
        await purgeDeleted(svc); // deleted projects and replaced clips past DELETED_RETENTION_DAYS
        await flagAccounts(svc); // abuse flags for the Users page (abuse.ts)
        await pruneRequestRate(svc.database.db);
        await libraryProviders(svc).catalog.refresh(); // newer Reelsaw catalog manifest (ETag; a failure is a debug line)
      })
      .catch((err) => svc.log.error({ module: "reconcile", err }, "reconcile failed"));
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Watchdog: a running project or clip that has emitted no event for STALL_MINUTES is reported once
 * (structured warn + a `job.stalled` event the UI shows), with what it was last doing and the live
 * job's age, so "stuck" is visible and explainable instead of a silent spinner.
 */
export async function detectStalls(svc: Services, minutes: number): Promise<number> {
  const db = svc.database.db;
  const log = svc.log.child({ module: "watchdog" });
  const cutoff = new Date(Date.now() - minutes * 60_000);
  const active = await db.query.projects.findMany({ where: and(inArray(schema.projects.status, ["ingesting", "transcribing", "refining", "analyzing", "rendering"]), isNull(schema.projects.deletedAt)), columns: { id: true, status: true, updatedAt: true } });
  let stalled = 0;
  for (const p of active) {
    const last = await db.query.projectEvents.findFirst({ where: eq(schema.projectEvents.projectId, p.id), orderBy: desc(schema.projectEvents.id) });
    // progress ticks only touch projects.updated_at (they are not stored as events), so that counts as activity too
    if (!last || last.createdAt > cutoff || p.updatedAt > cutoff || last.type === "job.stalled") continue;
    // live jobs by (name, singleton_key): enqueue sets the key to the project id (stage jobs) or the clip id (render/prepare),
    // and exclusive-policy queues index exactly that, unlike data->>'projectId' which scans the whole job table
    const clipIds = (await db.select({ id: schema.clips.id }).from(schema.clips).where(eq(schema.clips.projectId, p.id))).map((c) => c.id);
    const jobs = await svc.database.pool.query<{ name: string; state: string; retry_count: number; started_on: Date | null; singleton_key: string }>(
      `select name, state, retry_count, started_on, singleton_key from pgboss.job where name = any($1) and singleton_key = any($2) and state in ('created','retry','active') order by created_on`,
      [Object.values(QUEUES), [p.id, ...clipIds]],
    );
    const info = {
      projectId: p.id,
      status: p.status,
      idleMinutes: Math.round((Date.now() - Math.max(last.createdAt.getTime(), p.updatedAt.getTime())) / 60_000),
      lastEvent: { type: last.type, payload: last.payload },
      liveJobs: jobs.rows.map((j) => ({ queue: j.name, state: j.state, retries: j.retry_count, key: j.singleton_key, runningMinutes: j.started_on ? Math.round((Date.now() - j.started_on.getTime()) / 60_000) : null })),
    };
    log.warn(info, jobs.rows.length ? "no progress from running job" : "active project has no live job");
    await svc.events.emit(p.id, "job.stalled", { idleMinutes: info.idleMinutes, lastEvent: last.type, liveJobs: info.liveJobs.length, hint: jobs.rows.length ? "still running; check `reelsaw status`" : "no job; the reconciler will re-enqueue it" });
    stalled++;
  }
  return stalled;
}
