import os from "node:os";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";
import { plural } from "@reelsaw/shared";

/**
 * Samples CPU, memory and disk and gates heavy work so N concurrent ffmpeg/yt-dlp processes
 * don't push the host into swap, disk-full or CPU saturation.
 *
 * Node standard library only, so it behaves the same on Linux, macOS and Windows:
 *   CPU    – utilisation measured from os.cpus() time deltas (load average is 0 on Windows);
 *            os.availableParallelism() for the CPU count (libuv honours affinity and container quotas)
 *   memory – process.availableMemory() / process.constrainedMemory() (libuv: cgroup-aware on Linux)
 *   disk   – fs.statfs() on the data directory, net of the disk leased to jobs in flight
 *
 * and leases them (resource-leases.ts, docs/specs/resource-leases.md): a job claims the scratch, cores and
 * memory it is about to use against what the host's other jobs hold, in one step, because a reading shows only
 * what has already started. `acquire` (a stage's disk), `withCpu` (an ffmpeg pass's threads) and `renderSlot`
 * (a render's memory and its place among the host's renders) are the three shapes of that one claim.
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

/** What a process is short of, so heavy jobs wait on it (memory first, then CPU, then disk); null when it has room. */
export type PausedReason = "memory" | "CPU" | "disk";
export function pausedReason(s: Pick<ResourceSnapshot, "ok">): PausedReason | null {
  return !s.ok.memory ? "memory" : !s.ok.cpu ? "CPU" : !s.ok.disk ? "disk" : null;
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
  access: (path: string) => Promise<boolean> = (p) =>
    fs.access(p).then(
      () => true,
      () => false,
    ),
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
    if (devices.length)
      return { vendor: "nvidia", devices, note: "NVENC for renders when FFMPEG_ENCODER allows it; CUDA for Speaches/Ollama in their own containers" };
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
    return {
      vendor: "apple",
      devices: [os.cpus()[0]?.model ?? "Apple silicon"],
      note: "Metal is used by a native Ollama; ffmpeg can use VideoToolbox outside Docker (FFMPEG_ENCODER)",
    };
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
  acquire(opts: { kind: string; needDiskMB?: number; signal?: AbortSignal; onWait?: (reason: string) => void; ids?: LeaseIds }): Promise<Lease>;
  /**
   * How a disk shortfall is answered: free at least `needBytes` of scratch (storage/sweep.ts
   * `reclaimScratch`). Set once the store and database are up; absent, a shortfall fails at once.
   */
  setReclaimer(fn: ((needBytes: number) => Promise<{ bytes: number; enough: boolean }>) | null): void;
  /**
   * The shared ledger of leases (resource-leases.ts): disk is checked against every process on `volume`, cores
   * and memory against every process on `machine`. Until it is set (boot, tests, a process without a database)
   * this process's own leases are the whole picture.
   */
  setLeaser(fn: Leaser | null, scope?: { volume: string; machine: string }): void;
  /** where this process leases (null until setLeaser) and what the leases it holds right now add up to */
  leases(): { volume: string | null; machine: string | null; ownMB: number; own: number; ownCores: number; ownMemMB: number };
  /**
   * The ledger rows of the leases this process still holds. Any other row of this worker is one whose release
   * failed (a database blip at the delete): the heartbeat drops those (resource-leases.ts `dropLeakedLeases`)
   * instead of letting them count until they expire a day later.
   */
  ownLeaseIds(): number[];
  /** Evict scratch until `diskFreeMB` is at least `targetMB` (the floor plus headroom), or nothing is left to evict. Resolves to the free MB after. */
  reclaimTo(targetMB: number): Promise<number>;
  /**
   * Lease cores for one ffmpeg pass and run `fn` with the grant (`cpuGrant` against the host's live leases, so a
   * pass starting beside others sees their claims), releasing them however it ends. Never waits: the grant is at
   * least the request's `min`, or with an account's ceiling or reserve (hosted plans) at least one thread.
   */
  withCpu<T>(req: { kind: string; cpu: CpuAsk; ids?: LeaseIds }, fn: (cores: number) => Promise<T>): Promise<T>;
  /** The cores of the pool `withCpu` grants from: every core of this host less one. */
  cpuCapacity(): number;
  /**
   * A render encode's request: the pool (`cpuCapacity`) shared by the renders running on the host right now
   * (x264/NVENC `-threads`; filtergraph threads are always 1, see `filterThreadArgs`).
   */
  renderEncodeCpu(): CpuAsk;
  /**
   * Wait for a render slot. With RENDER_CONCURRENCY=auto a render starts while fewer are running
   * than the CPUs allow (~CPUS_PER_RENDER cores each) and memory would stay above MIN_FREE_MEM_MB
   * with one more (~RENDER_MEM_MB); one render may always run. A number pins the limit instead.
   */
  renderSlot(opts: { signal?: AbortSignal; onWait?: (reason: string) => void; ids?: LeaseIds; deferrals?: number }): Promise<() => void>;
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

/** Who a lease is for, recorded on the ledger row. */
export interface LeaseIds {
  jobId?: string | undefined;
  projectId?: string | undefined;
  /** the account, when the work is one account's (plan ceilings sum by it, docs/specs/resource-leases.md slice 3) */
  userId?: string | undefined;
}

/** What a job holds until `release` gives it back (idempotent): scratch disk, cores and memory. */
export interface Lease {
  readonly kind: string;
  readonly mb: number;
  readonly cores: number;
  readonly memMB: number;
  release(): Promise<void>;
}
/** The disk half of a lease (a stage's scratch). */
export type DiskLease = Lease;

/** Everything leased on a host right now: totals and how many leases of each kind. */
export interface HostLeases {
  mb: number;
  cores: number;
  memMB: number;
  /** every lease out */
  jobs: number;
  /** leases that hold disk */
  diskJobs: number;
  kinds: Record<string, number>;
  /** cores on the machine held by leases the paid reserve applies to (hosted Free accounts'); absent = 0 */
  reservedCores?: number;
}
export const NO_LEASES: HostLeases = { mb: 0, cores: 0, memMB: 0, jobs: 0, diskJobs: 0, kinds: {} };

/**
 * The kind of a render job's slot lease (`renderSlot`): what the host's render count is read from. Its own name,
 * never "render": a render stage's disk lease is kind "render" too, and counting both made every render count twice
 * (half the encode threads, half the render limit).
 */
export const RENDER_SLOT_KIND = "render-slot";

/** A CPU request, or one that depends on what is out (a render encode's share of the host's renders). */
export type CpuAsk = CpuRequest | ((live: HostLeases) => CpuRequest);

/** One claim on a host. Every field is optional: a stage's disk, an ffmpeg pass's cores, a render's memory. */
export interface LeaseRequest {
  kind: string;
  mb?: number;
  memMB?: number;
  cpu?: CpuAsk;
  /** the pool `cpu` is granted from (`cpuCapacity` of this host) */
  capacity?: number;
  ids?: LeaseIds | undefined;
  /** why the claim does not fit what is out, or null when it does; checked in the same step as the record */
  admit?: ((live: HostLeases) => string | null) | undefined;
  /** times this job already went back to the queue for its account's capacity (`AccountCeilingError`); past RESERVE_BYPASS_DEFERRALS the reserve no longer holds it */
  deferrals?: number | undefined;
}
/** Which account bound refused a claim: its own plan ceiling, or the cores a machine keeps for paid plans. */
type AccountBound = "ceiling" | "reserve";

/**
 * `account`: refused by the account's own ceiling or the paid reserve (`AccountLimits`), not by the host. Waiting in
 * the worker slot would hold it while other accounts' jobs queue behind it, so the job goes back to the queue instead.
 */
export type LeaseRefusal = { ok: false; reason: string; live: HostLeases; account?: AccountBound };
type LeaseClaim = { ok: true; mb: number; cores: number; memMB: number } | LeaseRefusal;
/** `id` is the ledger row, so the heartbeat can drop a row whose release never reached the database (`ownLeaseIds`). */
export type LeaseResult = { ok: true; id?: number; mb: number; cores: number; memMB: number; release: () => Promise<void> } | LeaseRefusal;
/** Check a request against the host's live leases and record it, as one atomic step (resource-leases.ts). */
export type Leaser = (req: LeaseRequest) => Promise<LeaseResult>;

/**
 * One account's bounds in the lease step (hosted plans, EE: docs/specs/resource-leases.md slice 3) and what its live
 * leases hold, summed over every machine. Absent (self-hosted, an admin, work that is no one account's): the host's
 * capacity is the only limit.
 */
export interface AccountLimits {
  /** the most cores / MB of memory its leases hold at once; null = no ceiling (only the reserve applies) */
  ceiling: { maxCores: number; maxMemMB: number } | null;
  /** its leases leave this many of the machine's cores free (hosted Free: FREE_RESERVE_CORES) */
  reserveCores: number;
  /** what its live leases hold now */
  live: { cores: number; memMB: number };
}

/**
 * Pure: what a request is granted against `live`, or why it is refused. The ledger and the in-process pool both decide
 * with this. With `account` (EE), two more bounds, checked in the same step:
 * - cores: the grant is kept within the account's ceiling and above the machine's reserve, down to 1 thread. Every
 *   CPU pass is elastic here: thread count never changes the output, and a pass never waits for cores.
 * - memory (a render's slot): fixed work. One that would take the account past its memory ceiling, or a reserved
 *   account's that would start while paid leases' cores already reach into the reserve, is refused with
 *   `account`, and the caller sends the job back to the queue (`AccountCeilingError`). An account holding nothing may
 *   always take one, so a ceiling below one render's size never locks it out. The reserve is a soft bound: a job sent
 *   back RESERVE_BYPASS_DEFERRALS times passes it (still within its ceiling), so busy paid work delays Free work but
 *   never starves it.
 */
export function claimOnLive(req: LeaseRequest, live: HostLeases, account?: AccountLimits | null): LeaseClaim {
  const reason = req.admit?.(live) ?? null;
  if (reason) return { ok: false, reason, live };
  const memMB = Math.max(0, Math.round(req.memMB ?? 0));
  const capacity = req.capacity ?? 1;
  if (account && memMB > 0) {
    const refusal = accountRefusal({ memMB, capacity, hostCores: live.cores, reservedCores: live.reservedCores ?? 0, account, deferrals: req.deferrals ?? 0 });
    if (refusal) return { ok: false, reason: refusal.reason, live, account: refusal.bound };
  }
  const want = typeof req.cpu === "function" ? req.cpu(live) : req.cpu;
  let cores = want ? cpuGrant({ capacity, leased: live.cores, ...want }) : 0;
  if (want && account) cores = accountCores({ granted: cores, capacity, hostCores: live.cores, account });
  return { ok: true, mb: Math.max(0, Math.round(req.mb ?? 0)), cores, memMB };
}

/** Pure: a CPU grant kept within the account's ceiling and above the machine's reserve, never below 1 thread or above `granted`. */
function accountCores(p: { granted: number; capacity: number; hostCores: number; account: AccountLimits }): number {
  const a = p.account;
  const reserve = reserveOf(a, p.capacity);
  const byCeiling = a.ceiling ? a.ceiling.maxCores - a.live.cores : Number.POSITIVE_INFINITY;
  const byReserve = reserve > 0 ? p.capacity - reserve - p.hostCores : Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(p.granted, byCeiling, byReserve));
}

/**
 * How many times a job may be sent back by the paid reserve before it passes it: aging, so a Free render under
 * sustained paid load is delayed a few minutes, never starved. Its own ceiling still holds (that frees as its own
 * work ends).
 */
export const RESERVE_BYPASS_DEFERRALS = 3;

/** Pure: why fixed-size work (`memMB`, a render's slot) may not start for this account now, and which bound, or null. */
function accountRefusal(p: {
  memMB: number;
  capacity: number;
  hostCores: number;
  /** of `hostCores`, what reserved (Free) accounts' leases hold: elastic grants that shrink, so they never fill the reserve */
  reservedCores: number;
  account: AccountLimits;
  deferrals: number;
}): { reason: string; bound: AccountBound } | null {
  const a = p.account;
  const reserve = p.deferrals >= RESERVE_BYPASS_DEFERRALS ? 0 : reserveOf(a, p.capacity);
  // the reserve is room for paid work: only what paid (unreserved) leases hold reaches into it. Free leases are
  // burst grants (a lone encode takes the pool) that shrink for the next pass, so counting them would let one Free
  // render shut every other Free render out of an otherwise idle machine
  const paidCores = Math.max(0, p.hostCores - p.reservedCores);
  if (reserve > 0 && paidCores >= p.capacity - reserve)
    return {
      reason: `paid plans hold ${paidCores} of this host's ${plural(p.capacity, "core")}; the last ${plural(reserve, "core")} are kept for them`,
      bound: "reserve",
    };
  // an account holding nothing may always start one: a ceiling below one render's size must not lock it out
  if (!a.ceiling || (a.live.memMB === 0 && a.live.cores === 0)) return null;
  if (a.live.memMB + p.memMB > a.ceiling.maxMemMB)
    return { reason: `the account's jobs hold ${a.live.memMB} MB of its ${a.ceiling.maxMemMB} MB memory, one more needs ${p.memMB} MB`, bound: "ceiling" };
  if (a.live.cores >= a.ceiling.maxCores)
    return { reason: `the account's jobs hold ${a.live.cores} of its ${plural(a.ceiling.maxCores, "core")}`, bound: "ceiling" };
  return null;
}

/** The reserve on a machine with `capacity` cores: never all of them, so a reserved account can still start on an idle machine. */
const reserveOf = (a: AccountLimits, capacity: number) => Math.max(0, Math.min(a.reserveCores, capacity - 1));

/**
 * A job refused by its own account's ceiling or the paid reserve (`claimOnLive` with `account`). Retryable: the worker
 * reschedules it with a short backoff, without spending one of its attempts and one step higher in its queue each
 * time up to a cap (queue/workers.ts `deferForCapacity`), so its slot goes to the next job in fair-share order instead
 * of waiting on this account's own work.
 */
export class AccountCeilingError extends Error {
  readonly code = "account_ceiling" as const;
  constructor(
    reason: string,
    /** which bound: the account's own ceiling, or the paid reserve (the upgrade offer names the one that applies) */
    readonly bound: AccountBound,
  ) {
    super(`Waiting for capacity: ${reason}`);
    this.name = "AccountCeilingError";
  }
}

/**
 * Pure: why one more render may not start on this host now, or null. One may always run; otherwise the host's
 * renders stay within ~CPUS_PER_RENDER cores each and what measured memory allows (`renderLimit`), and the
 * renders' leased memory (RENDER_MEM_MB each, every process on the host) fits above MIN_FREE_MEM_MB.
 */
export function renderRefusal(p: {
  cpus: number;
  hostRenders: number;
  memAvailableMB: number;
  memTotalMB: number;
  memLeasedMB: number;
  minFreeMemMB: number;
}): string | null {
  if (p.hostRenders === 0) return null;
  const limit = renderLimit({ cpus: p.cpus, memAvailableMB: p.memAvailableMB, running: p.hostRenders, minFreeMemMB: p.minFreeMemMB });
  if (p.hostRenders >= limit) return `${plural(p.hostRenders, "render")} running on this host, room for ${limit} (${p.cpus} CPUs, ${p.memAvailableMB} MB free)`;
  if (p.memLeasedMB + RENDER_MEM_MB > p.memTotalMB - p.minFreeMemMB)
    return `${p.memLeasedMB} MB of ${p.memTotalMB} MB memory leased to renders on this host, one more needs ${RENDER_MEM_MB} MB`;
  return null;
}

/**
 * Pure: may a job that needs `requiredMB` free start when `freeMB` is free on disk and `leasedMB` of that is
 * already promised to jobs in flight (whose scratch statfs does not see yet)? An unmeasurable disk (-1) never refuses.
 */
export function leaseFits(p: { freeMB: number; leasedMB: number; requiredMB: number }): boolean {
  return p.freeMB < 0 || p.freeMB - p.leasedMB >= p.requiredMB;
}

/** Progress / log text for a job held back by other jobs' leases rather than by the bytes on disk. */
export function leaseShortReason(freeMB: number, leasedMB: number, jobs: number, requiredMB: number): string {
  return `${freeMB} MB free but ${leasedMB} MB leased to ${plural(jobs, "job")} in flight, needs ${requiredMB} MB`;
}

/** Null when disk is unmeasured (`diskFreeMB < 0`) or there is enough. */
export function diskShortReason(diskFreeMB: number, minFreeMB: number, extraMB: number): string | null {
  if (diskFreeMB < 0) return null;
  const need = requiredDiskMB(minFreeMB, extraMB);
  return diskFreeMB < need ? `${diskFreeMB} MB disk free, need ${need}` : null;
}

/** A claim on cores: `min` is the guarantee, `max` how far it may burst into what is free (docs/specs/resource-leases.md). */
interface CpuRequest {
  min: number;
  max: number;
}

/**
 * The cores one request gets, pure for tests: what the pool has left after the leases already out, kept between the
 * request's `min` and `max`. `min` always wins, so fixed-size work (`min = max`) never waits here and the pool can
 * be over-committed by at most the guarantees of the work that arrived after it filled.
 */
export function cpuGrant(p: { capacity: number; leased: number } & CpuRequest): number {
  const min = Math.max(1, Math.floor(p.min));
  const max = Math.max(min, Math.floor(p.max));
  return Math.min(max, Math.max(min, p.capacity - p.leased));
}

/** The pool's size: every core less one for everything that is not a leased job (Node, Postgres on a single box, the OS). */
export const cpuCapacity = (cpus: number) => Math.max(1, cpus - 1);

/** A frame sampler's decode (text, faces, speakers over a clip's window at a few fps): one or two threads from what is free. */
export const SAMPLE_CPU: CpuRequest = { min: 1, max: 2 };

/** A one-off encode (a stitched window, a bumper, a still-picture video): one thread up to four, from what is free. */
export const ENCODE_PASS_CPU: CpuRequest = { min: 1, max: 4 };

/** Most decoder threads a shot-cut scan takes: past this the single-threaded scene filter is the bottleneck. */
export const MAX_SCENE_SCAN_THREADS = 4;

/**
 * What a shot-cut scan (`media.detectScenes`) asks the pool for: 1 to MAX_SCENE_SCAN_THREADS decoder threads, or
 * exactly a pinned SCENE_SCAN_THREADS. Decoder threading is lossless, so the cuts are the same at any count.
 */
export function sceneScanCpu(pinned: number): CpuRequest {
  return pinned > 0 ? { min: pinned, max: pinned } : { min: 1, max: MAX_SCENE_SCAN_THREADS };
}

/** How many renders may run now: pure, for tests. */
export function renderLimit(p: { cpus: number; memAvailableMB: number; running: number; minFreeMemMB: number; fixed?: number | undefined }): number {
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
  const cpuPool = cpuCapacity(cpus);
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
  let leaser: Leaser | null = null;
  let volume: string | null = null;
  let machine: string | null = null;
  /** leases this process holds (what the heartbeat reports; the whole ledger without a leaser) */
  const own = new Map<number, { kind: string; mb: number; cores: number; memMB: number; ledgerId?: number | undefined }>();
  let nextLease = 1;
  function ownTotals(): HostLeases {
    const t: HostLeases = { mb: 0, cores: 0, memMB: 0, jobs: 0, diskJobs: 0, kinds: {} };
    for (const l of own.values()) {
      t.mb += l.mb;
      t.cores += l.cores;
      t.memMB += l.memMB;
      t.jobs++;
      if (l.mb > 0) t.diskJobs++;
      t.kinds[l.kind] = (t.kinds[l.kind] ?? 0) + 1;
    }
    return t;
  }

  /**
   * Claim against the host's live leases, atomically with the check: the shared ledger, or without one this
   * process's own map, checked and written in one synchronous step (no await before the write), so two concurrent
   * claims cannot both pass on the same capacity either.
   */
  async function claim(req: LeaseRequest): Promise<Lease | LeaseRefusal> {
    const local = () => {
      const c = claimOnLive(req, ownTotals());
      return c.ok ? leaseHandle(req.kind, c, async () => {}) : c;
    };
    if (!leaser) return local();
    let r: LeaseResult;
    try {
      r = await leaser(req);
    } catch (err) {
      // a claim with an admit rule (a stage's disk, a render slot) must see the whole host, so its failure is the
      // job's to retry; a CPU-only claim never waits or refuses, so a database blip must not fail the ffmpeg pass:
      // it is granted against this process's own leases and the pass goes on
      if (req.admit) throw err;
      log.warn({ err, kind: req.kind }, "lease ledger unreachable; granting cores from this process's own leases");
      return local();
    }
    return r.ok ? leaseHandle(req.kind, r, r.release, r.id) : r;
  }

  /** The lease handed to the caller: drops the entry from `own` and the ledger once, whichever way it ends. */
  function leaseHandle(kind: string, c: { mb: number; cores: number; memMB: number }, release: () => Promise<void>, ledgerId?: number): Lease {
    const id = nextLease++;
    own.set(id, { kind, mb: c.mb, cores: c.cores, memMB: c.memMB, ledgerId });
    let done = false;
    return {
      kind,
      mb: c.mb,
      cores: c.cores,
      memMB: c.memMB,
      async release() {
        if (done) return;
        done = true;
        own.delete(id);
        if (c.mb > 0) lastAt = 0; // the next sample reads the disk again: the scratch is real (or gone) now
        await release().catch((err) =>
          log.warn({ err, kind, mb: c.mb, cores: c.cores, memMB: c.memMB }, "could not release a lease; the next heartbeat drops it"),
        );
      },
    };
  }

  /** No claim at all (a stage with no scratch, or a disk it cannot measure): nothing to record or give back. */
  const noLease = (kind: string): Lease => ({ kind, mb: 0, cores: 0, memMB: 0, release: async () => {} });

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

    setLeaser(fn, scope) {
      leaser = fn;
      volume = fn ? (scope?.volume ?? null) : null;
      machine = fn ? (scope?.machine ?? null) : null;
    },

    ownLeaseIds() {
      return [...own.values()].flatMap((l) => (l.ledgerId === undefined ? [] : [l.ledgerId]));
    },

    leases() {
      const t = ownTotals();
      return { volume, machine, ownMB: t.mb, own: t.jobs, ownCores: t.cores, ownMemMB: t.memMB };
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
          const freeMB = s.diskFreeMB;
          const r =
            needDiskMB > 0 && freeMB >= 0
              ? await claim({
                  kind,
                  mb: needDiskMB,
                  ids,
                  admit: (live) =>
                    leaseFits({ freeMB, leasedMB: live.mb, requiredMB: required }) ? null : leaseShortReason(freeMB, live.mb, live.diskJobs, required),
                })
              : noLease(kind);
          if (!("ok" in r)) {
            if (waited) log.info({ kind, waitedSec: Math.round((Date.now() - started) / 1000) }, "resources available, proceeding");
            return r;
          }
          leased = { leasedMB: r.live.mb, jobs: r.live.diskJobs };
          reasons.push(r.reason);
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

    async withCpu(req, fn) {
      const lease = await claim({ kind: req.kind, cpu: req.cpu, capacity: cpuPool, ids: req.ids });
      // nothing refuses a CPU-only claim (it has no admit): the grant is at least the request's min
      if ("ok" in lease) throw new Error(`CPU lease refused: ${lease.reason}`);
      try {
        return await fn(lease.cores);
      } finally {
        await lease.release();
      }
    },

    cpuCapacity: () => cpuPool,

    renderEncodeCpu() {
      // the pool (every core less one) shared by the machine's renders (every process on it), as a fixed-size
      // claim from the same pool scans are granted from. Rounded up: rounding down left cores idle (two renders on
      // 4 cores got one thread each of a 3-core pool); up overshoots the pool by less than one thread per render,
      // which the spare core absorbs. Encode cores only, the filtergraph is single-threaded (filterThreadArgs)
      return (live) => {
        const share = Math.max(1, Math.ceil(cpuPool / Math.max(1, live.kinds[RENDER_SLOT_KIND] ?? 0)));
        return { min: share, max: share };
      };
    },

    maxRenders() {
      return fixed ?? Math.min(MAX_AUTO_RENDERS, Math.max(1, Math.floor(cpus / CPUS_PER_RENDER)));
    },

    renders() {
      return { running, limit: lastLimit, mode: fixed ? "fixed" : "auto" };
    },

    async renderSlot({ signal, onWait, ids, deferrals }) {
      const started = Date.now();
      let lastReason = "";
      for (;;) {
        if (signal?.aborted) throw new Error("job aborted while waiting for a render slot");
        const s = await sample();
        // a pinned RENDER_CONCURRENCY is this process's own count, as the operator set it; auto is the host's
        // renders, memory and CPUs, checked against every process's render leases in the same step as this one
        const r: Lease | LeaseRefusal =
          fixed && running >= fixed
            ? { ok: false, reason: `${plural(running, "render")} running, RENDER_CONCURRENCY=${fixed}`, live: NO_LEASES }
            : await claim({
                kind: RENDER_SLOT_KIND,
                memMB: RENDER_MEM_MB,
                capacity: cpuPool,
                ids,
                deferrals,
                admit: fixed
                  ? undefined
                  : (live) => {
                      const hostRenders = live.kinds[RENDER_SLOT_KIND] ?? 0;
                      lastLimit = renderLimit({ cpus, memAvailableMB: s.memAvailableMB, running: hostRenders, minFreeMemMB: config.MIN_FREE_MEM_MB });
                      return renderRefusal({
                        cpus,
                        hostRenders,
                        memAvailableMB: s.memAvailableMB,
                        memTotalMB: s.memTotalMB,
                        memLeasedMB: live.memMB,
                        minFreeMemMB: config.MIN_FREE_MEM_MB,
                      });
                    },
              });
        if (!("ok" in r)) {
          running++;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            running--;
            void r.release();
          };
        }
        // the account's own ceiling: never wait for it in this slot (a paying account's render may be queued behind)
        if (r.account) {
          onWait?.(`Waiting for capacity: ${r.reason}`);
          throw new AccountCeilingError(r.reason, r.account);
        }
        if (Date.now() - started > config.RESOURCE_WAIT_MAX_SECONDS * 1000)
          throw new Error(`Gave up waiting ${config.RESOURCE_WAIT_MAX_SECONDS}s for a render slot: ${r.reason}`);
        if (r.reason !== lastReason) {
          lastReason = r.reason;
          onWait?.(`Waiting for a render slot: ${r.reason}`);
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
    },

    async check() {
      const s = await sample();
      if (s.diskFreeMB >= 0 && s.diskFreeMB < config.MIN_FREE_DISK_MB) {
        // a process that runs no workers writes no scratch: refusing to boot would lock out the admin UI that can free the disk
        if (!config.RUN_WORKERS)
          log.warn(
            { diskFreeMB: s.diskFreeMB, minFreeMB: config.MIN_FREE_DISK_MB, dataDir },
            "free disk is below MIN_FREE_DISK_MB; starting anyway because this process runs no workers (an admin can still reach the UI to free space)",
          );
        else throw new Error(`only ${s.diskFreeMB} MB free in ${dataDir}; MIN_FREE_DISK_MB=${config.MIN_FREE_DISK_MB}`);
      }
      gpu = await detectGpu();
      log.info(
        {
          platform: s.platform,
          cpus: s.cpus,
          cpuPercent: s.cpuPercent,
          memAvailableMB: s.memAvailableMB,
          memTotalMB: s.memTotalMB,
          diskFreeMB: s.diskFreeMB,
          gpu: gpu ? `${gpu.vendor}: ${gpu.devices.join(", ") || "device without tools"}` : "none",
          renders: fixed ? `fixed ${fixed}` : `auto, up to ${this.maxRenders()}`,
        },
        "resources",
      );
    },
  };
}
