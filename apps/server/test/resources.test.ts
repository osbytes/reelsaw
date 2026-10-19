/** Render concurrency follows CPUs and free memory (pure; no stack needed). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nvidiaDeviceNode, renderLimit, RENDER_MEM_MB } from "../src/resources.js";

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
