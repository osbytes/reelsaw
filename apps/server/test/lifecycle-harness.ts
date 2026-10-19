/**
 * In-process harness for the consistency-core tests (uow, lifecycle, reconcile): a minimal `Services` that calls
 * svc.tx / lifecycle / reconcile directly against the dev database, without createServices()'s model checks.
 * Needs only Postgres (see helpers.ts db()). Not a test file itself.
 *
 * The queue is the real pg-boss queue, but only for ids this harness created: jobs for them are pushed an hour
 * into the future (so the running app's workers never pick up a fake clip) and every other project looks like it
 * already has a live job (so reconcile() leaves real projects alone).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { db } from "./helpers.js";
import { schema, type Db } from "../src/db/index.js";
import { createUnitOfWork } from "../src/uow.js";
import { createQueue, type Queue } from "../src/queue/boss.js";
import { createLogger } from "../src/log.js";
import type { Services } from "../src/services.js";

export function lifecycleHarness() {
  const pool = db();
  const database = drizzle(pool, { schema }) as unknown as Db;
  const log = createLogger({ LOG_LEVEL: "fatal", LOG_FORMAT: "json" });
  const real: Queue = createQueue({ RUN_WORKERS: false, SHUTDOWN_GRACE_SECONDS: 1 } as never, pool, false, log);
  const mine = new Set<string>();
  const deletedKeys: string[] = [];
  const queue: Queue = {
    ...real,
    async enqueue(q, data, opts) {
      const key = "clipId" in data ? data.clipId : data.projectId;
      if (!mine.has(key)) return null;
      const id = await real.enqueue(q, data, opts);
      if (id) {
        const exec = opts?.db ?? { executeSql: (t: string, v?: unknown[]) => pool.query(t, v) };
        await exec.executeSql(`update pgboss.job set start_after = now() + interval '1 hour' where id = $1 and state = 'created'`, [id]);
      }
      return id;
    },
    async hasLiveJob(q, key, opts) {
      return mine.has(key) ? real.hasLiveJob(q, key, opts) : true;
    },
    async cancelLiveJobs(q, key, opts) {
      if (mine.has(key)) await real.cancelLiveJobs(q, key, opts);
    },
  };
  const tx = createUnitOfWork(pool, queue, log);
  const runtime = {
    DELETED_RETENTION_DAYS: 7,
    STALL_MINUTES: 15,
    SOURCE_RETENTION_DAYS: 0,
    CLIP_RETENTION_DAYS: 0,
    TRANSCRIPT_CORRECTION: true,
    DISFLUENCY_REMOVAL: true,
    DISFLUENCY_LLM: true,
    REFINE_SCENES: true,
  };
  const svc = {
    tx,
    queue,
    log,
    config: { CLEANUP_WORKDIR: false },
    // the runtime settings a service function reads (instance-settings.ts); tests change the object in place
    settings: { get: () => runtime },
    database: { db: database, pool },
    storage: { delete: async (key: string) => void deletedKeys.push(key) },
    paths: { project: (id: string) => `/tmp/reelsaw-test-nonexistent/${id}` },
  } as unknown as Services;

  const userIds: string[] = [];
  async function makeUser(): Promise<string> {
    const id = `t-${randomUUID().slice(0, 8)}`;
    await pool.query(`insert into "user" (id, name, email) values ($1, 'Test', $2)`, [id, `${id}@example.test`]);
    userIds.push(id);
    return id;
  }
  async function makeProject(userId: string, status: string, over: { runSeq?: number } = {}): Promise<string> {
    const id = `p-${randomUUID().slice(0, 8)}`;
    mine.add(id);
    await pool.query(
      `insert into projects (id, user_id, title, source_type, source_url, status, run_seq, settings) values ($1, $2, 'lifecycle test', 'url', 'https://example.test/v', $3, $4, '{}'::jsonb)`,
      [id, userId, status, over.runSeq ?? 1],
    );
    return id;
  }
  async function makeClip(projectId: string, index: number, status: string, over: { outputKey?: string } = {}): Promise<string> {
    const id = `c-${randomUUID().slice(0, 8)}`;
    mine.add(id);
    await pool.query(
      `insert into clips (id, project_id, index, title, hook, start_sec, end_sec, score, reasoning, hashtags, status, origin, output_key)
       values ($1, $2, $3, 't', 'h', 0, 10, 1, 'r', '[]'::jsonb, $4, 'ai', $5)`,
      [id, projectId, index, status, over.outputKey ?? null],
    );
    return id;
  }
  async function eventCount(projectId: string, type: string): Promise<number> {
    const r = await pool.query(`select count(*)::int as n from project_events where project_id = $1 and type = $2`, [projectId, type]);
    return r.rows[0].n;
  }
  async function jobsFor(keys: string[]): Promise<Array<{ name: string; state: string; singleton_key: string }>> {
    const r = await pool.query(`select name, state, singleton_key from pgboss.job where singleton_key = any($1)`, [keys]);
    return r.rows;
  }
  /**
   * Null when the database can run these tests, else why not: the schema must be at this checkout's migrations
   * (the running stack may be an older build) and pg-boss's tables must exist. Point TEST_DATABASE_URL at a
   * migrated scratch database to run against code newer than the stack.
   */
  async function ready(): Promise<string | null> {
    try {
      // every migration in this checkout's journal must be applied; drizzle records them in drizzle.__drizzle_migrations
      const journal = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "drizzle", "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
      const applied = Number((await pool.query(`select count(*)::int as n from drizzle.__drizzle_migrations`).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n);
      if (applied < journal.entries.length) return `database schema is older than this checkout (${applied} of ${journal.entries.length} migrations applied): rebuild the stack or set TEST_DATABASE_URL to a migrated database`;
      if (!(await pool.query(`select to_regclass('pgboss.job') as t`)).rows[0].t) {
        await real.start();
        await real.boss.stop({ graceful: false, wait: true, close: false } as never);
      }
      return null;
    } catch (err) {
      return `database unavailable: ${(err as Error).message}`;
    }
  }
  async function cleanup() {
    const keys = [...mine];
    if (keys.length) await pool.query(`delete from pgboss.job where singleton_key = any($1)`, [keys]).catch(() => {});
    if (userIds.length) await pool.query(`delete from "user" where id = any($1)`, [userIds]);
    await pool.end();
  }
  return { pool, ready, svc, tx, mine, deletedKeys, makeUser, makeProject, makeClip, eventCount, jobsFor, cleanup };
}
