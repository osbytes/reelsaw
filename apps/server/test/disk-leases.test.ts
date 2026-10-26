/** The volume marker (which processes share a disk) and the lease lifetime; the ledger itself needs Postgres. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DISK_LEASE_TTL_MS, VOLUME_MARKER, volumeId } from "../src/disk-leases.js";
import { queueDefs } from "../src/queue/boss.js";

describe("volumeId", () => {
  it("writes the marker once and every later reader (and a concurrent one) gets the same id", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reelsaw-volume-"));
    try {
      const [a, b, c] = await Promise.all([volumeId(dir), volumeId(dir), volumeId(dir)]);
      assert.match(a, /^[0-9a-f-]{36}$/);
      assert.equal(b, a);
      assert.equal(c, a);
      assert.equal(await volumeId(dir), a, "a later boot reads the same marker");
      assert.equal((await fs.readFile(path.join(dir, VOLUME_MARKER), "utf8")).trim(), a);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("two data directories are two volumes", async () => {
    const a = await fs.mkdtemp(path.join(os.tmpdir(), "reelsaw-volume-"));
    const b = await fs.mkdtemp(path.join(os.tmpdir(), "reelsaw-volume-"));
    try {
      assert.notEqual(await volumeId(a), await volumeId(b));
    } finally {
      await fs.rm(a, { recursive: true, force: true });
      await fs.rm(b, { recursive: true, force: true });
    }
  });
});

describe("DISK_LEASE_TTL_MS", () => {
  it("is the longest a stage job may run before pg-boss expires it, so no lease outlives its job", () => {
    assert.equal(DISK_LEASE_TTL_MS, Math.max(...queueDefs.map((q) => q.expireInSeconds)) * 1000);
    assert.ok(DISK_LEASE_TTL_MS >= 3600_000);
  });
});
