/**
 * The admin's list of accounts (Users page, `list_users`, `reelsaw users`) and the filter it shares with
 * bulk actions (`bulkUsers` in accounts.ts), so "select all 1,204 matching" acts on exactly what the list
 * counted. One implementation behind every surface (PRINCIPLES: "Surfaces").
 */
import { and, desc, inArray, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import { TRPCError } from "@trpc/server";
import { schema, type Db } from "./db/index.js";
import type { Services } from "./services.js";
import { decodeCursor, pageOf } from "./pagination.js";
import { usageByUser } from "./quota.js";
import type { UserFilter, UserStatus, userListInput } from "./accounts-schema.js";
import { SEARCH_USERS, setSearchThreshold, userMatch, userScore, words } from "./search.js";

const U = schema.user;

/** The status the list shows, from the row's columns (a suspended account is suspended whether or not it was approved). */
export const statusOf = (r: { banned: boolean; approvedAt: Date | null }): UserStatus => (r.banned ? "suspended" : r.approvedAt ? "active" : "pending");

/**
 * The filter as SQL, minus the search words (those need `setSearchThreshold` on the same transaction, see
 * `userMatch`). Callers combine it with `userMatch(words(q))`.
 */
export function userFilterWhere(f: Omit<UserFilter, "q">): SQL | undefined {
  const status =
    f.status === "pending"
      ? sql`${U.approvedAt} is null and not ${U.banned}`
      : f.status === "active"
        ? sql`${U.approvedAt} is not null and not ${U.banned}`
        : f.status === "suspended"
          ? sql`${U.banned}`
          : undefined;
  return and(
    f.flagged ? sql`jsonb_array_length(${U.flags}) > 0` : undefined,
    status,
    f.verified === undefined ? undefined : sql`${U.emailVerified} = ${f.verified}`,
  );
}

/**
 * The sort key of the unsearched list: pending first, then newest. `user_list_idx` is on exactly this
 * expression, `created_at desc, id desc`, so a page reads an index range instead of sorting every account.
 */
export const approvedRank = sql<number>`(case when ${U.approvedAt} is null then 0 else 1 end)`;

/**
 * Keyset page of accounts: pending first, then newest first, with each account's all-time usage from one
 * grouped query per metric table (see `usageByUser`) for just the page. A search returns the best
 * SEARCH_USERS matches in one page (no cursor; `total` says how many match).
 */
export async function listUsers(svc: Services, input: z.input<typeof userListInput> | undefined) {
  const db = svc.database.db;
  const limit = input?.limit ?? 50;
  const ws = words(input?.q ?? "");
  const match = userMatch(ws);
  const score = userScore(ws);
  const filter = userFilterWhere(input ?? {});
  let after: SQL | undefined;
  if (!ws.length && input?.cursor) {
    const c = decodeCursor(input.cursor, 3);
    if (!c) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid cursor" });
    after = sql`(${approvedRank} > ${Number(c[0])} or (${approvedRank} = ${Number(c[0])} and (${U.createdAt}, ${U.id}) < (${String(c[1])}::timestamp, ${String(c[2])})))`;
  }
  const pageSize = ws.length ? SEARCH_USERS : limit;
  const [fetched, [{ total } = { total: 0 }]] = await db.transaction(async (tx) => {
    await setSearchThreshold(tx);
    return Promise.all([
      tx
        .select({
          id: U.id,
          name: U.name,
          email: U.email,
          emailVerified: U.emailVerified,
          role: U.role,
          approvedAt: U.approvedAt,
          banned: U.banned,
          banReason: U.banReason,
          flags: U.flags,
          signupIp: U.signupIp,
          mustChangePassword: U.mustChangePassword,
          lastActiveAt: U.lastActiveAt,
          createdAt: U.createdAt,
          approved: approvedRank,
          ts: sql<string>`${U.createdAt}::text`,
        })
        .from(U)
        .where(and(match, filter, after))
        .orderBy(...(score ? [desc(score)] : []), approvedRank, desc(U.createdAt), desc(U.id))
        .limit(pageSize + 1),
      tx.select({ total: sql<number>`count(*)::int` }).from(U).where(and(match, filter)),
    ]);
  });
  const { items, nextCursor } = ws.length ? { items: fetched.slice(0, pageSize), nextCursor: null } : pageOf(fetched, limit, (r) => [r.approved, r.ts, r.id]);
  const ids = items.map((r) => r.id);
  const [usage, sessions, plans] = await Promise.all([
    usageByUser(db, null, ids),
    lastSessions(db, ids),
    svc.ee ? svc.ee.billing.plansOf(ids) : new Map<string, { plan: string; status: string }>(),
  ]);
  const usageOf = new Map(usage.map((u) => [u.id, u]));
  const lastOf = new Map(sessions.map((s) => [s.userId, s.last]));
  return {
    items: items.map(({ approved: _a, ts: _t, lastActiveAt, ...r }) => {
      const sessionLast = lastOf.get(r.id);
      const lastMs = Math.max(lastActiveAt?.getTime() ?? 0, sessionLast ? new Date(sessionLast).getTime() : 0);
      const { id: _id, projectsTotal, ...u } = usageOf.get(r.id)!;
      return {
        ...r,
        projects: projectsTotal,
        usage: u,
        status: statusOf(r),
        /** the plan in force (ee); null when this instance has no plans */
        plan: svc.ee ? (plans.get(r.id)?.plan ?? "free") : null,
        approvedAt: r.approvedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        lastActive: lastMs ? new Date(lastMs).toISOString() : null,
      };
    }),
    nextCursor,
    total,
  };
}

async function lastSessions(db: Db, ids: string[]) {
  if (!ids.length) return [];
  return db
    .select({ userId: schema.session.userId, last: sql<Date>`max(${schema.session.updatedAt})` })
    .from(schema.session)
    .where(inArray(schema.session.userId, ids))
    .groupBy(schema.session.userId);
}
