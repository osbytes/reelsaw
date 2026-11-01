/**
 * One worker short of disk must not take the whole fleet down with it. This process keeps a gate
 * on the queues whose jobs write scratch (ingest, transcribe, refine.scenes, analyze, prepare, render):
 *
 *   - every DISK_GATE_INTERVAL_MS it looks at free disk; below the floor plus headroom it evicts
 *     scratch copies the store still has (resources.reclaimTo), so room is made before a job lands,
 *     not after it fails;
 *   - when eviction cannot reach the floor and another live worker has the room, it pauses those
 *     queues (pg-boss `offWork`, without waiting: it is also called from inside a job's handler, which
 *     the wait would deadlock on): jobs stay queued for the other workers, and this one keeps serving
 *     the transcript-only refine queues (entities, disfluency), which need no scratch. Alone (a single
 *     box, or every worker full) it does not pause: a job then fails fast with the disk message, which
 *     is more useful than a project sitting on "queued" with nobody to take it;
 *   - once free disk is back above the floor plus headroom (an operator freed space, retention or
 *     the sweep ran, the volume grew) it registers the queues again;
 *   - while paused, each check also looks for the peer that justified pausing: when no other live
 *     worker has room for the smallest disk requirement any more (it crashed, stopped, filled up or
 *     paused itself) this one registers the queues again anyway, because a stuck queue is worse than
 *     a failing job.
 *
 * A job that still hits a shortfall (`ResourceExhaustedError`) asks `handOff`: if another live
 * worker has the room, the job is thrown back for pg-boss to retry (with this worker paused,
 * that retry lands elsewhere); if nobody has it, the run fails with the reason, as before.
 */
import type { Services } from "../services.js";
import { QUEUES, type QueueName } from "./boss.js";
import { workerWithRoom } from "../ops/workers.js";

/**
 * Queues whose jobs copy or write media under DATA_DIR. The transcript-only refine queues (entities, disfluency) are not
 * here; refine.scenes is, because it reads the full source (pulled from the store, then ffmpeg and OCR).
 */
export const DISK_QUEUES: readonly QueueName[] = [QUEUES.ingest, QUEUES.transcribe, QUEUES.refineScenes, QUEUES.analyze, QUEUES.prepare, QUEUES.render];
export const DISK_GATE_INTERVAL_MS = 30_000;
/** Free MB wanted above MIN_FREE_DISK_MB before the gate reopens, so it does not flap on one small job. */
export const DISK_GATE_HEADROOM_MB = 1024;

export interface DiskGateState {
  paused: boolean;
  /** free MB at the last check (-1 unmeasurable) */
  freeMB: number;
  /** when the gate last paused or resumed */
  changedAt: string | null;
}

export interface DiskGate {
  state(): DiskGateState;
  /** queues this process listens on right now (for the heartbeat and `list_workers`) */
  listening(): QueueName[];
  /** sample, evict below the floor, pause (when another worker has room) or resume accordingly */
  check(): Promise<DiskGateState>;
  /**
   * A job on this worker could not get `requiredMB` free. The other live worker listening on
   * `queue` that has it, in which case this worker pauses its disk queues and the caller throws
   * the job back for a retry there; null when nobody does and the run should fail here.
   */
  handOff(queue: QueueName, requiredMB: number): Promise<{ workerId: string } | null>;
  stop(): void;
}

/** Pure: which queues to listen on given the gate. */
export function listeningQueues(all: readonly QueueName[], paused: boolean): QueueName[] {
  return paused ? all.filter((q) => !DISK_QUEUES.includes(q)) : [...all];
}

/** Pure: what the gate should do at `freeMB`. "pause" still needs another worker with room (checked by the caller). */
export function gateDecision(p: { freeMB: number; paused: boolean; minFreeMB: number; headroomMB?: number }): "pause" | "resume" | "keep" {
  if (p.freeMB < 0) return p.paused ? "resume" : "keep"; // unmeasurable disk never pauses
  const floor = p.minFreeMB + (p.headroomMB ?? DISK_GATE_HEADROOM_MB);
  if (!p.paused && p.freeMB < p.minFreeMB) return "pause";
  if (p.paused && p.freeMB >= floor) return "resume";
  return "keep";
}

export function createDiskGate(svc: Services, register: (queue: QueueName) => Promise<void>): DiskGate {
  const log = svc.log.child({ module: "worker" });
  let paused = false;
  let freeMB = -1;
  let changedAt: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let busy: Promise<DiskGateState> | null = null;

  async function pause(reason: string, workerId: string) {
    if (paused) return;
    paused = true;
    changedAt = new Date().toISOString();
    // wait: false is required, not an optimisation. pause() runs from inside a job's catch block (handOff), and pg-boss 12's
    // offWork defaults to { wait: true }: it awaits the worker's run loop, which is awaiting the very handler that called
    // us. That is a self-deadlock (the job never returns, its heartbeat expires, the retry lands here and hangs again).
    // With wait: false the worker stops fetching and the running handler, this one included, finishes on its own.
    for (const q of DISK_QUEUES) await svc.queue.boss.offWork(q, { wait: false }).catch((err) => log.warn({ err, queue: q }, "could not pause a queue"));
    log.warn(
      { reason, freeMB, minFreeMB: svc.config.MIN_FREE_DISK_MB, paused: DISK_QUEUES, workerWithRoom: workerId },
      "paused disk queues on this worker: not enough disk, nothing left to evict, another worker has room",
    );
  }

  const roomElsewhere = (queue: QueueName, requiredMB: number) =>
    workerWithRoom(svc, queue, requiredMB).catch((err) => {
      log.warn({ err }, "could not look for a worker with room");
      return null;
    });

  async function resume(why?: string) {
    if (!paused) return;
    paused = false;
    changedAt = new Date().toISOString();
    for (const q of DISK_QUEUES) await register(q);
    if (why)
      log.warn(
        { reason: why, freeMB, minFreeMB: svc.config.MIN_FREE_DISK_MB },
        "resumed disk queues on this worker: no other worker can take the work, so jobs fail fast here instead of waiting",
      );
    else log.warn({ freeMB, minFreeMB: svc.config.MIN_FREE_DISK_MB }, "resumed disk queues on this worker: disk is back above the floor");
  }

  async function check(): Promise<DiskGateState> {
    const minFreeMB = svc.config.MIN_FREE_DISK_MB;
    // below the floor plus headroom: make room now, before a job needs it (a no-op with the local store)
    freeMB = await svc.resources.reclaimTo(minFreeMB + DISK_GATE_HEADROOM_MB);
    const d = gateDecision({ freeMB, paused, minFreeMB });
    if (d === "pause") {
      // only when someone can take the work: alone, a job fails fast with the disk message instead of waiting on "queued"
      const other = await roomElsewhere(QUEUES.ingest, minFreeMB);
      if (other) await pause(`${freeMB} MB free, floor ${minFreeMB}`, other.workerId);
    } else if (d === "resume") await resume();
    else if (paused) {
      // still below the reopen line. A stuck queue is worse than a failing job, so when the peer that justified pausing is
      // gone (crashed, stopped, full itself, or paused its own disk queues) take the work back and let a job fail fast with
      // the disk message. A failed lookup keeps the gate as it is: not knowing is not a reason to reopen.
      const other = await workerWithRoom(svc, QUEUES.ingest, minFreeMB).then(
        (w) => ({ known: true as const, w }),
        (err) => {
          log.warn({ err }, "could not look for a worker with room");
          return { known: false as const, w: null };
        },
      );
      if (other.known && !other.w) await resume(`${freeMB} MB free, floor ${minFreeMB}, but no other live worker has room for the queues`);
    }
    return gate.state();
  }

  const gate: DiskGate = {
    state: () => ({ paused, freeMB, changedAt }),
    listening: () => listeningQueues(Object.values(QUEUES), paused),
    check: () => (busy ??= check().finally(() => (busy = null))),
    async handOff(queue, requiredMB) {
      const other = await roomElsewhere(queue, requiredMB);
      if (other) await pause(`a job needed ${requiredMB} MB free`, other.workerId);
      return other;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
  timer = setInterval(() => void gate.check().catch((err) => log.warn({ err }, "disk gate check failed")), DISK_GATE_INTERVAL_MS);
  timer.unref();
  return gate;
}
