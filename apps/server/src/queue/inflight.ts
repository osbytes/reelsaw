/**
 * Jobs this process is running right now. The worker handlers register here; the heartbeat
 * (ops/workers.ts) copies the set into `worker_instances.processing` so the admin page can show it.
 */
import type { WorkerJob } from "../db/schema.js";
import type { QueueName } from "./boss.js";

const inflight = new Map<string, WorkerJob>();

/** The queues this process listens on right now; the disk gate (queue/disk-gate.ts) narrows it while paused. */
let listening: () => QueueName[] = () => [];
export function setListeningQueues(fn: () => QueueName[]) {
  listening = fn;
}
export function listeningQueues(): QueueName[] {
  return listening();
}

export function trackJob<T>(job: WorkerJob, fn: () => Promise<T>): Promise<T> {
  inflight.set(job.jobId, job);
  return fn().finally(() => inflight.delete(job.jobId));
}

export function inflightJobs(): WorkerJob[] {
  return [...inflight.values()];
}
