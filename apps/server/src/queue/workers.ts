import type { Services } from "../services.js";
import { QUEUES, type ProjectJob, type RenderJob, type PrepareJob, type QueueName } from "./boss.js";
import { eventHandlerQueues, parseEventHandlerJob } from "../event-handlers.js";
import { projectEventHandlers } from "../project-event-handlers.js";
import { prepareClip } from "../pipeline/manual.js";
import { withLlmContext } from "../ai/trace.js";
import { ingest } from "../pipeline/ingest.js";
import { transcribe } from "../pipeline/transcribe.js";
import { analyze } from "../pipeline/analyze.js";
import { refineEntities, refineDisfluency, refineScenes, refineStepFailed } from "../pipeline/refine.js";
import { renderClip, markClipFailed } from "../pipeline/render.js";
import { StageContext, failProject, stageFailedAttempt, ProjectGoneError } from "../pipeline/common.js";
import { ResourceExhaustedError } from "../resources.js";
import { withSpan } from "../otel.js";
import type { PipelineStage, RefineStep } from "@reelsaw/shared";
import { trackJob } from "./inflight.js";

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
    return runTracked(job, queue, {}, async () => {
      try {
        const prev = job.retryCount ? await previousAttempt(svc, job.id) : undefined;
        log.info({ attempt, maxAttempts: max + 1, ...(prev ? { previousAttempt: prev, interrupted: interrupted(prev) } : {}) }, job.retryCount ? "job retry" : "job start");
        const t0 = Date.now();
        await withSpan(`pipeline.${stage}`, { "reelsaw.project_id": projectId, "reelsaw.attempt": attempt }, () =>
          withLlmContext({ projectId, stage, jobId: job.id }, async () => fn(await StageContext.open(svc, projectId, stage, job.signal, { jobId: job.id, queue }))),
        );
        log.info({ ms: Date.now() - t0 }, "job done");
      } catch (err) {
        if (err instanceof ProjectGoneError) return log.warn({ reason: err.message }, "job skipped");
        log.error({ err, attempt, maxAttempts: max + 1 }, "job failed");
        const last = job.retryCount >= max || err instanceof ResourceExhaustedError;
        if (last) {
          svc.telemetry.captureException(err, { queue, stage, projectId, jobId: job.id });
          await failProject(svc, projectId, stage, err);
        } else await stageFailedAttempt(svc, projectId, stage, err, attempt, max + 1);
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
    return runTracked(job, queue, {}, async () => {
      try {
        log.info({ attempt: job.retryCount + 1, maxAttempts: max + 1 }, "job start");
        await withSpan(`pipeline.refine.${step}`, { "reelsaw.project_id": projectId, "reelsaw.attempt": job.retryCount + 1 }, () => withLlmContext({ projectId, stage: `refine.${step}`, jobId: job.id }, async () => fn(await StageContext.open(svc, projectId, "refine", job.signal, { jobId: job.id, queue, step }))));
      } catch (err) {
        if (err instanceof ProjectGoneError) return;
        log.error({ err, attempt: job.retryCount + 1 }, "job failed");
        if (job.retryCount >= max) {
          svc.telemetry.captureException(err, { queue, step, projectId, jobId: job.id });
          await refineStepFailed(svc, projectId, step, err);
          return; // handled: don't make pg-boss retry further
        }
        await stageFailedAttempt(svc, projectId, "refine", err, job.retryCount + 1, max + 1);
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
        await withSpan("pipeline.prepare", { "reelsaw.project_id": projectId, "reelsaw.clip_id": clipId }, () => withLlmContext({ projectId, clipId, stage: "prepare", jobId: job.id }, async () => prepareClip(await StageContext.open(svc, projectId, "render", job.signal, { jobId: job.id, clipId, queue: QUEUES.prepare }), clipId, mode)));
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
          await withSpan("pipeline.render", { "reelsaw.project_id": projectId, "reelsaw.clip_id": clipId, "reelsaw.attempt": job.retryCount + 1 }, async () =>
            renderClip(await StageContext.open(svc, projectId, "render", job.signal, { jobId: job.id, clipId, queue: QUEUES.render }), clipId, gen),
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

  // event handlers (event-handlers.ts): one queue each; the queue's policy is the concurrency it opted into
  const handlerQueues = eventHandlerQueues(projectEventHandlers);
  for (const q of handlerQueues) {
    await boss.work(q.name, { pollingIntervalSeconds: q.options.pollingIntervalSeconds, localConcurrency: q.options.localConcurrency }, async (jobs) => {
      const job = jobs[0]!;
      const log = svc.log.child({ module: "events", handler: q.handler, event: q.type, jobId: job.id });
      const { event, key } = parseEventHandlerJob(q.type, job.data);
      try {
        await q.def.handle({
          event,
          key,
          svc,
          signal: job.signal,
          again: (o) => svc.queue.send(q.name, { event, key }, { singletonKey: key, ...(o?.delaySeconds ? { startAfter: o.delaySeconds } : {}) }),
        });
      } catch (err) {
        log.error({ err, key, attempt: job.retryCount + 1 }, "event handler failed");
        throw err;
      }
    });
  }

  svc.log.info({ module: "worker", queues: [...Object.values(QUEUES), ...handlerQueues.map((q) => q.name)], renders: svc.resources.renders().mode === "auto" ? `auto, up to ${svc.resources.maxRenders()}` : svc.resources.maxRenders() }, "workers listening");
}
