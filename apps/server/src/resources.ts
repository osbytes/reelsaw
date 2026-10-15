import os from "node:os";
import fs from "node:fs/promises";
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
 *   disk   – fs.statfs() on the data directory
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

export interface ResourceGovernor {
  snapshot(): Promise<ResourceSnapshot>;
  /**
   * Resolve once CPU, memory and disk are under their thresholds (plus `needDiskMB` headroom).
   * Calls `onWait` when it has to wait so the job can report progress. Throws after the max wait
   * so pg-boss can retry with backoff instead of holding the slot forever.
   */
  acquire(opts: { kind: string; needDiskMB?: number; signal?: AbortSignal; onWait?: (reason: string) => void }): Promise<void>;
  /** ffmpeg -threads value so concurrent renders share the CPUs instead of each grabbing all of them. */
  ffmpegThreads(): number;
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

export function createResourceGovernor(config: Config, dataDir: string, log: Logger): ResourceGovernor {
  const cpus = Math.max(1, os.availableParallelism());
  let lastSnapshot: ResourceSnapshot | undefined;
  let lastAt = 0;
  let prevTimes = cpuTimes();
  let prevTimesAt = Date.now();
  let cpuPercent = 0;

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

    async acquire({ kind, needDiskMB = 0, signal, onWait }) {
      const started = Date.now();
      let waited = false;
      let lastReason = "";
      for (;;) {
        if (signal?.aborted) throw new Error("job aborted while waiting for resources");
        const s = await sample();
        const reasons: string[] = [];
        if (!s.ok.cpu) reasons.push(`CPU ${s.cpuPercent}% busy on ${s.cpus} cpus`);
        if (!s.ok.memory) reasons.push(`${s.memAvailableMB} MB memory free`);
        if (s.diskFreeMB >= 0 && s.diskFreeMB < config.MIN_FREE_DISK_MB + needDiskMB) reasons.push(`${s.diskFreeMB} MB disk free, need ${config.MIN_FREE_DISK_MB + needDiskMB}`);
        if (!reasons.length) {
          if (waited) log.info({ kind, waitedSec: Math.round((Date.now() - started) / 1000) }, "resources available, proceeding");
          return;
        }
        const reason = reasons.join("; ");
        // disk never frees itself by waiting: fail fast so the operator sees it
        if (s.diskFreeMB >= 0 && s.diskFreeMB < config.MIN_FREE_DISK_MB) {
          throw new Error(`Low disk space in ${dataDir}: ${reason}. Free space or raise the volume size.`);
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
      return Math.max(1, Math.floor(cpus / Math.max(1, config.RENDER_CONCURRENCY)));
    },

    async check() {
      const s = await sample();
      if (s.diskFreeMB >= 0 && s.diskFreeMB < config.MIN_FREE_DISK_MB) {
        throw new Error(`only ${s.diskFreeMB} MB free in ${dataDir}; MIN_FREE_DISK_MB=${config.MIN_FREE_DISK_MB}`);
      }
      log.info({ platform: s.platform, cpus: s.cpus, cpuPercent: s.cpuPercent, memAvailableMB: s.memAvailableMB, memTotalMB: s.memTotalMB, diskFreeMB: s.diskFreeMB, ffmpegThreads: this.ffmpegThreads() }, "resources");
    },
  };
}
