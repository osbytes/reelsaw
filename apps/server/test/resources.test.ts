/** Render concurrency follows CPUs and free memory (pure; no stack needed). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createResourceGovernor, diskShortReason, nvidiaDeviceNode, renderLimit, RENDER_MEM_MB, requiredDiskMB, ResourceExhaustedError } from "../src/resources.js";
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
  const config = { RENDER_CONCURRENCY: "auto", MAX_CPU_PERCENT: 100, MIN_FREE_MEM_MB: 0, MIN_FREE_DISK_MB: 1_000_000_000, RESOURCE_WAIT_MAX_SECONDS: 10 } as unknown as Config;
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
    assert.ok(waits.some((w) => w.startsWith("Freeing disk")), "the job's progress says what is happening");
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
    assert.equal(asked[0], (1_000_000_000 - free) * 1048576);
    assert.equal(await gov.reclaimTo(0), free, "already above the target: no eviction");
    assert.equal(asked.length, 1);
  });
});
