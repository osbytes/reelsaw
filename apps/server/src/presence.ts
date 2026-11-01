/**
 * Best-effort "last active" stamp. Better Auth refreshes `session.updated_at` on its own clock
 * (often a day), which is too coarse to decide whether someone is still looking at a finished
 * project. Authenticated requests update `user.last_active_at` instead, and a failure never
 * fails the request.
 *
 * Writes are coalesced to one every couple of seconds per account per process (`lru-cache` ttl).
 * A caller that just handed the account a `project.done` or `clip.done` (the event stream) passes
 * `force` so the stamp moves even inside that window: otherwise a completion a second after the
 * previous write looks unseen.
 *
 * The update itself only moves the column forward (`last_active_at` is null or older than the
 * stamp). Two requests can both pass the in-process cache; the older one must not win.
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { LRUCache } from "lru-cache";
import { schema, type Db } from "./db/index.js";
import type { Logger } from "./log.js";

const GAP_MS = 2_000;
/** Accounts touched in this process during the coalesce window. Expired entries drop out; the cap bounds a burst. */
const recent = new LRUCache<string, true>({ max: 10_000, ttl: GAP_MS });

export function touchLastActive(db: Db, log: Logger, userId: string, opts?: { force?: boolean }): void {
  if (!opts?.force && recent.has(userId)) return;
  recent.set(userId, true);
  const stamp = new Date();
  void db
    .update(schema.user)
    .set({ lastActiveAt: stamp })
    .where(and(eq(schema.user.id, userId), or(isNull(schema.user.lastActiveAt), lt(schema.user.lastActiveAt, stamp))))
    .catch((err) => log.warn({ err, userId, module: "presence" }, "last active not recorded"));
}
