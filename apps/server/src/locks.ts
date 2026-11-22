/**
 * Transaction-scoped advisory locks, one name per thing that is serialised, so two call sites can never spell
 * the same lock differently (and silently stop excluding each other). Every `txLock` is `pg_advisory_xact_lock`:
 * released at commit or rollback, never held across transactions (the one session-level lock is `sessionLock`, below). Keys are strings hashed by `hashtext`;
 * the first-admin lock is a fixed number because it has no subject.
 *
 * Lock order inside a transaction stays what docs/PRINCIPLES.md says (transcript → clip → project); these
 * per-user locks are taken first, before any row lock.
 */
import { sql } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import type { Db } from "./db/index.js";

export const txLock = {
  /** project creation and the quota counts it depends on (quota.ts) */
  quota: (userId: string) => `quota:${userId}`,
  /** admission of a user's jobs against MAX_LIVE_JOBS_PER_USER / MAX_RERENDERS_PER_HOUR (uow.ts) */
  jobs: (userId: string) => `jobs:${userId}`,
  /** the account's billing row: webhook sync, complimentary grants (ee/billing) */
  billing: (userId: string) => `billing:${userId}`,
  /** one upload of the same bytes at a time into a library (own or shared) (library/service.ts createAsset) */
  asset: (owner: string, contentHash: string) => `asset:${owner}:${contentHash}`,
  /** one import of the same catalog / provider item at a time, instance-wide, so two accounts converge on one shared row (library/service.ts createAsset) */
  sharedAsset: (provider: string, externalId: string, variant: string) => `shared-asset:${provider}:${externalId}:${variant}`,
  /** an account's webhook endpoints, counted against MAX_WEBHOOKS_PER_USER when one is added (webhooks/service.ts) */
  webhooks: (userId: string) => `webhooks:${userId}`,
  /** an account's share links: the reuse lookup and the insert it falls back to (media-links/service.ts getOrCreateLink) */
  mediaLinks: (userId: string) => `media-links:${userId}`,
  /** the resource leases of one host (its volume): a job's claim is checked against the live totals and recorded under it (resource-leases.ts) */
  leaseVolume: (volume: string) => `leases:${volume}`,
  /** the cores and memory leased on one machine (resource-leases.ts machineId); taken after leaseVolume */
  leaseMachine: (machine: string) => `leases-machine:${machine}`,
  /** one retry of a project at a time, so an owner's Retry and an automatic one never both start a run (projects/service.ts retryProject) */
  retry: (projectId: string) => `retry:${projectId}`,
  /** the instance's sign-up rules, counted against MAX_SIGNUP_RULES when some are added (signup-rules.ts) */
  signupRules: () => "signup-rules",
  /** the instance's uploaded fonts: one family name at a time, so two uploads of the same family cannot both land (fonts.ts) */
  fonts: () => "fonts",
  /** one word-timestamp test transcription of a model at a time, instance-wide (ai/word-timestamps.ts) */
  transcriptionProbe: (verdictKey: string) => `transcription-probe:${verdictKey}`,
} as const;

/** The one lock with no subject: "which sign-up becomes the first admin" (auth.ts). Arbitrary constant. */
export const FIRST_ADMIN_LOCK = 7_203_104_001;

/** SQL for a raw `pg` client (uow.ts runs on the transaction's connection directly). */
export const TX_LOCK_SQL = "select pg_advisory_xact_lock(hashtext($1))";

/** Take a named lock inside the current transaction (`u.db`, or a drizzle `tx`). */
export async function takeTxLock(db: Pick<Db, "execute">, key: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}

/**
 * Session-level locks (`pg_try_advisory_lock`), for work that spans many transactions and must run in one process at
 * a time. Held on a dedicated pool client for the duration of `fn` and released in `finally`; a process that does not
 * get the lock skips the work (`fn` is not called, the result is `{ ran: false }`). If the client dies, Postgres drops
 * the lock with the session.
 */
export const sessionLock = {
  /** one reconciler tick across all RUN_WORKERS processes (queue/reconcile.ts) */
  reconcile: () => "reconcile",
  /** one full-quality window download (and stitch) per project at a time, across workers (pipeline/sections.ts) */
  sourceWindows: (projectId: string) => `source-windows:${projectId}`,
} as const;

export async function withSessionLock<T>(pool: Pick<Pool, "connect">, key: string, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const client = await pool.connect();
  let held = false;
  try {
    const res = await client.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1)) as ok", [key]);
    held = res.rows[0]?.ok === true;
    if (!held) return { ran: false };
    return { ran: true, value: await fn() };
  } finally {
    // a failed unlock (broken connection) destroys the client instead of returning it to the pool with the lock still held
    const released = held
      ? await client.query("select pg_advisory_unlock(hashtext($1))", [key]).then(
          () => true,
          () => false,
        )
      : true;
    client.release(released ? undefined : true);
  }
}

/**
 * `withSessionLock`, but waits for the lock instead of skipping: polls every `pollMs` until it is free or `signal`
 * aborts. For work every caller needs done, where the second caller should reuse what the first produced.
 */
export async function waitSessionLock<T>(
  pool: Pick<Pool, "connect">,
  key: string,
  fn: () => Promise<T>,
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<T> {
  for (;;) {
    opts.signal?.throwIfAborted();
    const r = await withSessionLock(pool, key, fn);
    if (r.ran) return r.value;
    await delay(opts.pollMs ?? 1000, undefined, { signal: opts.signal });
  }
}
