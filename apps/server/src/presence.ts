/**
 * Best-effort "last active" stamp: was the person themselves here, recently enough to have seen a
 * finished project? Better Auth refreshes `session.updated_at` on its own clock (often a day), which is
 * too coarse, and an authenticated request is too loose: a tab left open polls (the projects list while
 * anything runs, the admin's approval count) and keeps its event stream connected long after the person
 * walked away. So the stamp moves only on:
 * - `me.presence`, which the web sends while its tab is visible and has had input in the last couple of
 *   minutes (apps/web/src/lib/presence.ts), every 30 s and again as the tab is hidden;
 * - MCP calls: an agent acting for the account is the account at work.
 *
 * Writes are coalesced to one every couple of seconds per account per process (`lru-cache` ttl), and
 * use the database clock (`now()`), the same clock that stamps `project_events.created_at`, so a skewed
 * app host cannot make a completion look seen or unseen. A failure never fails the request.
 */
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { LRUCache } from "lru-cache";
import { schema, type Db } from "./db/index.js";
import type { Logger } from "./log.js";

const GAP_MS = 2_000;
/** Accounts touched in this process during the coalesce window. Expired entries drop out; the cap bounds a burst. */
const recent = new LRUCache<string, true>({ max: 10_000, ttl: GAP_MS });

export function touchLastActive(db: Db, log: Logger, userId: string): void {
  if (recent.has(userId)) return;
  recent.set(userId, true);
  void db
    .update(schema.user)
    .set({ lastActiveAt: sql`now()` })
    .where(and(eq(schema.user.id, userId), or(isNull(schema.user.lastActiveAt), lt(schema.user.lastActiveAt, sql`now()`))))
    .catch((err) => log.warn({ err, userId, module: "presence" }, "last active not recorded"));
}
