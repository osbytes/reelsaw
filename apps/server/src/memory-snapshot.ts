/**
 * Memory at the moment a child process was killed, so "stopped by SIGKILL" can be told apart: the container's
 * memory limit (the cgroup's OOM killer counted a kill) or something else (a stop from outside, a host-level kill).
 * cgroup v2 files only (Docker, Railway); elsewhere the cgroup fields are left out.
 */
import fs from "node:fs/promises";
import os from "node:os";

const CGROUP = "/sys/fs/cgroup";
const MB = 1048576;

async function readText(file: string): Promise<string | undefined> {
  try {
    return (await fs.readFile(file, "utf8")).trim();
  } catch {
    return undefined;
  }
}

/** A cgroup memory file in MB; "max" (no limit) and missing files are undefined. */
async function cgroupMB(name: string, dir = CGROUP): Promise<number | undefined> {
  const t = await readText(`${dir}/${name}`);
  const n = Number(t);
  return t && t !== "max" && Number.isFinite(n) ? Math.round(n / MB) : undefined;
}

/** Kills the cgroup's OOM killer has made so far (memory.events `oom_kill`); undefined off cgroup v2. */
export async function oomKillCount(dir = CGROUP): Promise<number | undefined> {
  const t = await readText(`${dir}/memory.events`);
  const m = t ? /^oom_kill (\d+)$/m.exec(t) : null;
  return m ? Number(m[1]) : undefined;
}

interface MemorySnapshot {
  rssMB: number;
  hostFreeMB: number;
  hostTotalMB: number;
  cgroupCurrentMB?: number;
  cgroupMaxMB?: number;
  cgroupPeakMB?: number;
  oomKills?: number;
}

export async function memorySnapshot(dir = CGROUP): Promise<MemorySnapshot> {
  const [current, max, peak, oomKills] = await Promise.all([
    cgroupMB("memory.current", dir),
    cgroupMB("memory.max", dir),
    cgroupMB("memory.peak", dir),
    oomKillCount(dir),
  ]);
  return {
    rssMB: Math.round(process.memoryUsage().rss / MB),
    hostFreeMB: Math.round(os.freemem() / MB),
    hostTotalMB: Math.round(os.totalmem() / MB),
    ...(current !== undefined ? { cgroupCurrentMB: current } : {}),
    ...(max !== undefined ? { cgroupMaxMB: max } : {}),
    ...(peak !== undefined ? { cgroupPeakMB: peak } : {}),
    ...(oomKills !== undefined ? { oomKills } : {}),
  };
}
