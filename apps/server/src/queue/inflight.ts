/**
 * Jobs this process is running right now. The worker handlers register here; the heartbeat
 * (ops/workers.ts) copies the set into `worker_instances.processing` so the admin page can show it.
 */
import type { WorkerJob } from "../db/schema.js";

const inflight = new Map<string, WorkerJob>();

export function trackJob<T>(job: WorkerJob, fn: () => Promise<T>): Promise<T> {
  inflight.set(job.jobId, job);
  return fn().finally(() => inflight.delete(job.jobId));
}

export function inflightJobs(): WorkerJob[] {
  return [...inflight.values()];
}
