/**
 * Transaction-scoped advisory locks, one name per thing that is serialised, so two call sites can never spell
 * the same lock differently (and silently stop excluding each other). Every lock is `pg_advisory_xact_lock`:
 * released at commit or rollback, never held across transactions. Keys are strings hashed by `hashtext`;
 * the first-admin lock is a fixed number because it has no subject.
 *
 * Lock order inside a transaction stays what docs/PRINCIPLES.md says (transcript → clip → project); these
 * per-user locks are taken first, before any row lock.
 */
import { sql } from "drizzle-orm";
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
} as const;

/** The one lock with no subject: "which sign-up becomes the first admin" (auth.ts). Arbitrary constant. */
export const FIRST_ADMIN_LOCK = 7_203_104_001;

/** SQL for a raw `pg` client (uow.ts runs on the transaction's connection directly). */
export const TX_LOCK_SQL = "select pg_advisory_xact_lock(hashtext($1))";

/** Take a named lock inside the current transaction (`u.db`, or a drizzle `tx`). */
export async function takeTxLock(db: Db, key: string): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
}
