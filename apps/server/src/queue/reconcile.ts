import { inArray, eq, desc } from "drizzle-orm";
import { needsPrepare, prepareModeOf } from "../pipeline/manual.js";
import { sweepRetention } from "../retention.js";
import { sweepScratch, purgeBumperAssets } from "../storage/sweep.js";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
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
    where: inArray(schema.projects.status, ["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"]),
  });
  for (const p of active) {
    if (p.status === "rendering") {
      const clips = await db.query.clips.findMany({ where: (t, { eq }) => eq(t.projectId, p.id) });
      for (const c of clips) {
        if (c.status === "done" || c.status === "failed") continue;
        if (needsPrepare(c)) {
          if (await svc.queue.hasLiveJob(QUEUES.prepare, c.id)) continue;
          await svc.tx(async (u) => {
            if (c.status !== "preparing") await u.db.update(schema.clips).set({ status: "preparing" }).where(eq(schema.clips.id, c.id));
            await u.cancelLiveJobs(QUEUES.render, c.id);
            await u.enqueue(QUEUES.prepare, { projectId: p.id, clipId: c.id, mode: prepareModeOf(c) });
          });
          requeued++;
          continue;
        }
        if (await svc.queue.hasLiveJob(QUEUES.render, c.id)) continue;
        // re-queue the clip's current generation (no bump: nothing about the clip changed)
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
        await svc.queue.enqueue(REFINE_QUEUE[step], { projectId: p.id });
        requeued++;
      }
      await finishIfComplete(svc, p.id);
      continue;
    }
    const queue = statusQueue[p.status];
    if (!queue || (await svc.queue.hasLiveJob(queue, p.id))) continue;
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
      .then(() => detectStalls(svc, svc.config.STALL_MINUTES))
      .then(() => sweepRetention(svc))
      .then(async () => {
        // leftover files nothing points at: at most hourly (a safety net for crashes between commit and delete)
        if (Date.now() - lastSweep < 60 * 60_000) return;
        lastSweep = Date.now();
        await sweepScratch(svc);
        await purgeBumperAssets(svc);
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
  const active = await db.query.projects.findMany({ where: inArray(schema.projects.status, ["ingesting", "transcribing", "refining", "analyzing", "rendering"]) });
  let stalled = 0;
  for (const p of active) {
    const last = await db.query.projectEvents.findFirst({ where: eq(schema.projectEvents.projectId, p.id), orderBy: desc(schema.projectEvents.id) });
    if (!last || last.createdAt > cutoff || last.type === "job.stalled") continue;
    const jobs = await svc.database.pool.query<{ name: string; state: string; retry_count: number; started_on: Date | null; singleton_key: string }>(
      `select name, state, retry_count, started_on, singleton_key from pgboss.job where data->>'projectId' = $1 and state in ('created','retry','active') order by created_on`,
      [p.id],
    );
    const info = {
      projectId: p.id,
      status: p.status,
      idleMinutes: Math.round((Date.now() - last.createdAt.getTime()) / 60_000),
      lastEvent: { type: last.type, payload: last.payload },
      liveJobs: jobs.rows.map((j) => ({ queue: j.name, state: j.state, retries: j.retry_count, key: j.singleton_key, runningMinutes: j.started_on ? Math.round((Date.now() - j.started_on.getTime()) / 60_000) : null })),
    };
    log.warn(info, jobs.rows.length ? "no progress from running job" : "active project has no live job");
    await svc.events.emit(p.id, "job.stalled", { idleMinutes: info.idleMinutes, lastEvent: last.type, liveJobs: info.liveJobs.length, hint: jobs.rows.length ? "still running; check `reelsaw status`" : "no job; the reconciler will re-enqueue it" });
    stalled++;
  }
  return stalled;
}
