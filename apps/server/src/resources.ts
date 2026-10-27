import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";

/**
 * Samples CPU, memory and disk and gates heavy work so N concurrent ffmpeg/yt-dlp processes
 * don't push the host into swap, disk-full or CPU saturation.
 *
 * Node standard library only, so it behaves the same on Linux, macOS and Windows:
 *   CPU    – utilisation measured from os.cpus() time deltas (load average is 0 on Windows);
 *            os.availableParallelism() for the CPU count (libuv honours affinity and container quotas)
 *   memory – process.availableMemory() / process.constrainedMemory() (libuv: cgroup-aware on Linux)
 *   disk   – fs.statfs() on the data directory, net of the disk leased to jobs in flight (disk-leases.ts):
 *            statfs sees only bytes already written, so a job claims its scratch before writing it
 */
export interface ResourceSnapshot {
  at: string;
  platform: NodeJS.Platform;
  cpus: number;
  /** % of CPU time busy across all cores since the previous sample (smoothed) */
  cpuPercent: number;
  /** 1-minute load average; null where the OS has none (Windows) */
  load1: number | null;
  memTotalMB: number;
  memAvailableMB: number;
  diskFreeMB: number;
  diskTotalMB: number;
  ok: { cpu: boolean; memory: boolean; disk: boolean };
}

/** The GPU this process can see, found once at boot (nvidia-smi, /dev/nvidia*, /dev/dxg, or the Apple chip). */
export interface GpuInfo {
  vendor: "nvidia" | "apple";
  /** device names, e.g. "NVIDIA GeForce RTX 4060 (8188 MB)" or "Apple M2 Pro" */
  devices: string[];
  /** what the app itself can use it for; the LLM and whisper run in their own containers */
  note: string;
}

const execFileAsync = promisify(execFile);

/**
 * Which NVIDIA device node is mapped into this process, if any.
 * Docker Desktop on Windows (WSL2) exposes the GPU as `/dev/dxg`, not `/dev/nvidia0`.
 * `access` is injectable for tests.
 */
export async function nvidiaDeviceNode(
  access: (path: string) => Promise<boolean> = (p) => fs.access(p).then(() => true, () => false),
): Promise<"nvidia0" | "dxg" | null> {
  if (await access("/dev/nvidia0")) return "nvidia0";
  if (await access("/dev/dxg")) return "dxg";
  return null;
}

/** nvidia-smi inside the container means the NVIDIA runtime handed the GPU over; a bare device node means the card without the driver tools. */
export async function detectGpu(platform: NodeJS.Platform = process.platform, arch = process.arch): Promise<GpuInfo | null> {
  try {
    const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], { timeout: 5000 });
    const devices = stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, mem] = l.split(",").map((x) => x.trim());
        return mem ? `${name} (${mem} MB)` : name!;
      });
    if (devices.length) return { vendor: "nvidia", devices, note: "NVENC for renders when FFMPEG_ENCODER allows it; CUDA for Speaches/Ollama in their own containers" };
  } catch {
    /* no nvidia-smi: not an NVIDIA machine, or the container was started without the GPU */
  }
  if (platform === "linux") {
    const node = await nvidiaDeviceNode();
    if (node === "nvidia0") {
      return { vendor: "nvidia", devices: [], note: "/dev/nvidia0 is present but nvidia-smi is not: the device is mapped without the NVIDIA runtime's tools" };
    }
    if (node === "dxg") {
      return {
        vendor: "nvidia",
        devices: [],
        note: "/dev/dxg is present (Docker Desktop on WSL2): NVENC works when FFMPEG_ENCODER allows it; this image usually has no nvidia-smi",
      };
    }
  }
  if (platform === "darwin" && arch === "arm64") {
    return { vendor: "apple", devices: [os.cpus()[0]?.model ?? "Apple silicon"], note: "Metal is used by a native Ollama; ffmpeg can use VideoToolbox outside Docker (FFMPEG_ENCODER)" };
  }
  return null;
}

export interface ResourceGovernor {
  snapshot(): Promise<ResourceSnapshot>;
  /** the GPU found at boot, or null; see detectGpu */
  gpu(): GpuInfo | null;
  /**
   * Resolve once CPU, memory and disk are under their thresholds (plus `needDiskMB` headroom), holding a
   * lease on that `needDiskMB` until the caller releases it (a stage: when it ends, StageContext.release).
   * The check and the lease are one step against the volume's live total, so two jobs cannot both pass
   * on the same free bytes and both fail mid-write. Calls `onWait` when it has to wait so the job can
   * report progress. Throws after the max wait so pg-boss can retry with backoff instead of holding
   * the slot forever. A disk shortfall asks the reclaimer (scratch cache eviction) once; still short
   * because of the bytes on disk it throws `ResourceExhaustedError` (waiting does not free space),
   * short only because of other jobs' leases it waits for them like for CPU and memory.
   */
  acquire(opts: { kind: string; needDiskMB?: number; signal?: AbortSignal; onWait?: (reason: string) => void; ids?: { jobId?: string; projectId?: string } }): Promise<DiskLease>;
  /**
   * How a disk shortfall is answered: free at least `needBytes` of scratch (storage/sweep.ts
   * `reclaimScratch`). Set once the store and database are up; absent, a shortfall fails at once.
   */
  setReclaimer(fn: ((needBytes: number) => Promise<{ bytes: number; enough: boolean }>) | null): void;
  /**
   * The shared ledger of disk leases for `volume` (disk-leases.ts): every process on that filesystem checks
   * and records its claims there. Until it is set (boot, tests, a process without a database) this process's
   * own leases are the whole picture.
   */
  setLeaser(fn: DiskLeaser | null, volume?: string): void;
  /** the volume this process leases on (null until setLeaser) and the leases it holds right now */
  leases(): { volume: string | null; ownMB: number; own: number };
  /** Evict scratch until `diskFreeMB` is at least `targetMB` (the floor plus headroom), or nothing is left to evict. Resolves to the free MB after. */
  reclaimTo(targetMB: number): Promise<number>;
  /** ffmpeg encode `-threads` value: the CPUs shared by the renders running right now. Filtergraph threads are always 1 (see `ffmpegThreadArgs`). */
  ffmpegThreads(): number;
  /**
   * Wait for a render slot. With RENDER_CONCURRENCY=auto a render starts while fewer are running
   * than the CPUs allow (~CPUS_PER_RENDER cores each) and memory would stay above MIN_FREE_MEM_MB
   * with one more (~RENDER_MEM_MB); one render may always run. A number pins the limit instead.
   */
  renderSlot(opts: { signal?: AbortSignal; onWait?: (reason: string) => void }): Promise<() => void>;
  /** upper bound on concurrent renders in this process (worker slots to register) */
  maxRenders(): number;
  renders(): { running: number; limit: number; mode: "auto" | "fixed" };
  check(): Promise<void>;
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Cores one render keeps busy (x264 encode + decode + filters) and the memory it needs. */
export const CPUS_PER_RENDER = 2;
export const RENDER_MEM_MB = 1200;
const MAX_AUTO_RENDERS = 8;

/**
 * Disk (and only disk) will not improve by waiting, and eviction could not make room: the job should fail
 * the run on this worker (or move to a worker that has `requiredMB` free, queue/workers.ts) instead of
 * retrying here for 15 minutes.
 */
export class ResourceExhaustedError extends Error {
  readonly code = "resource_exhausted" as const;
  constructor(
    message: string,
    /** free MB this worker needs for the job (MIN_FREE_DISK_MB plus its scratch) */
    readonly requiredMB: number,
    /** free MB it has, after eviction */
    readonly freeMB: number,
  ) {
    super(message);
    this.name = "ResourceExhaustedError";
  }
}

/** Free MB required before a job that needs `extraMB` of scratch may start. */
export function requiredDiskMB(minFreeMB: number, extraMB: number) {
  return minFreeMB + extraMB;
}

/** Disk a job holds for the scratch it is about to write; `release` gives it back (idempotent). */
export interface DiskLease {
  readonly mb: number;
  release(): Promise<void>;
}

export interface DiskLeaseRequest {
  /** scratch the job will write */
  mb: number;
  /** MIN_FREE_DISK_MB plus `mb`: what must be free, net of live leases, for the job to start */
  requiredMB: number;
  /** free MB on the volume as this process measured it (never -1: an unmeasurable disk is not leased) */
  freeMB: number;
  kind: string;
  jobId?: string;
  projectId?: string;
}
export type DiskLeaseResult = { ok: true; release: () => Promise<void> } | { ok: false; leasedMB: number; jobs: number };
/** Check the request against the volume's live leases and record it, as one atomic step (disk-leases.ts). */
export type DiskLeaser = (req: DiskLeaseRequest) => Promise<DiskLeaseResult>;

/**
 * Pure: may a job that needs `requiredMB` free start when `freeMB` is free on disk and `leasedMB` of that is
 * already promised to jobs in flight (whose scratch statfs does not see yet)? An unmeasurable disk (-1) never refuses.
 */
export function leaseFits(p: { freeMB: number; leasedMB: number; requiredMB: number }): boolean {
  return p.freeMB < 0 || p.freeMB - p.leasedMB >= p.requiredMB;
}

/** Progress / log text for a job held back by other jobs' leases rather than by the bytes on disk. */
export function leaseShortReason(freeMB: number, leasedMB: number, jobs: number, requiredMB: number): string {
  return `${freeMB} MB free but ${leasedMB} MB leased to ${jobs} job${jobs === 1 ? "" : "s"} in flight, needs ${requiredMB} MB`;
}

/** Null when disk is unmeasured (`diskFreeMB < 0`) or there is enough. */
export function diskShortReason(diskFreeMB: number, minFreeMB: number, extraMB: number): string | null {
  if (diskFreeMB < 0) return null;
  const need = requiredDiskMB(minFreeMB, extraMB);
  return diskFreeMB < need ? `${diskFreeMB} MB disk free, need ${need}` : null;
}

/** How many renders may run now: pure, for tests. */
export function renderLimit(p: { cpus: number; memAvailableMB: number; running: number; minFreeMemMB: number; fixed?: number }): number {
  if (p.fixed) return p.fixed;
  const byCpu = Math.min(MAX_AUTO_RENDERS, Math.max(1, Math.floor(p.cpus / CPUS_PER_RENDER)));
  // memory already counts the renders running; room for how many more?
  const more = Math.floor((p.memAvailableMB - p.minFreeMemMB) / RENDER_MEM_MB);
  return Math.max(1, Math.min(byCpu, p.running + Math.max(0, more)));
}

export function createResourceGovernor(config: Config, dataDir: string, log: Logger): ResourceGovernor {
  const cpus = Math.max(1, os.availableParallelism());
  const fixed = config.RENDER_CONCURRENCY === "auto" ? undefined : config.RENDER_CONCURRENCY;
  let running = 0;
  let lastLimit = fixed ?? 1;
  let lastSnapshot: ResourceSnapshot | undefined;
  let lastAt = 0;
  let prevTimes = cpuTimes();
  let prevTimesAt = Date.now();
  let cpuPercent = 0;
  let gpu: GpuInfo | null = null;
  let reclaimer: ((needBytes: number) => Promise<{ bytes: number; enough: boolean }>) | null = null;
  /** one eviction at a time: concurrent jobs short of disk share the run instead of walking the same directories */
  let reclaiming: Promise<number> | null = null;
  let leaser: DiskLeaser | null = null;
  let volume: string | null = null;
  /** leases this process holds: lease id → MB (what the heartbeat reports; the whole ledger without a leaser) */
  const own = new Map<number, number>();
  let nextLease = 1;
  const ownMB = () => [...own.values()].reduce((a, b) => a + b, 0);

  /**
   * Claim `req.mb` against the volume's live leases, atomically with the check. Without a shared ledger the
   * check and the reservation are one synchronous step on this process's own map, so two concurrent
   * acquires cannot both pass on the same bytes either.
   */
  async function takeLease(req: DiskLeaseRequest): Promise<DiskLeaseResult> {
    if (leaser) return leaser(req);
    const held = ownMB();
    if (!leaseFits({ freeMB: req.freeMB, leasedMB: held, requiredMB: req.requiredMB })) return { ok: false, leasedMB: held, jobs: own.size };
    return { ok: true, release: async () => {} };
  }

  /** The lease handed to the caller: drops the entry from `own` and the ledger once, whichever way it ends. */
  function leaseHandle(mb: number, release: () => Promise<void>): DiskLease {
    if (mb <= 0) return { mb: 0, release: async () => {} };
    const id = nextLease++;
    own.set(id, mb);
    let done = false;
    return {
      mb,
      async release() {
        if (done) return;
        done = true;
        own.delete(id);
        lastAt = 0; // the next sample reads the disk again: the scratch is real (or gone) now
        await release().catch((err) => log.warn({ err, mb }, "could not release a disk lease; it expires on its own"));
      },
    };
  }

  /** Ask the reclaimer for `needMB` more, then resample. Resolves to the free MB afterwards (-1 when unmeasurable). */
  function reclaim(needMB: number): Promise<number> {
    if (reclaiming) return reclaiming;
    reclaiming = (async () => {
      try {
        if (reclaimer) {
          const r = await reclaimer(needMB * 1048576);
          log.info({ needMB, freedMB: Math.round(r.bytes / 1048576), enough: r.enough }, "evicted scratch for a job short of disk");
        }
      } catch (err) {
        log.warn({ err, needMB }, "scratch eviction failed");
      } finally {
        lastAt = 0; // the next sample reads the disk again
      }
      return (await sample()).diskFreeMB;
    })().finally(() => {
      reclaiming = null;
    });
    return reclaiming;
  }

  async function measureCpu() {
    // need a few hundred ms between readings for a meaningful ratio
    if (Date.now() - prevTimesAt < 250) await new Promise((r) => setTimeout(r, 250));
    const cur = cpuTimes();
    const dTotal = cur.total - prevTimes.total;
    const dIdle = cur.idle - prevTimes.idle;
    const now = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : cpuPercent;
    // light smoothing: one burst of ffmpeg start-up shouldn't block the queue
    cpuPercent = lastSnapshot ? cpuPercent * 0.4 + now * 0.6 : now;
    prevTimes = cur;
    prevTimesAt = Date.now();
    return cpuPercent;
  }

  async function sample(): Promise<ResourceSnapshot> {
    const now = Date.now();
    if (lastSnapshot && now - lastAt < 2000) return lastSnapshot;
    const cpu = await measureCpu();
    const constrained = process.constrainedMemory() || 0;
    const memTotal = constrained > 0 ? Math.min(constrained, os.totalmem()) : os.totalmem();
    const memAvailable = Math.min(memTotal, process.availableMemory());
    let diskFree = Number.POSITIVE_INFINITY;
    let diskTotal = 0;
    try {
      const st = await fs.statfs(dataDir);
      diskFree = st.bavail * st.bsize;
      diskTotal = st.blocks * st.bsize;
    } catch {
      /* statfs unsupported on this filesystem; treat as unlimited */
    }
    const snap: ResourceSnapshot = {
      at: new Date(now).toISOString(),
      platform: process.platform,
      cpus,
      cpuPercent: Math.round(cpu),
      load1: process.platform === "win32" ? null : Number((os.loadavg()[0] ?? 0).toFixed(2)),
      memTotalMB: Math.round(memTotal / 1048576),
      memAvailableMB: Math.round(memAvailable / 1048576),
      diskFreeMB: Number.isFinite(diskFree) ? Math.round(diskFree / 1048576) : -1,
      diskTotalMB: Math.round(diskTotal / 1048576),
      ok: {
        cpu: cpu <= config.MAX_CPU_PERCENT,
        memory: memAvailable / 1048576 >= config.MIN_FREE_MEM_MB,
        disk: !Number.isFinite(diskFree) || diskFree / 1048576 >= config.MIN_FREE_DISK_MB,
      },
    };
    lastSnapshot = snap;
    lastAt = now;
    return snap;
  }

  return {
    snapshot: sample,
    gpu: () => gpu,

    setReclaimer(fn) {
      reclaimer = fn;
    },

    setLeaser(fn, vol) {
      leaser = fn;
      volume = fn ? (vol ?? null) : null;
    },

    leases() {
      return { volume, ownMB: ownMB(), own: own.size };
    },

    async reclaimTo(targetMB) {
      const free = (await sample()).diskFreeMB;
      if (free < 0 || free >= targetMB) return free;
      return reclaim(targetMB - free);
    },

    async acquire({ kind, needDiskMB = 0, signal, onWait, ids }) {
      const started = Date.now();
      let waited = false;
      let reclaimed = false;
      let lastReason = "";
      for (;;) {
        if (signal?.aborted) throw new Error("job aborted while waiting for resources");
        const s = await sample();
        const reasons: string[] = [];
        if (!s.ok.cpu) reasons.push(`CPU ${s.cpuPercent}% busy on ${s.cpus} cpus`);
        if (!s.ok.memory) reasons.push(`${s.memAvailableMB} MB memory free`);
        const required = requiredDiskMB(config.MIN_FREE_DISK_MB, needDiskMB);
        const disk = diskShortReason(s.diskFreeMB, config.MIN_FREE_DISK_MB, needDiskMB);
        if (disk) reasons.push(disk);
        /** short only because of other jobs' leases: the bytes are free, but promised */
        let leased: { leasedMB: number; jobs: number } | null = null;
        if (!reasons.length) {
          // everything fits on paper: claim the scratch now, in the same step as the check against the
          // leases already out, so a second job cannot pass on the bytes this one is about to write
          const r = needDiskMB > 0 && s.diskFreeMB >= 0 ? await takeLease({ mb: needDiskMB, requiredMB: required, freeMB: s.diskFreeMB, kind, ...ids }) : ({ ok: true, release: async () => {} } as const);
          if (r.ok) {
            if (waited) log.info({ kind, waitedSec: Math.round((Date.now() - started) / 1000) }, "resources available, proceeding");
            return leaseHandle(needDiskMB > 0 && s.diskFreeMB >= 0 ? needDiskMB : 0, r.release);
          }
          leased = r;
          reasons.push(leaseShortReason(s.diskFreeMB, r.leasedMB, r.jobs, required));
        }
        const reason = reasons.join("; ");
        // disk never frees itself by waiting — including the extra scratch on top of MIN_FREE_DISK_MB.
        // waiting 900s then retrying looked like a "Downloading…" loop on a full worker volume.
        // What can free it is evicting scratch copies the store still has: once, then give up here.
        // Space other jobs have leased is different: it comes back when they end, so that one waits.
        if (disk || leased) {
          if (!reclaimed && reclaimer) {
            reclaimed = true;
            log.warn({ kind, reason }, "short of disk, evicting scratch");
            onWait?.(`Freeing disk: ${reason}`);
            await reclaim(required - (s.diskFreeMB - (leased?.leasedMB ?? 0)));
            continue;
          }
          if (disk) throw new ResourceExhaustedError(`Not enough disk in ${dataDir}: ${reason}. Free space or raise the volume size.`, required, s.diskFreeMB);
        }
        if (Date.now() - started > config.RESOURCE_WAIT_MAX_SECONDS * 1000) {
          throw new Error(`Gave up waiting ${config.RESOURCE_WAIT_MAX_SECONDS}s for resources before ${kind}: ${reason}`);
        }
        if (reason !== lastReason) {
          lastReason = reason;
          log.warn({ kind, reason }, "waiting for resources");
          onWait?.(reason);
        }
        waited = true;
        await new Promise((r) => setTimeout(r, 5000));
      }
    },

    ffmpegThreads() {
      // encode cores only; the filtergraph is always single-threaded (ffmpegThreadArgs)
      return Math.max(1, Math.floor(cpus / Math.max(1, running)));
    },

    maxRenders() {
      return fixed ?? Math.min(MAX_AUTO_RENDERS, Math.max(1, Math.floor(cpus / CPUS_PER_RENDER)));
    },

    renders() {
      return { running, limit: lastLimit, mode: fixed ? "fixed" : "auto" };
    },

    async renderSlot({ signal, onWait }) {
      const started = Date.now();
      let lastReason = "";
      for (;;) {
        if (signal?.aborted) throw new Error("job aborted while waiting for a render slot");
        const s = await sample();
        lastLimit = renderLimit({ cpus, memAvailableMB: s.memAvailableMB, running, minFreeMemMB: config.MIN_FREE_MEM_MB, fixed });
        if (running < lastLimit) {
          running++;
          let released = false;
          return () => {
            if (!released) (released = true), running--;
          };
        }
        if (Date.now() - started > config.RESOURCE_WAIT_MAX_SECONDS * 1000) throw new Error(`Gave up waiting ${config.RESOURCE_WAIT_MAX_SECONDS}s for a render slot (${running} running)`);
        const reason = `${running} render${running === 1 ? "" : "s"} running, room for ${lastLimit} (${s.cpus} CPUs, ${s.memAvailableMB} MB free)`;
        if (reason !== lastReason) {
          lastReason = reason;
          onWait?.(`Waiting for a render slot: ${reason}`);
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
    },

    async check() {
      const s = await sample();
      if (s.diskFreeMB >= 0 && s.diskFreeMB < config.MIN_FREE_DISK_MB) {
        // a process that runs no workers writes no scratch: refusing to boot would lock out the admin UI that can free the disk
        if (!config.RUN_WORKERS) log.warn({ diskFreeMB: s.diskFreeMB, minFreeMB: config.MIN_FREE_DISK_MB, dataDir }, "free disk is below MIN_FREE_DISK_MB; starting anyway because this process runs no workers (an admin can still reach the UI to free space)");
        else throw new Error(`only ${s.diskFreeMB} MB free in ${dataDir}; MIN_FREE_DISK_MB=${config.MIN_FREE_DISK_MB}`);
      }
      gpu = await detectGpu();
      log.info({ platform: s.platform, cpus: s.cpus, cpuPercent: s.cpuPercent, memAvailableMB: s.memAvailableMB, memTotalMB: s.memTotalMB, diskFreeMB: s.diskFreeMB, gpu: gpu ? `${gpu.vendor}: ${gpu.devices.join(", ") || "device without tools"}` : "none", renders: fixed ? `fixed ${fixed}` : `auto, up to ${this.maxRenders()}` }, "resources");
    },
  };
}
