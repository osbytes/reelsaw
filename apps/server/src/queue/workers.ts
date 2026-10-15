import type { Services } from "../services.js";
import { QUEUES, type ProjectJob, type RenderJob, type PrepareJob, type QueueName } from "./boss.js";
import { prepareClip } from "../pipeline/manual.js";
import { ingest } from "../pipeline/ingest.js";
import { transcribe } from "../pipeline/transcribe.js";
import { analyze } from "../pipeline/analyze.js";
import { refineEntities, refineDisfluency, refineScenes, refineStepFailed } from "../pipeline/refine.js";
import { renderClip, markClipFailed } from "../pipeline/render.js";
import { StageContext, failProject, stageFailedAttempt, ProjectGoneError } from "../pipeline/common.js";
import { withSpan } from "../otel.js";
import type { PipelineStage, RefineStep } from "@reelsaw/shared";

type Job<T> = { id: string; data: T; retryCount: number; signal: AbortSignal };

function projectStage(svc: Services, queue: QueueName, stage: PipelineStage, fn: (ctx: StageContext) => Promise<void>) {
  return async (jobs: Job<ProjectJob>[]) => {
    const job = jobs[0]!;
    const { projectId } = job.data;
    const max = svc.queue.retryLimitOf(queue);
    const attempt = job.retryCount + 1;
    const log = svc.log.child({ module: "worker", queue, jobId: job.id, projectId });
    try {
      log.info({ attempt, maxAttempts: max + 1 }, "job start");
      const t0 = Date.now();
      await withSpan(`pipeline.${stage}`, { "reelsaw.project_id": projectId, "reelsaw.attempt": attempt }, () =>
        fn(new StageContext(svc, projectId, stage, job.signal)),
      );
      log.info({ ms: Date.now() - t0 }, "job done");
    } catch (err) {
      if (err instanceof ProjectGoneError) return log.warn({ reason: err.message }, "job skipped");
      log.error({ err, attempt, maxAttempts: max + 1 }, "job failed");
      if (job.retryCount >= max) await failProject(svc, projectId, stage, err);
      else await stageFailedAttempt(svc, projectId, stage, err, attempt, max + 1);
      throw err; // let pg-boss apply the retry policy
    }
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
    try {
      log.info({ attempt: job.retryCount + 1, maxAttempts: max + 1 }, "job start");
      await withSpan(`pipeline.refine.${step}`, { "reelsaw.project_id": projectId, "reelsaw.attempt": job.retryCount + 1 }, () => fn(new StageContext(svc, projectId, "refine", job.signal)));
    } catch (err) {
      if (err instanceof ProjectGoneError) return;
      log.error({ err, attempt: job.retryCount + 1 }, "job failed");
      if (job.retryCount >= max) {
        await refineStepFailed(svc, projectId, step, err);
        return; // handled: don't make pg-boss retry further
      }
      await stageFailedAttempt(svc, projectId, "refine", err, job.retryCount + 1, max + 1);
      throw err;
    }
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
    try {
      log.info({ attempt: job.retryCount + 1, maxAttempts: max + 1 }, "job start");
      await withSpan("pipeline.prepare", { "reelsaw.project_id": projectId, "reelsaw.clip_id": clipId }, () => prepareClip(new StageContext(svc, projectId, "render", job.signal), clipId, mode));
    } catch (err) {
      if (err instanceof ProjectGoneError) return;
      log.error({ err, attempt: job.retryCount + 1 }, "job failed");
      if (job.retryCount >= max) await markClipFailed(svc, projectId, clipId, err);
      throw err;
    }
  });

  await boss.work<RenderJob>(QUEUES.render, { ...common, localConcurrency: svc.config.RENDER_CONCURRENCY }, async (jobs: Job<RenderJob>[]) => {
    const job = jobs[0]!;
    const { projectId, clipId } = job.data;
    const max = svc.queue.retryLimitOf(QUEUES.render);
    const log = svc.log.child({ module: "worker", queue: QUEUES.render, jobId: job.id, projectId, clipId });
    try {
      log.info({ attempt: job.retryCount + 1, maxAttempts: max + 1 }, "job start");
      await withSpan("pipeline.render", { "reelsaw.project_id": projectId, "reelsaw.clip_id": clipId, "reelsaw.attempt": job.retryCount + 1 }, () =>
        renderClip(new StageContext(svc, projectId, "render", job.signal), clipId),
      );
    } catch (err) {
      if (err instanceof ProjectGoneError) return;
      log.error({ err, attempt: job.retryCount + 1 }, "job failed");
      if (job.retryCount >= max) await markClipFailed(svc, projectId, clipId, err);
      throw err;
    }
  });

  svc.log.info({ module: "worker", queues: Object.values(QUEUES), renderConcurrency: svc.config.RENDER_CONCURRENCY }, "workers listening");
}
