/**
 * The shared resource ledger (resource-leases.ts createLeaser) against the local stack's Postgres: two processes on
 * one host claiming at once cannot both pass on the same free disk, a scan in one sees the other's cores, a stale
 * worker's claims stop counting, and release gives the row back. With plans (EE), an account's ceiling and the paid
 * reserve are checked in the same step. Uses its own volume, worker, account and project ids and removes them.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "../src/db/index.js";
import { createLeaser, hostLeases, LEASE_STALE_MS } from "../src/resource-leases.js";
import { leaseFits, RENDER_MEM_MB, RENDER_SLOT_KIND, RESERVE_BYPASS_DEFERRALS, type LeaseResult } from "../src/resources.js";
import type { Entitlements, Grants } from "../src/quota.js";
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
  const leaser = (selfId: string, scope: { volume: string; machine: string } = { volume, machine }, entitlements: Entitlements | null = null) =>
    createLeaser({ database: { db: orm }, log: quiet, entitlements } as never, { ...scope, selfId, staleMs: LEASE_STALE_MS });
  // two accounts on a hosted instance: one on Free (2 cores / 2400 MB, and the reserve), one paying (Pro)
  const freeUser = `test-free-${run}`;
  const paidUser = `test-pro-${run}`;
  const freeProject = `test-project-${run}`;
  const grants = (plan: string, resources: Grants["resources"], reserveCores: number): Grants => ({
    plan,
    planLabel: plan,
    limits: {},
    watermark: null,
    period: null,
    resources,
    reserveCores,
  });
  const plans: Entitlements = {
    grantsFor: async (_db, userId) =>
      userId === freeUser ? grants("free", { maxCores: 2, maxMemMB: 2400 }, 2) : grants("pro", { maxCores: 8, maxMemMB: 9600 }, 0),
  };
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
    await orm.insert(schema.user).values([
      { id: freeUser, name: "Free", email: `${freeUser}@example.test` },
      { id: paidUser, name: "Pro", email: `${paidUser}@example.test` },
    ]);
    await orm.insert(schema.projects).values({
      id: freeProject,
      userId: freeUser,
      title: "Lease test",
      sourceType: "url",
      sourceUrl: "https://example.com/v.mp4",
      settings: {} as never,
      status: "queued",
    });
  });
  after(async () => {
    await orm.delete(schema.resourceLeases).where(inArray(schema.resourceLeases.workerId, workers));
    await orm.delete(schema.user).where(inArray(schema.user.id, [freeUser, paidUser]));
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

  describe("plan ceilings (EE)", () => {
    const capacity = 7; // an 8-core machine less one
    const plansMachine = { volume, machine: `${machine}-plans` };
    const hosted = (selfId: string) => leaser(selfId, plansMachine, plans);
    const scan = (ids: { userId?: string; projectId?: string }) => ({ kind: "scene-scan", cpu: { min: 1, max: 4 }, capacity, ids });
    const slot = (ids: { userId?: string; projectId?: string; jobId?: string }) => ({ kind: RENDER_SLOT_KIND, memMB: RENDER_MEM_MB, capacity, ids });
    const releaseAll = async (rs: LeaseResult[]) => {
      for (const r of rs) if (r.ok) await r.release();
    };

    it("a Free burst stays within its ceiling and leaves the reserve to paid work", async () => {
      // from two processes at once, by the project (the owner is read in the lease step)
      const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => hosted(i % 2 ? workerA : workerB)(scan({ projectId: freeProject }))));
      assert.ok(
        burst.every((r) => r.ok),
        "a CPU pass never waits or is refused",
      );
      const freeCores = burst.reduce((n, r) => n + (r.ok ? r.cores : 0), 0);
      assert.equal(freeCores, 2 + 5, "two cores of ceiling, then one thread each: each pass shrinks to its min");
      const rows = await orm.select().from(schema.resourceLeases).where(eq(schema.resourceLeases.projectId, freeProject));
      assert.ok(rows.length === 6 && rows.every((r) => r.userId === freeUser), "the owner is recorded on every row");
      // the Free account may not start a render while the machine's leases reach into the reserve
      const freeRender = await hosted(workerA)(slot({ userId: freeUser }));
      assert.ok(!freeRender.ok && freeRender.account, "refused as the account's: the worker requeues it, the slot stays free");
      const paid = await hosted(workerB)(slot({ userId: paidUser }));
      assert.ok(paid.ok, "a paid render starts beside the Free burst");
      await releaseAll([...burst, paid]);
    });

    it("the reserve shrinks a Free pass on a busy machine, not a paid one", async () => {
      const paidBig = await hosted(workerA)({ kind: "render-encode", cpu: { min: 4, max: 4 }, capacity, ids: { userId: paidUser } });
      const freeScan = await hosted(workerB)(scan({ userId: freeUser }));
      assert.ok(paidBig.ok && freeScan.ok);
      assert.equal(freeScan.ok && freeScan.cores, 1, "7 cores, 4 leased, 2 kept: 1 left for Free");
      const paidScan = await hosted(workerB)(scan({ userId: paidUser }));
      assert.ok(paidScan.ok);
      assert.equal(paidScan.ok && paidScan.cores, 2, "paid work takes what is left, the reserve included");
      await releaseAll([paidBig, freeScan, paidScan]);
    });

    it("a paid render is not held behind a Free render refused by its own ceiling", async () => {
      const free1 = await hosted(workerA)(slot({ userId: freeUser, jobId: "f1" }));
      const free2 = await hosted(workerB)(slot({ userId: freeUser, jobId: "f2" }));
      assert.ok(free1.ok && free2.ok, "2400 MB holds two renders");
      const free3 = await hosted(workerA)(slot({ userId: freeUser, jobId: "f3" }));
      assert.ok(!free3.ok && free3.account, "the third goes back to the queue, not into a worker slot");
      assert.match(!free3.ok ? free3.reason : "", /2400 MB of its 2400 MB/);
      const paid = await hosted(workerA)(slot({ userId: paidUser, jobId: "p1" }));
      assert.ok(paid.ok, "the paid render takes the slot the Free one did not hold");
      await releaseAll([free1, free2, paid]);
      const again = await hosted(workerA)(slot({ userId: freeUser, jobId: "f3" }));
      assert.ok(again.ok, "once its own work ends, the Free render fits");
      await releaseAll([again]);
    });

    it("a Free render held back by the reserve gets through after a few trips back to the queue", async () => {
      // paid work keeps the machine inside the reserve: 6 of 7 cores leased
      const paidLoad = await hosted(workerB)({ kind: "render-encode", cpu: { min: 6, max: 6 }, capacity, ids: { userId: paidUser } });
      assert.ok(paidLoad.ok);
      const tries: boolean[] = [];
      for (let deferrals = 0; deferrals <= RESERVE_BYPASS_DEFERRALS; deferrals++) {
        const r = await hosted(workerA)({ ...slot({ userId: freeUser }), deferrals });
        tries.push(r.ok);
        if (r.ok) await r.release();
      }
      assert.deepEqual(tries, [false, false, false, true], "refused while young, admitted once aged");
      await releaseAll([paidLoad]);
    });

    it("without plans (self-hosted) nothing bounds an account: the host's capacity only", async () => {
      const selfHosted = (selfId: string) => leaser(selfId, plansMachine, null);
      const rs = await Promise.all(Array.from({ length: 3 }, () => selfHosted(workerA)(slot({ userId: freeUser }))));
      assert.ok(rs.every((r) => r.ok));
      const s = await selfHosted(workerB)(scan({ userId: freeUser }));
      assert.equal(s.ok && s.cores, 4);
      await releaseAll([...rs, s]);
    });
  });
});
