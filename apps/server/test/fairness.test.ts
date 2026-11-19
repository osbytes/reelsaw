/**
 * Fair share between accounts: a job's pg-boss priority is minus its owner's live jobs, so someone with nothing in
 * flight is served before the backlog of someone who queued many; and MAX_LIVE_JOBS_PER_USER refuses a user's own
 * request (never a pipeline hand-off) with a sentence, counting only the jobs they asked for. The owner's queue
 * priority is added on top, and the admin queue summary reports pickup times, queued work by account and pickup order.
 *
 * Runs this checkout's unit of work and queue code in-process against the local stack's Postgres (TEST_DATABASE_URL)
 * on a throwaway pg-boss queue no worker listens on; the running app is only used for sign-up (REELSAW_URL).
 * The provider gate's cross-process limit is checked the same way: two gates stand in for two processes.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { asUserRequest, createUnitOfWork } from "../src/uow.js";
import { createQueue, type QueueName } from "../src/queue/boss.js";
import { QuotaError } from "../src/quota.js";
import type { Config } from "../src/config.js";
import { createProviderGate, parseProviderConcurrency } from "../src/ai/gate.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { schema, type Db } from "../src/db/index.js";
import { summarizeQueue } from "../src/ops/queue.js";
import { db, signUp } from "./helpers.js";

const quiet = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
  child() {
    return quiet;
  },
} as never;
const limits = (maxLive: number) =>
  ({
    MAX_PROJECTS_PER_USER: 0,
    MAX_SOURCE_MINUTES_PER_DAY: 0,
    MAX_NEW_PROJECTS_PER_HOUR: 0,
    MAX_LIVE_JOBS_PER_USER: maxLive,
    MAX_RERENDERS_PER_HOUR: 0,
    MAX_STORAGE_MB: 0,
    RUN_WORKERS: false,
    SHUTDOWN_GRACE_SECONDS: 1,
  }) as unknown as Config;

describe("fair share between users", () => {
  let pool: pg.Pool;
  let queue: ReturnType<typeof createQueue>;
  const name = `test.fairness-${randomUUID().slice(0, 8)}` as QueueName;
  const users: string[] = [];
  const projects: Record<string, string[]> = {};

  before(async () => {
    pool = db();
    queue = createQueue(limits(0), pool, false, quiet);
    await queue.boss.createQueue(name, { policy: "exclusive" });
    for (const [who, n] of [
      ["heavy", 6],
      ["light", 1],
    ] as const) {
      const { userId } = await signUp();
      users.push(userId);
      projects[who] = [];
      for (let i = 0; i < n; i++) {
        const id = randomUUID();
        await pool.query(
          `insert into projects (id, user_id, title, source_type, source_url, status, settings) values ($1, $2, 'Fairness test', 'url', 'https://example.com/v.mp4', 'done', '{}')`,
          [id, userId],
        );
        projects[who]!.push(id);
      }
    }
  });
  after(async () => {
    await pool.query("delete from pgboss.job where name = $1", [name]);
    await queue.boss.deleteQueue(name).catch(() => {});
    await pool.query(`delete from "user" where id = any($1)`, [users]);
    await pool.end();
  });

  const enqueue = (maxLive: number, projectId: string) => createUnitOfWork(pool, queue, quiet, () => limits(maxLive))((u) => u.enqueue(name, { projectId }));
  const jobs = async () =>
    (
      await pool.query<{ project: string; user: string; priority: number; by: string | null }>(
        `select data->>'projectId' as project, data->>'userId' as user, priority, data->>'by' as by from pgboss.job where name = $1 order by priority desc, created_on`,
        [name],
      )
    ).rows;

  it("serves a user with nothing in flight before another user's backlog", async () => {
    // the heavy user's five are their own requests (no limit yet); the light user's one is a pipeline hand-off
    for (const p of projects.heavy!.slice(0, 5)) await asUserRequest(users[0]!, "web", () => enqueue(0, p));
    await enqueue(0, projects.light![0]!);
    const order = await jobs();
    assert.equal(order.length, 6);
    assert.ok(
      order.every((j) => users.includes(j.user)),
      "every job carries its owner",
    );
    const light = order.find((j) => j.project === projects.light![0])!;
    assert.equal(light.priority, 0);
    assert.deepEqual(
      order.filter((j) => j.user === users[0]).map((j) => j.priority),
      [0, -1, -2, -3, -4],
    );
    // fetch order (priority desc, created_on): the heavy user's first job, then the light user's, then the rest
    assert.equal(
      order.findIndex((j) => j.project === projects.light![0]),
      1,
    );
  });

  it("refuses a user's own request past MAX_LIVE_JOBS_PER_USER with a sentence", async () => {
    await assert.rejects(
      asUserRequest(users[0]!, "web", () => enqueue(5, projects.heavy![5]!)),
      (err: unknown) =>
        err instanceof QuotaError && /You have 5 requests queued or running, the most this account may have at once \(5\)/.test((err as Error).message),
    );
    assert.equal((await jobs()).length, 6, "nothing was queued");
  });

  it("never refuses a pipeline hand-off, and does not count hand-offs against the next request", async () => {
    await enqueue(5, projects.heavy![5]!); // no requesting user: a worker or the reconciler
    // the light user has one hand-off in flight and a limit of 1: their own request is still admitted (deduped by singletonKey)
    await asUserRequest(users[1]!, "web", () => enqueue(1, projects.light![0]!));
    const all = await jobs();
    assert.equal(all.length, 7);
    assert.equal(all.find((j) => j.project === projects.heavy![5])!.by, null, "a hand-off is not tagged as the user's request");
  });

  it("adds the owner's queue priority (an admin's override) to the fair share, from the next job on", async () => {
    const id = randomUUID();
    await pool.query(
      `insert into projects (id, user_id, title, source_type, source_url, status, settings) values ($1, $2, 'Fairness test', 'url', 'https://example.com/v.mp4', 'done', '{}')`,
      [id, users[0]],
    );
    await pool.query(`insert into user_settings (user_id, queue_priority) values ($1, 10) on conflict (user_id) do update set queue_priority = 10`, [users[0]]);
    const before = (await jobs()).filter((j) => j.user === users[0]).map((j) => j.priority);
    await enqueue(0, id);
    const all = await jobs();
    // six of the heavy user's jobs were live: -6 + 10
    assert.equal(all.find((j) => j.project === id)!.priority, 4);
    assert.deepEqual(
      all.filter((j) => j.user === users[0] && j.project !== id).map((j) => j.priority),
      before,
      "jobs already queued keep their place",
    );
    assert.equal(all[0]!.project, id, "now first in fetch order");
  });

  it("summarizes pickup times, queued work by account and pickup order; a retry is not a pickup", async () => {
    const svc = { database: { db: drizzle(pool, { schema }) as unknown as Db }, entitlements: null };
    const summary = () => summarizeQueue(svc, { queues: [name] });
    const [taken] = await queue.boss.fetch<{ projectId: string }>(name);
    assert.ok(taken, "a worker took the first job");
    const s = await summary();
    assert.equal(s.error, undefined);
    assert.equal(s.detail, true);
    assert.equal(s.pickup.started, 1);
    assert.ok((s.pickup.p50Sec ?? -1) >= 0);
    assert.equal(s.queues.find((q) => q.queue === name)!.pickup.started, 1);
    const heavy = s.owners.find((o) => o.userId === users[0])!;
    assert.deepEqual(
      { running: heavy.running, waiting: heavy.waiting, priority: heavy.priority, source: heavy.prioritySource },
      { running: 1, waiting: 6, priority: 10, source: "override" },
    );
    const light = s.owners.find((o) => o.userId === users[1])!;
    assert.deepEqual({ waiting: light.waiting, priority: light.priority, source: light.prioritySource }, { waiting: 1, priority: 0, source: "instance" });
    const mine = s.active.filter((j) => j.queue === name);
    assert.equal(mine[0]!.state, "active");
    assert.equal(mine[0]!.projectId, taken.data.projectId);
    const waitingPriorities = mine.slice(1).map((j) => j.priority);
    assert.deepEqual(
      waitingPriorities,
      [...waitingPriorities].sort((a, b) => b - a),
      "waiting jobs in fetch order",
    );

    // the attempt fails and goes back to retry: pg-boss keeps its started_on, but it was not picked up again
    await queue.boss.fail(name, taken.id);
    const after = await summary();
    assert.equal(after.queues.find((q) => q.queue === name)!.pickup.started, 0);
    const retried = after.active.filter((j) => j.queue === name);
    assert.equal(retried[0]!.projectId, taken.data.projectId, "the retry, eligible now and highest priority, is next");
    assert.equal(retried[0]!.state, "retry");

    const light2 = await summarizeQueue(svc, { queues: [name], detail: false });
    assert.deepEqual([light2.detail, light2.owners, light2.pickup.started], [false, [], 0]);
  });
});

describe("provider concurrency gate", () => {
  let pool: pg.Pool;
  before(() => {
    pool = db();
  });
  after(async () => {
    await pool.end();
  });

  it("parses PROVIDER_CONCURRENCY and defaults self-hosted providers to 2 (a local whisper on openai to 1), cloud to unlimited", () => {
    assert.deepEqual(
      [...parseProviderConcurrency("compat=3, openai=16", "ollama")],
      [
        ["ollama", 3],
        ["openai", 16],
      ],
    );
    assert.throws(() => parseProviderConcurrency("ollama", "ollama"), /provider=number/);
    const gate = createProviderGate("", "ollama", (p) => p === "ollama" || p === "openai", quiet);
    assert.equal(gate.limitOf("ollama"), 2);
    assert.equal(gate.limitOf("openai"), 1);
    assert.equal(gate.limitOf("anthropic"), 0);
    assert.equal(createProviderGate("openai=3", "ollama", () => true, quiet).limitOf("openai"), 3);
  });

  it("holds the limit across processes (two gates on one database never run more than N calls together)", async () => {
    const provider = `test-${randomUUID().slice(0, 8)}`;
    // two gates = two processes: each has its own in-process semaphore of 2, only the advisory locks are shared
    const gates = [0, 1].map(() => createProviderGate(`${provider}=2`, "ollama", () => false, quiet));
    for (const g of gates) g.attach(pool);
    let inFlight = 0;
    let peak = 0;
    const call = async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 150));
      inFlight--;
    };
    await Promise.all(Array.from({ length: 6 }, (_, i) => gates[i % 2]!.run(provider, call)));
    assert.equal(peak, 2);
  });
});
