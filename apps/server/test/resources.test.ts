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
  type DiskLeaseRequest,
} from "../src/resources.js";
import type { Config } from "../src/config.js";
import type { Logger } from "../src/log.js";

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
    return createResourceGovernor(config, process.cwd(), log);
  }

  it("two jobs cannot both pass on the same free bytes: the second waits for the first's lease, then gets in", async (t) => {
    const gov = await governorWithRoom(1500);
    if (!gov) return t.skip("not enough free disk to stage");
    const first = await gov.acquire({ kind: "ingest", needDiskMB: 1000 });
    assert.equal(first.mb, 1000);
    assert.deepEqual(gov.leases(), { volume: null, ownMB: 1000, own: 1 });
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
    assert.deepEqual(gov.leases(), { volume: null, ownMB: 0, own: 0 });
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
    const seen: DiskLeaseRequest[] = [];
    let released = 0;
    let othersMB = 0;
    gov.setLeaser(async (req) => {
      seen.push(req);
      if (!leaseFits({ freeMB: req.freeMB, leasedMB: othersMB, requiredMB: req.requiredMB })) return { ok: false, leasedMB: othersMB, jobs: 1 };
      return { ok: true, release: async () => void released++ };
    }, "vol-1");
    assert.equal(gov.leases().volume, "vol-1");
    const lease = await gov.acquire({ kind: "ingest", needDiskMB: 1000, ids: { jobId: "j1", projectId: "p1" } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.mb, 1000);
    assert.equal(seen[0]!.jobId, "j1");
    assert.equal(seen[0]!.projectId, "p1");
    assert.equal(seen[0]!.requiredMB - seen[0]!.mb, seen[0]!.freeMB - 1500, "required = the floor plus the scratch");
    assert.equal(gov.leases().ownMB, 1000, "own leases are still counted for the heartbeat");
    await lease.release();
    assert.equal(released, 1);
    assert.equal(gov.leases().ownMB, 0);
    // another process's claim (the ledger says so): this one waits
    othersMB = 1200;
    await assert.rejects(gov.acquire({ kind: "ingest", needDiskMB: 1000 }), /leased to 1 job in flight/);
  });
});
