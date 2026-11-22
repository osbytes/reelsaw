/** Render concurrency follows CPUs and free memory (pure; no stack needed). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createResourceGovernor,
  diskShortReason,
  leaseFits,
  leaseShortReason,
  nvidiaDeviceNode,
  renderLimit,
  RENDER_MEM_MB,
  requiredDiskMB,
  ResourceExhaustedError,
  cpuCapacity,
  cpuGrant,
  sceneScanCpu,
  MAX_SCENE_SCAN_THREADS,
  claimOnLive,
  AccountCeilingError,
  type AccountLimits,
  renderRefusal,
  NO_LEASES,
  CPUS_PER_RENDER,
  RENDER_SLOT_KIND,
  type HostLeases,
  type LeaseRequest,
  type Leaser,
} from "../src/resources.js";
import type { Config } from "../src/config.js";
import type { Logger } from "../src/log.js";
import { resourceCeilingOf, type Grants } from "../src/quota.js";

describe("cpuGrant", () => {
  it("bursts into what is free, between the request's min and max", () => {
    assert.equal(cpuGrant({ capacity: 5, leased: 0, min: 1, max: 4 }), 4);
    assert.equal(cpuGrant({ capacity: 5, leased: 4, min: 1, max: 4 }), 1);
    assert.equal(cpuGrant({ capacity: 5, leased: 2, min: 1, max: 4 }), 3);
  });
  it("always grants the min, so fixed-size work never waits on the pool", () => {
    assert.equal(cpuGrant({ capacity: 5, leased: 9, min: 1, max: 4 }), 1);
    assert.equal(cpuGrant({ capacity: 5, leased: 5, min: 6, max: 6 }), 6);
  });
  it("cleans up nonsense requests", () => {
    assert.equal(cpuGrant({ capacity: 8, leased: 0, min: 0, max: 0 }), 1);
    assert.equal(cpuGrant({ capacity: 8, leased: 0, min: 3, max: 2 }), 3);
  });
  it("the pool keeps one core back", () => {
    assert.equal(cpuCapacity(1), 1);
    assert.equal(cpuCapacity(6), 5);
  });
});

describe("claimOnLive with an account's limits (hosted plans)", () => {
  const free = (live: { cores: number; memMB: number }, reserveCores = 0): AccountLimits => ({
    ceiling: { maxCores: 2, maxMemMB: 2400 },
    reserveCores,
    live,
  });
  const scan = { kind: "scene-scan", cpu: { min: 1, max: 4 }, capacity: 7 };
  const slot = { kind: RENDER_SLOT_KIND, memMB: RENDER_MEM_MB, capacity: 7 };
  it("an elastic pass shrinks to the account's ceiling, down to one thread, and never waits", () => {
    assert.equal((claimOnLive(scan, NO_LEASES, free({ cores: 0, memMB: 0 })) as { cores: number }).cores, 2);
    assert.equal((claimOnLive(scan, NO_LEASES, free({ cores: 1, memMB: 0 })) as { cores: number }).cores, 1);
    assert.equal((claimOnLive(scan, NO_LEASES, free({ cores: 5, memMB: 0 })) as { cores: number }).cores, 1, "past the ceiling: the floor");
  });
  it("a fixed-share encode shrinks too: threads never change the output", () => {
    const encode = { kind: "render-encode", cpu: { min: 7, max: 7 }, capacity: 7 };
    assert.equal((claimOnLive(encode, NO_LEASES, free({ cores: 0, memMB: 1200 })) as { cores: number }).cores, 2);
    assert.equal((claimOnLive(encode, NO_LEASES) as { cores: number }).cores, 7, "no account: the host's share");
  });
  it("the reserve keeps the machine's last cores: a pass gets what is left above it", () => {
    const busy = { ...NO_LEASES, cores: 3 };
    const unbounded: AccountLimits = { ceiling: null, reserveCores: 2, live: { cores: 0, memMB: 0 } };
    assert.equal((claimOnLive(scan, busy, unbounded) as { cores: number }).cores, 2, "7 cores, 3 leased, 2 kept: 2 left");
    assert.equal((claimOnLive(scan, { ...NO_LEASES, cores: 6 }, unbounded) as { cores: number }).cores, 1);
  });
  it("a render slot past the memory ceiling is refused as the account's, not the host's", () => {
    const r = claimOnLive(slot, NO_LEASES, free({ cores: 0, memMB: 2400 }));
    assert.ok(!r.ok && r.account, "refused with account: the worker requeues it");
    assert.match(!r.ok ? r.reason : "", /2400 MB of its 2400 MB memory/);
    assert.ok(claimOnLive(slot, NO_LEASES, free({ cores: 0, memMB: 1200 })).ok, "a second render fits 2400 MB");
  });
  it("an account holding nothing may always start one, whatever its ceiling", () => {
    const tiny: AccountLimits = { ceiling: { maxCores: 1, maxMemMB: 100 }, reserveCores: 0, live: { cores: 0, memMB: 0 } };
    assert.ok(claimOnLive(slot, NO_LEASES, tiny).ok);
  });
  it("a reserved account's render waits in the queue while the machine's leases reach into the reserve", () => {
    const r = claimOnLive(slot, { ...NO_LEASES, cores: 5 }, free({ cores: 0, memMB: 0 }, 2));
    assert.ok(!r.ok && r.account);
    assert.match(!r.ok ? r.reason : "", /kept for paid plans/);
    assert.ok(claimOnLive(slot, { ...NO_LEASES, cores: 4 }, free({ cores: 0, memMB: 0 }, 2)).ok);
  });
  it("a reserve as large as the machine still lets an idle one start the work", () => {
    const small = { ...slot, capacity: 2 };
    assert.ok(claimOnLive(small, NO_LEASES, free({ cores: 0, memMB: 0 }, 8)).ok, "kept: at most capacity - 1");
  });
  it("the host's refusal stays the host's (bounded wait in the slot)", () => {
    const r = claimOnLive({ ...slot, admit: () => "host full" }, NO_LEASES, free({ cores: 0, memMB: 2400 }));
    assert.ok(!r.ok && !r.account && r.reason === "host full");
  });
});

describe("resourceCeilingOf", () => {
  const grants = (over: Partial<Grants> = {}): Grants => ({ plan: "free", planLabel: "Free", limits: {}, watermark: null, period: null, ...over });
  it("an admin's override, else the plan's, else none", () => {
    const plan = { maxCores: 2, maxMemMB: 2400 };
    assert.deepEqual(resourceCeilingOf(null, grants({ resources: plan, reserveCores: 2 })), {
      value: plan,
      source: "plan",
      plan,
      override: null,
      reserveCores: 2,
    });
    const o = { maxCores: 6, maxMemMB: 6000 };
    assert.equal(resourceCeilingOf(o, grants({ resources: plan })).value, o);
    assert.deepEqual(resourceCeilingOf(null, null), { value: null, source: "instance", plan: null, override: null, reserveCores: 0 });
  });
});

describe("sceneScanCpu", () => {
  it("asks for 1 to the cap, or exactly a pinned SCENE_SCAN_THREADS", () => {
    assert.deepEqual(sceneScanCpu(0), { min: 1, max: MAX_SCENE_SCAN_THREADS });
    assert.deepEqual(sceneScanCpu(12), { min: 12, max: 12 });
  });
});

const SCOPE = { volume: "vol-1", machine: "boot:m1" };

/**
 * A ledger shared by several governors, as the database is by the processes of one host: the check and the
 * record happen in one synchronous step (the locked transaction of resource-leases.ts).
 */
function sharedLedger() {
  const rows = new Map<number, { worker: string; kind: string; mb: number; cores: number; memMB: number }>();
  let next = 1;
  const live = (): HostLeases => {
    const t: HostLeases = { mb: 0, cores: 0, memMB: 0, jobs: 0, diskJobs: 0, kinds: {} };
    for (const r of rows.values()) {
      t.mb += r.mb;
      t.cores += r.cores;
      t.memMB += r.memMB;
      t.jobs++;
      if (r.mb > 0) t.diskJobs++;
      t.kinds[r.kind] = (t.kinds[r.kind] ?? 0) + 1;
    }
    return t;
  };
  const leaserFor =
    (worker: string): Leaser =>
    async (req: LeaseRequest) => {
      const c = claimOnLive(req, live());
      if (!c.ok) return c;
      const id = next++;
      rows.set(id, { worker, kind: req.kind, mb: c.mb, cores: c.cores, memMB: c.memMB });
      return { ...c, release: async () => void rows.delete(id) };
    };
  return { rows, live, leaserFor };
}

describe("claimOnLive", () => {
  it("grants cores against what is out, and a request may depend on it (a render encode's share)", () => {
    const live = { ...NO_LEASES, cores: 3, kinds: { render: 2 } };
    assert.deepEqual(claimOnLive({ kind: "scene-scan", cpu: { min: 1, max: 4 }, capacity: 5 }, live), { ok: true, mb: 0, cores: 2, memMB: 0 });
    const share = (l: HostLeases) => ({ min: Math.floor(8 / (l.kinds.render ?? 1)), max: Math.floor(8 / (l.kinds.render ?? 1)) });
    assert.equal((claimOnLive({ kind: "render-encode", cpu: share, capacity: 5 }, live) as { cores: number }).cores, 4);
  });
  it("refuses with the admit's reason and the totals it saw, and records nothing to grant", () => {
    const live = { ...NO_LEASES, mb: 900 };
    const r = claimOnLive({ kind: "ingest", mb: 500, admit: (l) => (l.mb > 800 ? "too much leased" : null) }, live);
    assert.deepEqual(r, { ok: false, reason: "too much leased", live });
  });
});

describe("renderRefusal", () => {
  const room = { cpus: 8, memAvailableMB: 64000, memTotalMB: 64000, memLeasedMB: 0, minFreeMemMB: 512 };
  it("one render may always start", () => {
    assert.equal(renderRefusal({ ...room, hostRenders: 0, memAvailableMB: 10, memTotalMB: 10 }), null);
  });
  it("counts the host's renders, every process's, against its CPUs", () => {
    assert.equal(renderRefusal({ ...room, hostRenders: 8 / CPUS_PER_RENDER - 1 }), null);
    assert.match(renderRefusal({ ...room, hostRenders: 8 / CPUS_PER_RENDER }) ?? "", /4 renders running on this host, room for 4/);
  });
  it("refuses one more when the renders' leased memory would cross the floor", () => {
    assert.match(renderRefusal({ ...room, hostRenders: 1, memTotalMB: 2000, memLeasedMB: 1200 }) ?? "", /memory leased to renders/);
  });
});

describe("leases on the governor", () => {
  const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
  const gov = (extra: Partial<Config> = {}) =>
    createResourceGovernor(
      {
        RENDER_CONCURRENCY: "auto",
        MAX_CPU_PERCENT: 100,
        MIN_FREE_MEM_MB: 0,
        MIN_FREE_DISK_MB: 0,
        RESOURCE_WAIT_MAX_SECONDS: 0,
        ...extra,
      } as unknown as Config,
      process.cwd(),
      log,
    );
  it("two scans side by side see each other and never take more than the pool between them", async () => {
    const g = gov();
    const capacity = g.cpuCapacity();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let a = 0;
    const first = g.withCpu({ kind: "scene-scan", cpu: sceneScanCpu(0) }, async (cores) => {
      a = cores;
      await hold;
    });
    await new Promise((r) => setImmediate(r));
    const b = await g.withCpu({ kind: "scene-scan", cpu: sceneScanCpu(0) }, async (cores) => {
      assert.equal(g.leases().own, 2);
      return cores;
    });
    assert.equal(a, Math.min(MAX_SCENE_SCAN_THREADS, capacity));
    assert.equal(b, Math.max(1, Math.min(MAX_SCENE_SCAN_THREADS, capacity - a)));
    release();
    await first;
    assert.deepEqual(g.leases(), { volume: null, machine: null, ownMB: 0, own: 0, ownCores: 0, ownMemMB: 0 });
  });
  it("withCpu releases the cores when the work throws", async () => {
    const g = gov();
    await assert.rejects(
      g.withCpu({ kind: "scene-scan", cpu: { min: 1, max: 2 } }, async () => {
        assert.equal(g.leases().own, 1);
        throw new Error("decode failed");
      }),
      /decode failed/,
    );
    assert.equal(g.leases().own, 0);
    assert.equal(g.leases().ownCores, 0);
  });
  it("two processes on one host: a scan in one sees the other's render encode", async () => {
    const ledger = sharedLedger();
    const one = gov();
    const two = gov();
    one.setLeaser(ledger.leaserFor("one"), SCOPE);
    two.setLeaser(ledger.leaserFor("two"), SCOPE);
    const capacity = one.cpuCapacity();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const encode = one.withCpu({ kind: "render-encode", cpu: { min: capacity, max: capacity } }, () => hold);
    await new Promise((r) => setImmediate(r));
    assert.equal(ledger.live().cores, capacity);
    assert.equal(await two.withCpu({ kind: "scene-scan", cpu: sceneScanCpu(0) }, async (cores) => cores), 1);
    release();
    await encode;
    assert.equal(ledger.rows.size, 0, "every lease came back to the ledger");
  });
  it("the render slot counts the host's renders, not only this process's, and gives its memory back", async () => {
    const ledger = sharedLedger();
    const one = gov();
    const two = gov();
    one.setLeaser(ledger.leaserFor("one"), SCOPE);
    two.setLeaser(ledger.leaserFor("two"), SCOPE);
    // the other process already runs as many renders as any host may
    for (let i = 0; i < 64; i++) ledger.rows.set(1000 + i, { worker: "two", kind: RENDER_SLOT_KIND, mb: 0, cores: 0, memMB: 0 });
    await assert.rejects(one.renderSlot({}), /render slot: \d+ renders running on this host/);
    for (let i = 0; i < 64; i++) ledger.rows.delete(1000 + i);
    const done = await one.renderSlot({ ids: { jobId: "j1", projectId: "p1" } });
    assert.equal(ledger.live().kinds[RENDER_SLOT_KIND], 1);
    assert.ok(ledger.live().memMB > 0, "a render leases its memory");
    assert.equal(one.renders().running, 1);
    done();
    done(); // twice is once
    await new Promise((r) => setImmediate(r));
    assert.equal(ledger.rows.size, 0);
    assert.equal(one.renders().running, 0);
  });
  it("a render stage's disk lease does not count as another render: the encode gets the host's whole share", async () => {
    const ledger = sharedLedger();
    const g = gov();
    g.setLeaser(ledger.leaserFor("one"), SCOPE);
    const done = await g.renderSlot({});
    // the render stage claims its scratch under the stage kind "render" (pipeline/render.ts ctx.acquire)
    ledger.rows.set(5000, { worker: "one", kind: "render", mb: 512, cores: 0, memMB: 0 });
    assert.equal(await g.withCpu({ kind: "render-encode", cpu: g.renderEncodeCpu() }, async (cores) => cores), g.cpuCapacity());
    ledger.rows.delete(5000);
    done();
  });
  it("renders share the pool rounded up, so no core sits idle", async () => {
    const ledger = sharedLedger();
    const g = gov();
    g.setLeaser(ledger.leaserFor("one"), SCOPE);
    ledger.rows.set(6000, { worker: "two", kind: RENDER_SLOT_KIND, mb: 0, cores: 0, memMB: 0 });
    ledger.rows.set(6001, { worker: "two", kind: RENDER_SLOT_KIND, mb: 0, cores: 0, memMB: 0 });
    const cores = await g.withCpu({ kind: "render-encode", cpu: g.renderEncodeCpu() }, async (c) => c);
    assert.equal(cores, Math.max(1, Math.ceil(g.cpuCapacity() / 2)));
  });
  it("a render refused by its account's ceiling throws at once instead of waiting in the slot", async () => {
    const g = gov();
    let calls = 0;
    g.setLeaser(async (req) => {
      calls++;
      return { ok: false, reason: `the account's jobs hold 2400 MB of its 2400 MB memory (${req.kind})`, live: NO_LEASES, account: true };
    }, SCOPE);
    const started = Date.now();
    await assert.rejects(g.renderSlot({}), (err) => err instanceof AccountCeilingError && /^Waiting for capacity: /.test(err.message));
    assert.equal(calls, 1, "one claim, no retry loop");
    assert.ok(Date.now() - started < 1500, "no wait in the worker slot");
    assert.equal(g.renders().running, 0);
  });
  it("a pinned RENDER_CONCURRENCY is this process's own count", async () => {
    const g = gov({ RENDER_CONCURRENCY: 1 } as Partial<Config>);
    const done = await g.renderSlot({});
    await assert.rejects(g.renderSlot({}), /RENDER_CONCURRENCY=1/);
    done();
    const again = await g.renderSlot({});
    again();
  });
});

const base = { memAvailableMB: 64000, running: 0, minFreeMemMB: 512 };
describe("renderLimit", () => {
  it("gives each render about two cores, capped", () => {
    assert.equal(renderLimit({ ...base, cpus: 1 }), 1);
    assert.equal(renderLimit({ ...base, cpus: 2 }), 1);
    assert.equal(renderLimit({ ...base, cpus: 12 }), 6);
    assert.equal(renderLimit({ ...base, cpus: 64 }), 8);
  });
  it("only starts another render if memory stays above the floor", () => {
    assert.equal(renderLimit({ cpus: 12, memAvailableMB: 512 + RENDER_MEM_MB - 1, running: 2, minFreeMemMB: 512 }), 2);
    assert.equal(renderLimit({ cpus: 12, memAvailableMB: 512 + RENDER_MEM_MB, running: 2, minFreeMemMB: 512 }), 3);
  });
  it("always lets one render run", () => {
    assert.equal(renderLimit({ cpus: 4, memAvailableMB: 100, running: 0, minFreeMemMB: 512 }), 1);
  });
  it("honours a fixed RENDER_CONCURRENCY", () => {
    assert.equal(renderLimit({ cpus: 64, memAvailableMB: 100, running: 0, minFreeMemMB: 512, fixed: 3 }), 3);
  });
});

describe("diskShortReason", () => {
  it("requires MIN_FREE plus the job's scratch", () => {
    assert.equal(requiredDiskMB(2048, 2048), 4096);
    assert.equal(diskShortReason(4615, 2048, 2048), null);
    assert.equal(diskShortReason(4095, 2048, 2048), "4095 MB disk free, need 4096");
    assert.equal(diskShortReason(2500, 2048, 512), "2500 MB disk free, need 2560");
  });
  it("treats unmeasured disk as unlimited", () => {
    assert.equal(diskShortReason(-1, 2048, 2048), null);
  });
});

describe("nvidiaDeviceNode", () => {
  it("prefers /dev/nvidia0 over Docker Desktop's /dev/dxg", async () => {
    const seen: string[] = [];
    const node = await nvidiaDeviceNode(async (p) => {
      seen.push(p);
      return p === "/dev/nvidia0" || p === "/dev/dxg";
    });
    assert.equal(node, "nvidia0");
    assert.deepEqual(seen, ["/dev/nvidia0"]);
  });
  it("accepts /dev/dxg when nvidia0 is absent (Docker Desktop on WSL2)", async () => {
    assert.equal(await nvidiaDeviceNode(async (p) => p === "/dev/dxg"), "dxg");
  });
  it("returns null when neither device node exists", async () => {
    assert.equal(await nvidiaDeviceNode(async () => false), null);
  });
});

describe("acquire on a disk shortfall", () => {
  // a floor no disk reaches: the governor is short of disk whatever the machine has
  const config = {
    RENDER_CONCURRENCY: "auto",
    MAX_CPU_PERCENT: 100,
    MIN_FREE_MEM_MB: 0,
    MIN_FREE_DISK_MB: 1_000_000_000,
    RESOURCE_WAIT_MAX_SECONDS: 10,
  } as unknown as Config;
  const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
  it("asks the reclaimer once for the shortfall, then fails with what it needed and had", async () => {
    const gov = createResourceGovernor(config, process.cwd(), log);
    const asked: number[] = [];
    gov.setReclaimer(async (needBytes) => {
      asked.push(needBytes);
      return { bytes: 0, enough: false };
    });
    const waits: string[] = [];
    await assert.rejects(gov.acquire({ kind: "ingest", needDiskMB: 512, onWait: (r) => waits.push(r) }), (err: unknown) => {
      assert.ok(err instanceof ResourceExhaustedError);
      assert.equal(err.requiredMB, 1_000_000_512);
      assert.ok(err.freeMB >= 0 && err.freeMB < err.requiredMB);
      assert.match(err.message, /Not enough disk/);
      return true;
    });
    assert.equal(asked.length, 1, "eviction runs once per acquire");
    assert.ok(asked[0]! > 0 && asked[0]! <= 1_000_000_512 * 1048576);
    assert.ok(
      waits.some((w) => w.startsWith("Freeing disk")),
      "the job's progress says what is happening",
    );
  });
  it("fails at once without a reclaimer (nothing to evict)", async () => {
    const gov = createResourceGovernor(config, process.cwd(), log);
    await assert.rejects(gov.acquire({ kind: "render", needDiskMB: 1 }), ResourceExhaustedError);
  });
  it("reclaimTo asks for the gap to the target and reports free disk after", async () => {
    const gov = createResourceGovernor(config, process.cwd(), log);
    const asked: number[] = [];
    gov.setReclaimer(async (needBytes) => {
      asked.push(needBytes);
      return { bytes: 0, enough: false };
    });
    const free = await gov.reclaimTo(1_000_000_000);
    assert.ok(free >= 0);
    assert.equal(asked.length, 1);
    // the disk is sampled before and after the eviction; other processes may move free space by a few MB between the two
    assert.ok(
      Math.abs(asked[0]! - (1_000_000_000 - free) * 1048576) <= 64 * 1048576,
      `asked for the gap to the target (${asked[0]! / 1048576} MB vs ${1_000_000_000 - free})`,
    );
    assert.equal(await gov.reclaimTo(0), free, "already above the target: no eviction");
    assert.equal(asked.length, 1);
  });
});

describe("leaseFits", () => {
  it("compares free space net of what jobs in flight have leased", () => {
    assert.ok(leaseFits({ freeMB: 5000, leasedMB: 0, requiredMB: 4096 }));
    assert.ok(!leaseFits({ freeMB: 5000, leasedMB: 2048, requiredMB: 4096 }), "the first download's claim is counted before its bytes land");
    assert.ok(leaseFits({ freeMB: 5000, leasedMB: 904, requiredMB: 4096 }));
    assert.ok(leaseFits({ freeMB: -1, leasedMB: 99_999, requiredMB: 4096 }), "an unmeasurable disk never refuses");
  });
  it("says what holds the job back", () => {
    assert.equal(leaseShortReason(5000, 2048, 1, 4096), "5000 MB free but 2048 MB leased to 1 job in flight, needs 4096 MB");
    assert.match(leaseShortReason(5000, 3000, 2, 4096), /2 jobs/);
  });
});

describe("disk leases in acquire", () => {
  const log = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;
  // a floor just under what this machine has free, so the governor has `room` MB to lease and no more
  async function governorWithRoom(room: number, extra: Partial<Config> = {}) {
    const probe = createResourceGovernor(
      { RENDER_CONCURRENCY: "auto", MAX_CPU_PERCENT: 100, MIN_FREE_MEM_MB: 0, MIN_FREE_DISK_MB: 0, RESOURCE_WAIT_MAX_SECONDS: 10 } as unknown as Config,
      process.cwd(),
      log,
    );
    const free = (await probe.snapshot()).diskFreeMB;
    if (free < room + 1) return null; // cannot stage the scenario on this disk
    const config = {
      RENDER_CONCURRENCY: "auto",
      MAX_CPU_PERCENT: 100,
      MIN_FREE_MEM_MB: 0,
      MIN_FREE_DISK_MB: free - room,
      RESOURCE_WAIT_MAX_SECONDS: 0.001,
      ...extra,
    } as unknown as Config;
    // floorMB: the MIN_FREE_DISK_MB staged here; free disk can move between this probe and a later acquire
    return Object.assign(createResourceGovernor(config, process.cwd(), log), { floorMB: free - room });
  }

  it("two jobs cannot both pass on the same free bytes: the second waits for the first's lease, then gets in", async (t) => {
    const gov = await governorWithRoom(1500);
    if (!gov) return t.skip("not enough free disk to stage");
    const first = await gov.acquire({ kind: "ingest", needDiskMB: 1000 });
    assert.equal(first.mb, 1000);
    assert.deepEqual(gov.leases(), { volume: null, machine: null, ownMB: 1000, own: 1, ownCores: 0, ownMemMB: 0 });
    // 500 MB of room left on paper (statfs still says 1500: nothing was written): a second 1000 MB job must not start
    const waits: string[] = [];
    await assert.rejects(gov.acquire({ kind: "ingest", needDiskMB: 1000, onWait: (r) => waits.push(r) }), (err: unknown) => {
      assert.ok(!(err instanceof ResourceExhaustedError), "leased space comes back: this is a wait, not a disk failure");
      assert.match((err as Error).message, /Gave up waiting .* leased to 1 job in flight/);
      return true;
    });
    assert.ok(
      waits.some((w) => /leased to 1 job/.test(w)),
      "the job's progress says what it waits for",
    );
    await first.release();
    await first.release(); // idempotent
    assert.deepEqual(gov.leases(), { volume: null, machine: null, ownMB: 0, own: 0, ownCores: 0, ownMemMB: 0 });
    const second = await gov.acquire({ kind: "ingest", needDiskMB: 1000 });
    assert.equal(second.mb, 1000);
    await second.release();
  });

  it("a job that fits beside the first proceeds, and a job needing no scratch never leases", async (t) => {
    const gov = await governorWithRoom(1500);
    if (!gov) return t.skip("not enough free disk to stage");
    const a = await gov.acquire({ kind: "ingest", needDiskMB: 1000 });
    const b = await gov.acquire({ kind: "render", needDiskMB: 400 });
    const none = await gov.acquire({ kind: "analyze" });
    assert.equal(none.mb, 0);
    assert.equal(gov.leases().ownMB, 1400);
    await a.release();
    await b.release();
    await none.release();
  });

  it("evicts scratch once for a lease shortfall before waiting", async (t) => {
    const gov = await governorWithRoom(1500);
    if (!gov) return t.skip("not enough free disk to stage");
    const asked: number[] = [];
    gov.setReclaimer(async (needBytes) => {
      asked.push(needBytes);
      return { bytes: 0, enough: false };
    });
    const first = await gov.acquire({ kind: "ingest", needDiskMB: 1000 });
    await assert.rejects(gov.acquire({ kind: "ingest", needDiskMB: 1000 }), /Gave up waiting/);
    assert.equal(asked.length, 1, "eviction could make the room (cache copies are worth less than a running job)");
    assert.ok(asked[0]! >= 500 * 1048576 && asked[0]! <= 501 * 1048576, `asked for the 500 MB gap, got ${asked[0]! / 1048576} MB`);
    await first.release();
  });

  it("with a shared ledger, the check and the claim go through it, and release gives the claim back", async (t) => {
    const gov = await governorWithRoom(1500);
    if (!gov) return t.skip("not enough free disk to stage");
    const seen: LeaseRequest[] = [];
    let released = 0;
    let othersMB = 0;
    gov.setLeaser(async (req) => {
      seen.push(req);
      const c = claimOnLive(req, { ...NO_LEASES, mb: othersMB, jobs: othersMB ? 1 : 0, diskJobs: othersMB ? 1 : 0 });
      return c.ok ? { ...c, release: async () => void released++ } : c;
    }, SCOPE);
    assert.equal(gov.leases().volume, "vol-1");
    const lease = await gov.acquire({ kind: "ingest", needDiskMB: 1000, ids: { jobId: "j1", projectId: "p1" } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.mb, 1000);
    const req = seen[0];
    const admit = req?.admit;
    assert.ok(req && admit, "a disk claim carries its admit rule");
    assert.deepEqual(req.ids, { jobId: "j1", projectId: "p1" });
    assert.equal(admit({ ...NO_LEASES }), null, "fits with nothing else leased");
    assert.match(admit({ ...NO_LEASES, mb: 10_000_000, diskJobs: 3 }) ?? "", /leased to 3 jobs in flight/);
    assert.equal(gov.leases().ownMB, 1000, "own leases are still counted for the heartbeat");
    await lease.release();
    assert.equal(released, 1);
    assert.equal(gov.leases().ownMB, 0);
    // another process's claim (the ledger says so): this one waits
    othersMB = 1200;
    await assert.rejects(gov.acquire({ kind: "ingest", needDiskMB: 1000 }), /leased to 1 job in flight/);
  });
});
