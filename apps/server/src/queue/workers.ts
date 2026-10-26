import type { Services } from "../services.js";
import { QUEUES, type ProjectJob, type RenderJob, type PrepareJob, type QueueName } from "./boss.js";
import { prepareClip } from "../pipeline/manual.js";
import { withLlmContext } from "../ai/trace.js";
import { ingest } from "../pipeline/ingest.js";
import { transcribe } from "../pipeline/transcribe.js";
import { analyze } from "../pipeline/analyze.js";
import { refineEntities, refineDisfluency, refineScenes, refineStepFailed } from "../pipeline/refine.js";
import { renderClip, markClipFailed } from "../pipeline/render.js";
import { StageContext, failProject, stageFailedAttempt, ProjectGoneError, StaleJobError } from "../pipeline/common.js";
import { ResourceExhaustedError } from "../resources.js";
import { withSpan } from "../otel.js";
import type { PipelineStage, RefineStep } from "@reelsaw/shared";
import { inflightJobs, trackJob } from "./inflight.js";
import { gauge, histogram, realtimeFactor, type MetricAttributes } from "../metrics.js";

type Job<T> = { id: string; data: T; retryCount: number; signal: AbortSignal };

/**
 * Why did the previous attempt of this job end? pg-boss keeps it in `output`: our thrown error, or
 * "job heartbeat timeout" when the worker died (crash, deploy, OOM). Logged on every retry so a
 * retried job explains itself.
 */
async function previousAttempt(svc: Services, jobId: string): Promise<string | undefined> {
  try {
    const r = await svc.database.pool.query<{ output: { message?: string; value?: { message?: string } } | null }>("select output from pgboss.job where id = $1", [jobId]);
    const o = r.rows[0]?.output;
    const msg = o?.message ?? o?.value?.message;
    return msg ? String(msg).slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}
const interrupted = (reason?: string) => !!reason && /heartbeat|expired|abort/i.test(reason);

/** Seconds of media a job worked on: the source's length, or the clip's for prepare and render. Null before ingest knows it. */
async function mediaSeconds(svc: Services, projectId: string, clipId?: string): Promise<number | null> {
  try {
    const r = await svc.database.pool.query<{ project: number | null; clip: number | null }>(
      "select p.duration_sec as project, c.end_sec - c.start_sec as clip from projects p left join clips c on c.id = $2 and c.project_id = p.id where p.id = $1",
      [projectId, clipId ?? null],
    );
    const row = r.rows[0];
    const sec = clipId ? row?.clip : row?.project;
    return sec != null && Number.isFinite(Number(sec)) ? Number(sec) : null;
  } catch {
    return null;
  }
}

/**
 * Wall time of one stage job, by outcome; for a job that finished, also the media it covered and the
 * seconds of work per second of media, so a long video and a short one compare. Render waits for a
 * slot outside this, so its numbers are encode time. Ids stay off the attributes (metrics.ts).
 */
async function measured<T>(svc: Services, stage: string, scope: { projectId: string; clipId?: string }, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  let outcome = "ok";
  try {
    return await fn();
  } catch (err) {
    outcome = err instanceof StaleJobError ? "superseded" : err instanceof ProjectGoneError ? "gone" : "error";
    throw err;
  } finally {
    const sec = (performance.now() - t0) / 1000;
    const attrs: MetricAttributes = stage === "render" ? { stage, encoder: svc.media.encoder().name } : { stage };
    histogram("reelsaw.pipeline.stage.duration", sec, "s", { ...attrs, outcome }, "Wall time of one pipeline stage job, by outcome");
    if (outcome === "ok") {
      void mediaSeconds(svc, scope.projectId, scope.clipId).then((media) => {
        if (media === null) return;
        histogram("reelsaw.pipeline.media.duration", media, "s", attrs, "Seconds of media a finished stage job covered (source length; clip length for prepare and render)");
        const rtf = realtimeFactor(sec, media);
        if (rtf !== null) histogram("reelsaw.pipeline.realtime_factor", rtf, "1", attrs, "Stage wall seconds per second of media; 1 = as long as the video");
      });
    }
  }
}

function runTracked<T>(job: Job<ProjectJob>, queue: QueueName, extra: { clipId?: string }, fn: () => Promise<T>): Promise<T> {
  return trackJob({ jobId: job.id, queue, projectId: job.data.projectId, ...(extra.clipId ? { clipId: extra.clipId } : {}), startedAt: new Date().toISOString() }, fn);
}

function projectStage(svc: Services, queue: QueueName, stage: PipelineStage, fn: (ctx: StageContext) => Promise<void>) {
  return async (jobs: Job<ProjectJob>[]) => {
    const job = jobs[0]!;
    const { projectId } = job.data;
    const max = svc.queue.retryLimitOf(queue);
    const attempt = job.retryCount + 1;
    const log = svc.log.child({ module: "worker", queue, jobId: job.id, projectId });
    let seq = job.data.seq; // the version this job belongs to; StageContext.open resolves a missing one to the current
    return runTracked(job, queue, {}, async () => {
      try {
        const prev = job.retryCount ? await previousAttempt(svc, job.id) : undefined;
        log.info({ attempt, maxAttempts: max + 1, seq, ...(prev ? { previousAttempt: prev, interrupted: interrupted(prev) } : {}) }, job.retryCount ? "job retry" : "job start");
        const t0 = Date.now();
        await measured(svc, stage, { projectId }, () =>
          withSpan(`pipeline.${stage}`, { "reelsaw.project_id": projectId, "reelsaw.attempt": attempt }, () =>
            withLlmContext({ projectId, stage, jobId: job.id }, async () => {
              const ctx = await StageContext.open(svc, projectId, stage, job.signal, { jobId: job.id, queue }, seq);
              seq = ctx.seq;
              return fn(ctx);
            }),
          ),
        );
        log.info({ ms: Date.now() - t0 }, "job done");
      } catch (err) {
        if (err instanceof ProjectGoneError) return log.warn({ reason: err.message }, "job skipped");
        // cancelling a pg-boss job does not stop a running handler: the superseded one ends here, writing nothing
        if (err instanceof StaleJobError) return log.info({ reason: err.message, seq }, "job skipped: superseded");
        log.error({ err, attempt, maxAttempts: max + 1 }, "job failed");
        const last = job.retryCount >= max || err instanceof ResourceExhaustedError;
        if (last) {
          svc.telemetry.captureException(err, { queue, stage, projectId, jobId: job.id });
          await failProject(svc, projectId, stage, err, seq);
        } else await stageFailedAttempt(svc, projectId, stage, err, attempt, max + 1, seq);
        // disk will not free itself on the next attempt; returning marks the job done so it does not loop
        if (err instanceof ResourceExhaustedError) return;
        throw err; // let pg-boss apply the retry policy
      }
    });
  };
}

export async function startWorkers(svc: Services) {
  const { boss } = svc.queue;
  const common = { pollingIntervalSeconds: 2 };

  await boss.work<ProjectJob>(QUEUES.ingest, { ...common, localConcurrency: 2 }, projectStage(svc, QUEUES.ingest, "ingest", ingest));
  await boss.work<ProjectJob>(QUEUES.transcribe, { ...common, localConcurrency: 2 }, projectStage(svc, QUEUES.transcribe, "transcribe", transcribe));
  await boss.work<ProjectJob>(QUEUES.analyze, { ...common, localConcurrency: 2 }, projectStage(svc, QUEUES.analyze, "analyze", analyze));

  // refine steps: independent, each marks itself failed (never the project) after its last retry
  const refineStage = (queue: QueueName, step: RefineStep, fn: (ctx: StageContext) => Promise<void>) => async (jobs: Job<ProjectJob>[]) => {
    const job = jobs[0]!;
    const { projectId } = job.data;
    const max = svc.queue.retryLimitOf(queue);
    const log = svc.log.child({ module: "worker", queue, jobId: job.id, projectId });
    let seq = job.data.seq;
    return runTracked(job, queue, {}, async () => {
      try {
        log.info({ attempt: job.retryCount + 1, maxAttempts: max + 1, seq }, "job start");
        await measured(svc, `refine.${step}`, { projectId }, () =>
          withSpan(`pipeline.refine.${step}`, { "reelsaw.project_id": projectId, "reelsaw.attempt": job.retryCount + 1 }, () =>
            withLlmContext({ projectId, stage: `refine.${step}`, jobId: job.id }, async () => {
              const ctx = await StageContext.open(svc, projectId, "refine", job.signal, { jobId: job.id, queue, step }, seq);
              seq = ctx.seq;
              return fn(ctx);
            }),
          ),
        );
      } catch (err) {
        if (err instanceof ProjectGoneError) return;
        if (err instanceof StaleJobError) return log.info({ reason: err.message, seq }, "job skipped: superseded");
        log.error({ err, attempt: job.retryCount + 1 }, "job failed");
        if (job.retryCount >= max) {
          svc.telemetry.captureException(err, { queue, step, projectId, jobId: job.id });
          await refineStepFailed(svc, projectId, step, err, seq);
          return; // handled: don't make pg-boss retry further
        }
        await stageFailedAttempt(svc, projectId, "refine", err, job.retryCount + 1, max + 1, seq);
        throw err;
      }
    });
  };
  await boss.work<ProjectJob>(QUEUES.refineEntities, { ...common, localConcurrency: 2 }, refineStage(QUEUES.refineEntities, "entities", refineEntities));
  await boss.work<ProjectJob>(QUEUES.refineDisfluency, { ...common, localConcurrency: 2 }, refineStage(QUEUES.refineDisfluency, "disfluency", refineDisfluency));
  await boss.work<ProjectJob>(QUEUES.refineScenes, { ...common, localConcurrency: 1 }, refineStage(QUEUES.refineScenes, "scenes", refineScenes));

  // clips carved out of the transcript by the user: AI packaging (and bounds for "ai" mode), then render
  await boss.work<PrepareJob>(QUEUES.prepare, { ...common, localConcurrency: 2 }, async (jobs: Job<PrepareJob>[]) => {
    const job = jobs[0]!;
    const { projectId, clipId, mode } = job.data;
    const max = svc.queue.retryLimitOf(QUEUES.prepare);
    const log = svc.log.child({ module: "worker", queue: QUEUES.prepare, jobId: job.id, projectId, clipId, mode });
    return runTracked(job, QUEUES.prepare, { clipId }, async () => {
      try {
        const prev = job.retryCount ? await previousAttempt(svc, job.id) : undefined;
        log.info({ attempt: job.retryCount + 1, maxAttempts: max + 1, ...(prev ? { previousAttempt: prev, interrupted: interrupted(prev) } : {}) }, job.retryCount ? "job retry" : "job start");
        if (prev) await svc.events.emit(projectId, "clip.retrying", { clipId, step: "prepare", attempt: job.retryCount + 1, max: max + 1, reason: interrupted(prev) ? "interrupted (worker restarted or crashed)" : prev.slice(0, 300) }).catch(() => {});
        await measured(svc, "prepare", { projectId, clipId }, () =>
          withSpan("pipeline.prepare", { "reelsaw.project_id": projectId, "reelsaw.clip_id": clipId }, () => withLlmContext({ projectId, clipId, stage: "prepare", jobId: job.id }, async () => prepareClip(await StageContext.open(svc, projectId, "render", job.signal, { jobId: job.id, clipId, queue: QUEUES.prepare }), clipId, mode))),
        );
      } catch (err) {
        if (err instanceof ProjectGoneError) return;
        log.error({ err, attempt: job.retryCount + 1 }, "job failed");
        if (job.retryCount >= max) {
          svc.telemetry.captureException(err, { queue: QUEUES.prepare, projectId, clipId, jobId: job.id });
          await markClipFailed(svc, projectId, clipId, err);
        }
        throw err;
      }
    });
  });

  // slots up to the machine's ceiling; renderSlot() decides how many actually run (CPU and memory now)
  await boss.work<RenderJob>(QUEUES.render, { ...common, localConcurrency: svc.resources.maxRenders() }, async (jobs: Job<RenderJob>[]) => {
    const job = jobs[0]!;
    const { projectId, clipId, gen } = job.data;
    const max = svc.queue.retryLimitOf(QUEUES.render);
    const log = svc.log.child({ module: "worker", queue: QUEUES.render, jobId: job.id, projectId, clipId });
    return runTracked(job, QUEUES.render, { clipId }, async () => {
      try {
        const prev = job.retryCount ? await previousAttempt(svc, job.id) : undefined;
        log.info({ attempt: job.retryCount + 1, maxAttempts: max + 1, ...(prev ? { previousAttempt: prev, interrupted: interrupted(prev) } : {}) }, job.retryCount ? "job retry" : "job start");
        if (prev) await svc.events.emit(projectId, "clip.retrying", { clipId, step: "render", attempt: job.retryCount + 1, max: max + 1, reason: interrupted(prev) ? "interrupted (worker restarted or crashed)" : prev.slice(0, 300) }).catch(() => {});
        const release = await svc.resources.renderSlot({ signal: job.signal, onWait: (reason) => log.info({ reason }, "waiting for a render slot") });
        try {
          await measured(svc, "render", { projectId, clipId }, () =>
            withSpan("pipeline.render", { "reelsaw.project_id": projectId, "reelsaw.clip_id": clipId, "reelsaw.attempt": job.retryCount + 1 }, async () =>
              renderClip(await StageContext.open(svc, projectId, "render", job.signal, { jobId: job.id, clipId, queue: QUEUES.render }), clipId, gen),
            ),
          );
        } finally {
          release();
        }
      } catch (err) {
        if (err instanceof ProjectGoneError) return;
        log.error({ err, attempt: job.retryCount + 1 }, "job failed");
        if (job.retryCount >= max) {
          svc.telemetry.captureException(err, { queue: QUEUES.render, projectId, clipId, jobId: job.id });
          await markClipFailed(svc, projectId, clipId, err, gen);
        }
        throw err;
      }
    });
  });

  // this process only; pg-boss reports the cluster-wide backlog as pgboss.queue.jobs (OTLP)
  gauge("reelsaw.render.slots", "{render}", () => {
    const r = svc.resources.renders();
    return [[r.running, { state: "running" }], [r.limit, { state: "limit" }]];
  }, "Renders running in this worker and the limit CPU and memory allow right now");
  gauge("reelsaw.worker.jobs.active", "{job}", () => {
    const by = new Map<string, number>(Object.values(QUEUES).map((q) => [q, 0]));
    for (const j of inflightJobs()) by.set(j.queue, (by.get(j.queue) ?? 0) + 1);
    return [...by].map(([queue, n]) => [n, { queue }]);
  }, "Jobs this worker process is running, by queue");

  svc.log.info({ module: "worker", queues: Object.values(QUEUES), renders: svc.resources.renders().mode === "auto" ? `auto, up to ${svc.resources.maxRenders()}` : svc.resources.maxRenders() }, "workers listening");
}
