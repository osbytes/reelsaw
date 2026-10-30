import { and, inArray, eq, desc, isNull, gt, sql } from "drizzle-orm";
import { purgeDeleted } from "../projects/service.js";
import { needsPrepare } from "../pipeline/manual.js";
import { requestPrepare } from "../pipeline/lifecycle.js";
import { pruneJobSteps, sweepRetention } from "../retention.js";
import { pruneHistory } from "../events-retention.js";
import { backfillAssetRefs } from "../library/refs.js";
import { sweepScratch, purgeBumperAssets } from "../storage/sweep.js";
import { sweepAbandonedUploads } from "../storage/uploads.js";
import { pruneDiskLeases } from "../disk-leases.js";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import { flagAccounts, pruneRequestRate } from "../abuse.js";
import { libraryProviders } from "../library/import.js";
import { QUEUES, type QueueName } from "./boss.js";
import { finalizeProjectIfDone, markClipFailed } from "../pipeline/render.js";
import { failProject } from "../pipeline/common.js";
import { STAGE_LABEL } from "../pipeline/steps.js";
import type { UnitOfWork } from "../uow.js";
import { sessionLock, withSessionLock } from "../locks.js";
import { WORKER_STALE_MS } from "../ops/workers.js";
import { REFINE_QUEUE, finishIfComplete } from "../pipeline/refine.js";
import { REFINE_STEPS } from "@reelsaw/shared";
import type { ClipStatus, PipelineStage, ProjectStatus } from "@reelsaw/shared";

const statusQueue: Partial<Record<ProjectStatus, QueueName>> = {
  queued: QUEUES.ingest,
  ingesting: QUEUES.ingest,
  transcribing: QUEUES.transcribe,
  analyzing: QUEUES.analyze,
};

/** How many times the reconciler re-enqueues a lost job before it fails the project or clip instead. */
export const MAX_RECONCILE_REQUEUES = 3;
/** Pure: the counter value just written (after the increment) is past the budget. */
export const shouldGiveUp = (requeues: number): boolean => requeues > MAX_RECONCILE_REQUEUES;
export const INTERRUPTED_MESSAGE = `Processing was interrupted ${MAX_RECONCILE_REQUEUES + 1} times (the worker crashed, ran out of memory, or was stopped). Retry to try again.`;

/** A job that kept vanishing mid-run (crash, out of memory, stop): a worker problem a person must look at. */
export class JobInterruptedError extends Error {
  constructor() {
    super(INTERRUPTED_MESSAGE);
    this.name = "JobInterruptedError";
  }
}

const stageOfStatus: Partial<Record<ProjectStatus, PipelineStage>> = {
  queued: "ingest",
  ingesting: "ingest",
  transcribing: "transcribe",
  refining: "refine",
  analyzing: "analyze",
};

/**
 * pg-boss-level failures (heartbeat timeout, expiry, an OOM kill) never reach failProject / markClipFailed, so a job
 * that kills its worker every time would be re-enqueued here forever with a fresh retry budget. Each re-enqueue
 * counts on the row, in the same unit of work as the enqueue; past MAX_RECONCILE_REQUEUES the caller fails it.
 * Resets to 0 on a user start, retry or render request (lifecycle.ts). Returns the new count, or null when the row
 * moved on (status changed, deleted) or a live job appeared since the caller looked: nothing was counted or queued.
 * The live-job check runs before the increment, so a race that finds a live job never burns a requeue.
 */
async function countRequeue(
  u: UnitOfWork,
  target: { project: string; status: ProjectStatus } | { clip: string; status: ClipStatus },
  live: QueueName[],
): Promise<number | null> {
  const p = schema.projects;
  const c = schema.clips;
  const key = "project" in target ? target.project : target.clip;
  for (const q of live) if (await u.hasLiveJob(q, key)) return null;
  const [row] =
    "project" in target
      ? await u.db
          .update(p)
          .set({ reconcileRequeues: sql`${p.reconcileRequeues} + 1` })
          .where(and(eq(p.id, target.project), eq(p.status, target.status), isNull(p.deletedAt)))
          .returning({ n: p.reconcileRequeues })
      : await u.db
          .update(c)
          .set({ reconcileRequeues: sql`${c.reconcileRequeues} + 1` })
          .where(and(eq(c.id, target.clip), eq(c.status, target.status), isNull(c.deletedAt)))
          .returning({ n: c.reconcileRequeues });
  return row ? row.n : null;
}

/**
 * Re-enqueue any project whose pipeline stage has no live job. Covers jobs lost to crashes
 * between "mark stage done" and "enqueue next stage", retries exhausted by a transient outage,
 * or manual DB edits. Every stage is idempotent, so double-runs are safe. A project or clip that was
 * re-enqueued more than MAX_RECONCILE_REQUEUES times since its last start fails instead (see `countRequeue`).
 */
export async function reconcile(svc: Services): Promise<{ requeued: number }> {
  const db = svc.database.db;
  const log = svc.log.child({ module: "reconcile" });
  let requeued = 0;
  const active = await db.query.projects.findMany({
    where: and(
      inArray(schema.projects.status, ["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"]),
      isNull(schema.projects.deletedAt),
    ),
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
          const n = await svc.tx(async (u) => {
            const n = await countRequeue(u, { clip: c.id, status: c.status }, [QUEUES.prepare]);
            if (n === null || shouldGiveUp(n)) return n;
            await u.cancelLiveJobs(QUEUES.render, c.id);
            await requestPrepare(svc, u, p.id, c.id, { restart: false });
            return n;
          });
          if (n !== null && shouldGiveUp(n)) await giveUpClip(svc, p.id, c.id, n);
          else if (n !== null) requeued++;
          continue;
        }
        if (await svc.queue.hasLiveJob(QUEUES.render, c.id)) continue;
        // re-queue the clip's current generation (no bump: nothing about the clip changed). The counter and the
        // enqueue share a unit of work, so a crash between them cannot lose a count or leave a count without its job.
        // A duplicate is still harmless, because pg-boss enqueues with singletonKey = clip id on an exclusive queue
        // (one live job per clip), and a render of a stale generation exits.
        const n = await svc.tx(async (u) => {
          const n = await countRequeue(u, { clip: c.id, status: c.status }, [QUEUES.render]);
          if (n === null || shouldGiveUp(n)) return n;
          await u.enqueue(QUEUES.render, { projectId: p.id, clipId: c.id, gen: c.renderGen });
          return n;
        });
        if (n !== null && shouldGiveUp(n)) await giveUpClip(svc, p.id, c.id, n);
        else if (n !== null) requeued++;
      }
      await finalizeProjectIfDone(svc, p.id);
      continue;
    }
    if (p.status === "refining") {
      const t = await db.query.transcripts.findFirst({ where: (x, { eq }) => eq(x.projectId, p.id), columns: { refine: true } });
      if (!t) continue;
      const lost: QueueName[] = [];
      for (const step of REFINE_STEPS) {
        const st = t.refine[step];
        if (st === "done" || st === "failed") continue;
        if (await svc.queue.hasLiveJob(REFINE_QUEUE[step], p.id)) continue;
        lost.push(REFINE_QUEUE[step]);
      }
      if (lost.length) {
        // one count per pass however many steps lost their job; singletonKey = project id (exclusive queue) dedupes a race
        const n = await svc.tx(async (u) => {
          const n = await countRequeue(u, { project: p.id, status: p.status }, []);
          if (n === null || shouldGiveUp(n)) return n;
          for (const q of lost) await u.enqueue(q, { projectId: p.id });
          return n;
        });
        if (n !== null && shouldGiveUp(n)) await giveUpProject(svc, p.id, p.status, n);
        else if (n !== null) requeued += lost.length;
      }
      await finishIfComplete(svc, p.id);
      continue;
    }
    const queue = statusQueue[p.status];
    if (!queue || (await svc.queue.hasLiveJob(queue, p.id))) continue;
    const n = await svc.tx(async (u) => {
      const n = await countRequeue(u, { project: p.id, status: p.status }, [queue]);
      if (n === null || shouldGiveUp(n)) return n;
      await u.enqueue(queue, { projectId: p.id });
      return n;
    });
    if (n !== null && shouldGiveUp(n)) await giveUpProject(svc, p.id, p.status, n);
    else if (n !== null) requeued++;
  }
  if (requeued) log.info({ requeued }, "re-enqueued orphaned jobs");
  return { requeued };
}

async function giveUpProject(svc: Services, projectId: string, status: ProjectStatus, requeues: number) {
  svc.log.child({ module: "reconcile" }).error({ projectId, status, requeues }, "gave up re-enqueueing a project whose job keeps getting lost");
  const err = new JobInterruptedError();
  svc.telemetry.captureException(err, { projectId, status, requeues });
  await failProject(svc, projectId, stageOfStatus[status] ?? "ingest", err);
}

async function giveUpClip(svc: Services, projectId: string, clipId: string, requeues: number) {
  svc.log.child({ module: "reconcile" }).error({ projectId, clipId, requeues }, "gave up re-enqueueing a clip whose job keeps getting lost");
  const err = new JobInterruptedError();
  svc.telemetry.captureException(err, { projectId, clipId, requeues });
  await markClipFailed(svc, projectId, clipId, err);
}

export function startReconciler(svc: Services, intervalMs = 5 * 60_000) {
  let lastSweep = 0;
  const log = svc.log.child({ module: "reconcile" });
  // every RUN_WORKERS process runs a tick, but one at a time across the fleet (a session advisory lock held for the
  // tick): no duplicate job.stalled events, no two sweeps racing on the prune_state cursors. reconcile() itself takes
  // no lock, so the CLI's `recover` can call it directly.
  // one monitor for the fleet: whichever process held the lock checks in, so a tick nobody ran is a missed check-in
  const monitor = (status: "ok" | "error") =>
    svc.telemetry.checkIn("reconciler", status, { type: "interval", minutes: Math.max(1, Math.round(intervalMs / 60_000)) });
  const tick = () =>
    withSessionLock(svc.database.pool, sessionLock.reconcile(), run)
      .then((r) => {
        if (!r.ran) log.debug("another process holds the reconciler lock; skipping this tick");
        else monitor("ok");
      })
      .catch((err) => {
        log.error({ err }, "reconcile failed");
        svc.telemetry.captureException(err, { where: "reconcile" });
        monitor("error");
      });
  const run = () =>
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
        // the speech-to-text cache used to be pruned at boot only, which a long-running worker never reaches
        const asrDays = svc.config.ASR_CACHE_DAYS;
        if (asrDays > 0) await svc.asr.prune(asrDays).then((n) => n && svc.log.info({ module: "asr", removed: n }, "pruned old asr cache entries"));
        await pruneDiskLeases(svc); // expired or orphaned claims (the live sum already ignores them)
        await pruneJobSteps(svc); // checkpoints of projects that finished STEP_RETENTION_DAYS ago
        await purgeBumperAssets(svc);
        await sweepAbandonedUploads(svc); // uploads no project ever used, after 24 h
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
 * For a process that runs no workers (RUN_WORKERS=false), which never starts the reconciler: only the watchdog, so
 * a deployment with no `worker` container still reports queued projects as "No worker is running". Same lock as the
 * reconciler's tick, so it does not duplicate events.
 */
export function startStallWatch(svc: Services, intervalMs = 5 * 60_000) {
  const log = svc.log.child({ module: "watchdog" });
  const tick = () =>
    withSessionLock(svc.database.pool, sessionLock.reconcile(), () => detectStalls(svc, svc.settings.get().STALL_MINUTES)).catch((err) =>
      log.error({ err }, "stall check failed"),
    );
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export interface StallFacts {
  /** the project's stage (a key of STAGE_LABEL) or null when it has none */
  stage: string | null;
  idleMinutes: number;
  /** parts finished and in all, from projects.stage_detail */
  done: number | null;
  total: number | null;
  /** minutes since the newest saved step of the stage finished, null when it has none */
  lastStepMinutes: number | null;
  /** progress ticks kept arriving although no part finished */
  ticking: boolean;
}

/** "Finding moments has made no progress for 15 min: 13 of 43 parts done, last part finished 16 min ago." */
export function stallSentence(f: StallFacts): string {
  const label = f.stage ? (STAGE_LABEL[f.stage] ?? f.stage) : "This project";
  const head =
    f.ticking && f.lastStepMinutes !== null
      ? `${label} is still reporting activity but no part has finished for ${f.lastStepMinutes} min`
      : `${label} has made no progress for ${f.idleMinutes} min`;
  const parts: string[] = [];
  if (f.done !== null && f.total !== null && f.total > 0) parts.push(`${f.done} of ${f.total} parts done`);
  if (f.lastStepMinutes !== null && !f.ticking) parts.push(`last part finished ${f.lastStepMinutes} min ago`);
  return parts.length ? `${head}: ${parts.join(", ")}.` : `${head}.`;
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
  // a project waiting in `queued` is normal behind a backlog, but not when no process that takes jobs has checked in lately
  const live = await db
    .select({ id: schema.workerInstances.id })
    .from(schema.workerInstances)
    .where(and(inArray(schema.workerInstances.role, ["worker", "app"]), gt(schema.workerInstances.lastSeenAt, new Date(Date.now() - WORKER_STALE_MS))))
    .limit(1);
  const noWorker = live.length === 0;
  const statuses: ProjectStatus[] = ["ingesting", "transcribing", "refining", "analyzing", "rendering", ...(noWorker ? (["queued"] as const) : [])];
  const active = await db.query.projects.findMany({
    where: and(inArray(schema.projects.status, statuses), isNull(schema.projects.deletedAt)),
    columns: { id: true, status: true, updatedAt: true, stage: true, stageSeq: true, stageDetail: true },
  });
  let stalled = 0;
  for (const p of active) {
    const last = await db.query.projectEvents.findFirst({ where: eq(schema.projectEvents.projectId, p.id), orderBy: desc(schema.projectEvents.id) });
    if (!last || last.createdAt > cutoff || last.type === "job.stalled") continue;
    // the newest saved step of this run of the stage (stages built on ctx.step); its updated_at moves only when a part finishes
    const [step] = p.stage
      ? await db
          .select({ name: schema.jobSteps.name, updatedAt: schema.jobSteps.updatedAt })
          .from(schema.jobSteps)
          .where(and(eq(schema.jobSteps.projectId, p.id), eq(schema.jobSteps.stage, p.stage), eq(schema.jobSteps.stageSeq, p.stageSeq)))
          .orderBy(desc(schema.jobSteps.updatedAt))
          .limit(1)
      : [];
    // progress ticks only touch projects.updated_at (they are not stored as events), so that counts as activity too;
    // except for a stage of steps, where ticks without a finished part for STALL_MINUTES is a slow model, not progress
    const ticking = p.updatedAt > cutoff;
    if (ticking && !(step && step.updatedAt <= cutoff)) continue;
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
      liveJobs: jobs.rows.map((j) => ({
        queue: j.name,
        state: j.state,
        retries: j.retry_count,
        key: j.singleton_key,
        runningMinutes: j.started_on ? Math.round((Date.now() - j.started_on.getTime()) / 60_000) : null,
      })),
    };
    const lastStepMinutes = step ? Math.round((Date.now() - step.updatedAt.getTime()) / 60_000) : null;
    const detail = p.stageDetail;
    const explain = stallSentence({
      stage: p.stage,
      idleMinutes: info.idleMinutes,
      done: detail?.done ?? null,
      total: detail?.total ?? null,
      lastStepMinutes,
      ticking,
    });
    const noWorkerReason = p.status === "queued" && noWorker;
    log.warn(
      info,
      noWorkerReason ? "queued project and no worker is running" : jobs.rows.length ? "no progress from running job" : "active project has no live job",
    );
    await svc.events.emit(p.id, "job.stalled", {
      idleMinutes: info.idleMinutes,
      lastEvent: last.type,
      liveJobs: info.liveJobs.length,
      ...(p.stage ? { stage: p.stage } : {}),
      ...(detail ? { done: detail.done, total: detail.total, unitMs: detail.unitMs } : {}),
      ...(step ? { lastStepAt: step.updatedAt.toISOString(), lastStepName: step.name } : {}),
      ...(ticking ? { ticking: true } : {}),
      message: noWorkerReason ? "No worker is running, so this queued project is waiting." : explain,
      ...(noWorkerReason ? { reason: "No worker is running" } : {}),
      hint: noWorkerReason
        ? "start a `worker` container (or run the app with RUN_WORKERS=true); queued projects wait for one"
        : jobs.rows.length
          ? "still running; check `reelsaw status`"
          : "no job; the reconciler will re-enqueue it",
    });
    stalled++;
  }
  return stalled;
}
