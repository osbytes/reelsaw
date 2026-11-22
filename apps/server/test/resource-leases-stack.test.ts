/**
 * The shared resource ledger (resource-leases.ts createLeaser) against the local stack's Postgres: two processes on
 * one host claiming at once cannot both pass on the same free disk, a scan in one sees the other's cores, a stale
 * worker's claims stop counting, and release gives the row back. Uses its own volume and worker ids and removes them.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "../src/db/index.js";
import { createLeaser, hostLeases, LEASE_STALE_MS } from "../src/resource-leases.js";
import { leaseFits, type LeaseResult } from "../src/resources.js";
import { db } from "./helpers.js";

const quiet = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quiet;
  },
} as never;

describe("resource leases (Postgres)", () => {
  let pool: pg.Pool;
  let orm: ReturnType<typeof drizzle<typeof schema>>;
  const run = randomUUID().slice(0, 8);
  const volume = `test-volume-${run}`;
  const machine = `test-machine-${run}`;
  const workerA = `test-a-${run}`;
  const workerB = `test-b-${run}`;
  const workerGone = `test-gone-${run}`;
  const workers = [workerA, workerB, workerGone];
  const leaser = (selfId: string, scope: { volume: string; machine: string } = { volume, machine }) =>
    createLeaser({ database: { db: orm }, log: quiet } as never, { ...scope, selfId, staleMs: LEASE_STALE_MS });
  const live = (scope: { volume: string; machine: string } = { volume, machine }) => hostLeases(orm, { ...scope, selfId: workerA, staleMs: LEASE_STALE_MS });

  before(async () => {
    pool = db();
    orm = drizzle(pool, { schema });
    const now = new Date();
    await orm.insert(schema.workerInstances).values(
      workers.map((id, i) => ({
        id,
        role: "worker" as const,
        hostname: "test",
        startedAt: now,
        // the third one stopped beating long ago: its leases must not count
        lastSeenAt: i === 2 ? new Date(now.getTime() - 2 * LEASE_STALE_MS) : now,
        version: "test",
        commit: "test",
        pid: 1,
        cpus: 6,
        memTotalMB: 8000,
        renders: { running: 0, limit: 1, max: 1, mode: "auto" as const },
      })),
    );
  });
  after(async () => {
    await orm.delete(schema.resourceLeases).where(inArray(schema.resourceLeases.workerId, workers));
    await orm.delete(schema.workerInstances).where(inArray(schema.workerInstances.id, workers));
    await pool.end();
  });

  it("two processes claiming the same free disk at once: one gets it, the other is told why", async () => {
    const disk = (freeMB: number) => ({
      kind: "ingest",
      mb: 1000,
      admit: (l: { mb: number }) => (leaseFits({ freeMB, leasedMB: l.mb, requiredMB: 1000 }) ? null : `leased ${l.mb}`),
    });
    const results: LeaseResult[] = await Promise.all([leaser(workerA)(disk(1500)), leaser(workerB)(disk(1500))]);
    const won = results.filter((r) => r.ok);
    assert.equal(won.length, 1, "the advisory lock serialises the check and the record");
    const lost = results.find((r) => !r.ok);
    assert.ok(lost && !lost.ok && /leased 1000/.test(lost.reason));
    assert.equal((await live()).mb, 1000);
    for (const r of won) if (r.ok) await r.release();
    assert.equal((await live()).mb, 0);
  });

  it("a scan in one process is granted what the other process's encode left", async () => {
    const encode = await leaser(workerA)({ kind: "render-encode", cpu: { min: 4, max: 4 }, capacity: 5 });
    const scan = await leaser(workerB)({ kind: "scene-scan", cpu: { min: 1, max: 4 }, capacity: 5 });
    assert.ok(encode.ok && scan.ok);
    assert.equal(encode.ok && encode.cores, 4);
    assert.equal(scan.ok && scan.cores, 1);
    const l = await live();
    assert.equal(l.cores, 5);
    assert.deepEqual(l.kinds, { "render-encode": 1, "scene-scan": 1 });
    if (encode.ok) await encode.release();
    if (scan.ok) await scan.release();
  });

  it("one network volume across two machines: disk is shared, cores are not", async () => {
    const other = { volume, machine: `${machine}-b` };
    const here = await leaser(workerA)({ kind: "render-encode", mb: 300, cpu: { min: 4, max: 4 }, capacity: 5 });
    const there = await leaser(workerB, other)({ kind: "scene-scan", cpu: { min: 1, max: 4 }, capacity: 5 });
    assert.ok(here.ok && there.ok);
    assert.equal(there.ok && there.cores, 4, "the other machine's cores are its own");
    assert.equal((await live(other)).mb, 300, "the volume's disk claims are seen from both machines");
    assert.equal((await live(other)).cores, 4);
    assert.equal((await live()).cores, 4);
    if (here.ok) await here.release();
    if (there.ok) await there.release();
  });

  it("two volumes on one machine: cores are shared, disk is not", async () => {
    const other = { volume: `${volume}-b`, machine };
    const a = await leaser(workerA)({ kind: "ingest", mb: 700, cpu: { min: 4, max: 4 }, capacity: 5 });
    const b = await leaser(workerB, other)({ kind: "scene-scan", cpu: { min: 1, max: 4 }, capacity: 5 });
    assert.ok(a.ok && b.ok);
    assert.equal(b.ok && b.cores, 1, "the same machine's cores are already leased");
    assert.equal((await live(other)).mb, 0, "another volume's disk is not this one's");
    if (a.ok) await a.release();
    if (b.ok) await b.release();
  });

  it("a worker that stopped beating holds nothing", async () => {
    const gone = await leaser(workerGone)({ kind: "render", memMB: 1200 });
    assert.ok(gone.ok);
    assert.equal((await live()).memMB, 0, "its row is there, but its heartbeat is stale");
    if (gone.ok) await gone.release();
  });
});
