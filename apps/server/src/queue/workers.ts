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
import { StageContext, failProject, stageFailedAttempt, ProjectGoneError, StaleJobError, NonRetryableError } from "../pipeline/common.js";
import { attemptOutcome } from "../pipeline/steps.js";
import { ResourceExhaustedError } from "../resources.js";
import { withSpan } from "../otel.js";
import type { PipelineStage, RefineStep } from "@reelsaw/shared";
import { inflightJobs, setListeningQueues, trackJob } from "./inflight.js";
import { gauge, histogram, realtimeFactor, type MetricAttributes } from "../metrics.js";
import { createDiskGate, type DiskGate } from "./disk-gate.js";
import type { Logger } from "../log.js";

type Job<T> = { id: string; data: T; retryCount: number; signal: AbortSignal };

/**
 * Why did the previous attempt of this job end? pg-boss keeps it in `output`: our thrown error, or
 * "job heartbeat timeout" when the worker died (crash, deploy, OOM). Logged on every retry so a
 * retried job explains itself.
 */
async function previousAttempt(svc: Services, jobId: string): Promise<string | undefined> {
  try {
    const r = await svc.database.pool.query<{ output: { message?: string; value?: { message?: string } } | null }>(
      "select output from pgboss.job where id = $1",
      [jobId],
    );
    const o = r.rows[0]?.output;
    const msg = o?.message ?? o?.value?.message;
    return msg ? String(msg).slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}
/** The previous attempt's stored output string only (the current error is classified by type: StageTimeoutError, NonRetryableError). */
const interrupted = (reason?: string) => !!reason && /heartbeat|expired|abort|timed out/i.test(reason);

/**
 * The retries this job may still use: the queue's limit plus one for every attempt that made progress (below).
 * Read from the job row, which is where pg-boss decides between retrying and failing it.
 */
async function jobRetryLimit(svc: Services, jobId: string, fallback: number): Promise<number> {
  try {
    const r = await svc.database.pool.query<{ retry_limit: number }>("select retry_limit from pgboss.job where id = $1", [jobId]);
    return r.rows[0]?.retry_limit ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * An attempt that finished steps does not use up a retry: the job gets one more. pg-boss will not take a second job
 * for the same project and queue while this one is still active (exclusive policy), and settles an attempt against its
 * retry_count, so the budget is raised on the running row and the attempt then fails as usual and comes back.
 */
async function grantRetry(svc: Services, jobId: string): Promise<void> {
  await svc.database.pool.query("update pgboss.job set retry_limit = retry_limit + 1 where id = $1 and state = 'active'", [jobId]);
}

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
        histogram(
          "reelsaw.pipeline.media.duration",
          media,
          "s",
          attrs,
          "Seconds of media a finished stage job covered (source length; clip length for prepare and render)",
        );
        const rtf = realtimeFactor(sec, media);
        if (rtf !== null) histogram("reelsaw.pipeline.realtime_factor", rtf, "1", attrs, "Stage wall seconds per second of media; 1 = as long as the video");
      });
    }
  }
}

function runTracked<T>(job: Job<ProjectJob>, queue: QueueName, extra: { clipId?: string }, fn: () => Promise<T>): Promise<T> {
  return trackJob(
    { jobId: job.id, queue, projectId: job.data.projectId, ...(extra.clipId ? { clipId: extra.clipId } : {}), startedAt: new Date().toISOString() },
    fn,
  );
}

/**
 * A job that could not get its disk on this worker, even after eviction. With another live worker
 * that has the room it goes back to the queue (this worker pauses its disk queues first, so the
 * retry lands there); the project sees a plain-language attempt. Null: nobody has the room, and the
 * caller fails the run with the reason, as a single box always did.
 */
async function diskHandOff(gate: DiskGate, queue: QueueName, err: ResourceExhaustedError, log: Logger): Promise<Error | null> {
  const other = await gate.handOff(queue, err.requiredMB);
  if (!other) return null;
  log.warn({ requiredMB: err.requiredMB, freeMB: err.freeMB, workerId: other.workerId }, "handing the job to a worker with disk");
  return new Error(`Not enough disk on this worker (${err.freeMB} MB free, needs ${err.requiredMB}); another worker will pick it up.`);
}

function projectStage(svc: Services, gate: DiskGate, queue: QueueName, stage: PipelineStage, fn: (ctx: StageContext) => Promise<void>) {
  return async (jobs: Job<ProjectJob>[]) => {
    const job = jobs[0]!;
    const { projectId } = job.data;
    const max = svc.queue.retryLimitOf(queue);
    const attempt = job.retryCount + 1;
    const log = svc.log.child({ module: "worker", queue, jobId: job.id, projectId });
    let seq = job.data.seq; // the version this job belongs to; StageContext.open resolves a missing one to the current
    let current: StageContext | undefined; // this attempt's context: its idle timeout and finished steps decide what a failure means
    return runTracked(job, queue, {}, async () => {
      try {
        const prev = job.retryCount ? await previousAttempt(svc, job.id) : undefined;
        log.info(
          { attempt, maxAttempts: max + 1, seq, ...(prev ? { previousAttempt: prev, interrupted: interrupted(prev) } : {}) },
          job.retryCount ? "job retry" : "job start",
        );
        const t0 = Date.now();
        await measured(svc, stage, { projectId }, () =>
          withSpan(`pipeline.${stage}`, { "reelsaw.project_id": projectId, "reelsaw.attempt": attempt }, () =>
            withLlmContext({ projectId, stage, jobId: job.id }, async () => {
              const ctx = await StageContext.open(svc, projectId, stage, job.signal, { jobId: job.id, queue }, seq);
              current = ctx;
              seq = ctx.seq;
              try {
                return await fn(ctx);
              } finally {
                await ctx.close(); // the disk it leased and the idle timer, however the stage ended
              }
            }),
          ),
        );
        log.info({ ms: Date.now() - t0 }, "job done");
      } catch (thrown) {
        // the stage idled out: that, not whatever the abort surfaced as inside a model call, is why it ended (unless the
        // handler itself saw the project deleted or the job superseded: that is not a failure)
        const err = thrown instanceof ProjectGoneError || thrown instanceof StaleJobError ? thrown : (current?.timedOut ?? thrown);
        if (err instanceof ProjectGoneError) return log.warn({ reason: err.message }, "job skipped");
        // cancelling a pg-boss job does not stop a running handler: the superseded one ends here, writing nothing
        if (err instanceof StaleJobError) return log.info({ reason: err.message, seq }, "job skipped: superseded");
        // disk will not free itself on the next attempt here: fail the run, unless another worker has the room
        const handOff = err instanceof ResourceExhaustedError && job.retryCount < max ? await diskHandOff(gate, queue, err, log) : null;
        const noDisk = err instanceof ResourceExhaustedError && !handOff;
        // a video refused for its length, a source that is gone: trying again changes nothing, so the run fails now
        const permanent = err instanceof NonRetryableError;
        const progressed = (current?.stepsCompleted ?? 0) > 0;
        const outcome = attemptOutcome({ progressed, retryable: !permanent && !noDisk, nonRetryable: permanent });
        const limit = permanent || noDisk ? max : await jobRetryLimit(svc, job.id, max);
        const last = permanent || noDisk || (outcome !== "requeue" && job.retryCount >= limit);
        // a fault on its last attempt is an error (log.ts reports it); a retry still to come, or a refusal, is not
        log[last && !permanent ? "error" : "warn"]({ err, attempt, maxAttempts: max + 1 }, "job failed");
        if (last) {
          await failProject(svc, projectId, stage, err, seq);
        } else {
          if (outcome === "requeue") {
            log.warn({ attempt, seq, steps: current?.stepsCompleted }, "attempt made progress; re-queueing with a fresh budget");
            await grantRetry(svc, job.id);
          }
          await stageFailedAttempt(svc, projectId, stage, handOff ?? err, attempt, limit + 1 + (outcome === "requeue" ? 1 : 0), seq);
        }
        // returning marks the job done so a shortfall does not loop on this worker
        if (permanent || noDisk) return;
        throw handOff ?? err; // let pg-boss apply the retry policy
      }
    });
  };
}

export async function startWorkers(svc: Services): Promise<{ diskGate: DiskGate }> {
  const { boss } = svc.queue;
  const common = { pollingIntervalSeconds: 2 };
  // every queue's registration, so the disk gate can take a queue off this process and put it back
  const registrations = new Map<QueueName, () => Promise<void>>();
  let concurrency = 0;
  const work = async <T extends ProjectJob>(
    queue: QueueName,
    options: { pollingIntervalSeconds: number; localConcurrency: number },
    handler: (jobs: Job<T>[]) => Promise<void>,
  ) => {
    concurrency += options.localConcurrency;
    const register = () => boss.work<T>(queue, options, handler).then(() => undefined);
    registrations.set(queue, register);
    await register();
  };
  const diskGate = createDiskGate(svc, async (queue) => {
    const register = registrations.get(queue);
    if (register) await register();
  });
  setListeningQueues(() => diskGate.listening());

  await work<ProjectJob>(QUEUES.ingest, { ...common, localConcurrency: 2 }, projectStage(svc, diskGate, QUEUES.ingest, "ingest", ingest));
  await work<ProjectJob>(QUEUES.transcribe, { ...common, localConcurrency: 2 }, projectStage(svc, diskGate, QUEUES.transcribe, "transcribe", transcribe));
  await work<ProjectJob>(QUEUES.analyze, { ...common, localConcurrency: 2 }, projectStage(svc, diskGate, QUEUES.analyze, "analyze", analyze));

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
              try {
                return await fn(ctx);
              } finally {
                await ctx.release();
              }
            }),
          ),
        );
      } catch (err) {
        if (err instanceof ProjectGoneError) return;
        if (err instanceof StaleJobError) return log.info({ reason: err.message, seq }, "job skipped: superseded");
        if (err instanceof NonRetryableError) {
          // retrying cannot bring the source back: fail the step now (the project's Retry fetches it again)
          log.warn({ step, reason: err.message }, "refine step failed without retry");
          await refineStepFailed(svc, projectId, step, err, seq);
          return;
        }
        log[job.retryCount >= max ? "error" : "warn"]({ err, step, attempt: job.retryCount + 1 }, "job failed");
        if (job.retryCount >= max) {
          await refineStepFailed(svc, projectId, step, err, seq);
          return; // handled: don't make pg-boss retry further
        }
        await stageFailedAttempt(svc, projectId, "refine", err, job.retryCount + 1, max + 1, seq);
        throw err;
      }
    });
  };
  await work<ProjectJob>(QUEUES.refineEntities, { ...common, localConcurrency: 2 }, refineStage(QUEUES.refineEntities, "entities", refineEntities));
  await work<ProjectJob>(QUEUES.refineDisfluency, { ...common, localConcurrency: 2 }, refineStage(QUEUES.refineDisfluency, "disfluency", refineDisfluency));
  await work<ProjectJob>(QUEUES.refineScenes, { ...common, localConcurrency: 1 }, refineStage(QUEUES.refineScenes, "scenes", refineScenes));

  // clips carved out of the transcript by the user: AI packaging (and bounds for "ai" mode), then render
  await work<PrepareJob>(QUEUES.prepare, { ...common, localConcurrency: 2 }, async (jobs: Job<PrepareJob>[]) => {
    const job = jobs[0]!;
    const { projectId, clipId, mode } = job.data;
    const max = svc.queue.retryLimitOf(QUEUES.prepare);
    const log = svc.log.child({ module: "worker", queue: QUEUES.prepare, jobId: job.id, projectId, clipId, mode });
    return runTracked(job, QUEUES.prepare, { clipId }, async () => {
      try {
        const prev = job.retryCount ? await previousAttempt(svc, job.id) : undefined;
        log.info(
          { attempt: job.retryCount + 1, maxAttempts: max + 1, ...(prev ? { previousAttempt: prev, interrupted: interrupted(prev) } : {}) },
          job.retryCount ? "job retry" : "job start",
        );
        if (prev)
          await svc.events
            .emit(projectId, "clip.retrying", {
              clipId,
              step: "prepare",
              attempt: job.retryCount + 1,
              max: max + 1,
              reason: interrupted(prev) ? "interrupted (worker restarted or crashed)" : prev.slice(0, 300),
            })
            .catch(() => {});
        await measured(svc, "prepare", { projectId, clipId }, () =>
          withSpan("pipeline.prepare", { "reelsaw.project_id": projectId, "reelsaw.clip_id": clipId }, () =>
            withLlmContext({ projectId, clipId, stage: "prepare", jobId: job.id }, async () => {
              const ctx = await StageContext.open(svc, projectId, "render", job.signal, { jobId: job.id, clipId, queue: QUEUES.prepare });
              try {
                await prepareClip(ctx, clipId, mode);
              } finally {
                await ctx.close(); // the disk it leased and the idle timer
              }
            }),
          ),
        );
      } catch (err) {
        if (err instanceof ProjectGoneError) return;
        if (err instanceof NonRetryableError) {
          log.warn({ reason: err.message }, "prepare failed without retry");
          await markClipFailed(svc, projectId, clipId, err);
          return; // handled: retrying cannot bring the source back
        }
        log[job.retryCount >= max ? "error" : "warn"]({ err, attempt: job.retryCount + 1 }, "job failed");
        // short of disk even after eviction: with another worker that has room, pause this one so the retry lands there
        if (err instanceof ResourceExhaustedError) await diskGate.handOff(QUEUES.prepare, err.requiredMB);
        if (job.retryCount >= max) {
          await markClipFailed(svc, projectId, clipId, err, undefined, { ifStatus: "preparing" });
        }
        throw err;
      }
    });
  });

  // slots up to the machine's ceiling; renderSlot() decides how many actually run (CPU and memory now)
  await work<RenderJob>(QUEUES.render, { ...common, localConcurrency: svc.resources.maxRenders() }, async (jobs: Job<RenderJob>[]) => {
    const job = jobs[0]!;
    const { projectId, clipId, gen } = job.data;
    const max = svc.queue.retryLimitOf(QUEUES.render);
    const log = svc.log.child({ module: "worker", queue: QUEUES.render, jobId: job.id, projectId, clipId });
    return runTracked(job, QUEUES.render, { clipId }, async () => {
      try {
        const prev = job.retryCount ? await previousAttempt(svc, job.id) : undefined;
        log.info(
          { attempt: job.retryCount + 1, maxAttempts: max + 1, ...(prev ? { previousAttempt: prev, interrupted: interrupted(prev) } : {}) },
          job.retryCount ? "job retry" : "job start",
        );
        if (prev)
          await svc.events
            .emit(projectId, "clip.retrying", {
              clipId,
              step: "render",
              attempt: job.retryCount + 1,
              max: max + 1,
              reason: interrupted(prev) ? "interrupted (worker restarted or crashed)" : prev.slice(0, 300),
            })
            .catch(() => {});
        const release = await svc.resources.renderSlot({ signal: job.signal, onWait: (reason) => log.info({ reason }, "waiting for a render slot") });
        try {
          await measured(svc, "render", { projectId, clipId }, () =>
            withSpan("pipeline.render", { "reelsaw.project_id": projectId, "reelsaw.clip_id": clipId, "reelsaw.attempt": job.retryCount + 1 }, async () => {
              const ctx = await StageContext.open(svc, projectId, "render", job.signal, { jobId: job.id, clipId, queue: QUEUES.render });
              try {
                await renderClip(ctx, clipId, gen);
              } finally {
                await ctx.release();
              }
            }),
          );
        } finally {
          release();
        }
      } catch (err) {
        if (err instanceof ProjectGoneError) return;
        if (err instanceof NonRetryableError) {
          log.warn({ reason: err.message }, "render failed without retry");
          await markClipFailed(svc, projectId, clipId, err, gen);
          return; // handled: retrying cannot bring the source back
        }
        log[job.retryCount >= max ? "error" : "warn"]({ err, attempt: job.retryCount + 1 }, "job failed");
        if (err instanceof ResourceExhaustedError) await diskGate.handOff(QUEUES.render, err.requiredMB);
        if (job.retryCount >= max) {
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
          again: (u, o) => u.send(q.name, { event, key }, { singletonKey: key, ...(o?.delaySeconds ? { startAfterSeconds: o.delaySeconds } : {}) }),
        });
      } catch (err) {
        log.error({ err, key, attempt: job.retryCount + 1 }, "event handler failed");
        throw err;
      }
    });
  }

  // this process only; pg-boss reports the cluster-wide backlog as pgboss.queue.jobs (OTLP)
  gauge(
    "reelsaw.render.slots",
    "{render}",
    () => {
      const r = svc.resources.renders();
      return [
        [r.running, { state: "running" }],
        [r.limit, { state: "limit" }],
      ];
    },
    "Renders running in this worker and the limit CPU and memory allow right now",
  );
  gauge(
    "reelsaw.worker.jobs.active",
    "{job}",
    () => {
      const by = new Map<string, number>(Object.values(QUEUES).map((q) => [q, 0]));
      for (const j of inflightJobs()) by.set(j.queue, (by.get(j.queue) ?? 0) + 1);
      return [...by].map(([queue, n]) => [n, { queue }]);
    },
    "Jobs this worker process is running, by queue",
  );

  svc.log.info(
    {
      module: "worker",
      queues: [...Object.values(QUEUES), ...handlerQueues.map((q) => q.name)],
      renders: svc.resources.renders().mode === "auto" ? `auto, up to ${svc.resources.maxRenders()}` : svc.resources.maxRenders(),
    },
    "workers listening",
  );
  // a running job takes a pooled connection only for its writes and pg-boss needs some for fetching and heartbeats. The defaults
  // already have more job slots than connections (they are rarely all busy), so warn only when the slots are over twice the pool: more
  // than that, queries queue on the pool and a heartbeat can be missed. (Model-call slots use their own pool, ai/gate.ts.)
  if (concurrency > svc.database.poolMax * 2) {
    svc.log.warn(
      { module: "worker", jobSlots: concurrency, poolMax: svc.database.poolMax },
      "job concurrency exceeds the Postgres pool; raise DB_POOL_MAX to at least the job slots plus a few",
    );
  }
  // room is made (or the gate closes) before the first job lands, not after it fails
  await diskGate.check().catch((err) => svc.log.warn({ module: "worker", err }, "disk gate check failed"));
  return { diskGate };
}
