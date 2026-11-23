/**
 * The admin's list of accounts (Users page, `list_users`, `reelsaw users`) and the filter it shares with
 * bulk actions (`bulkUsers` in accounts.ts), so "select all 1,204 matching" acts on exactly what the list
 * counted. One implementation behind every surface (PRINCIPLES: "Surfaces").
 */
import { and, asc, desc, sql, type SQL } from "drizzle-orm";
import type { z } from "zod";
import {
  ABUSE_FLAGS,
  type AbuseFlag,
  FLAG_GROUPS,
  type FlagGroup,
  flagGroupHelp,
  flagGroupLabel,
  IP_GROUP_REST,
  ipGroupHelp,
  ipGroupLabel,
  isAbuseFlag,
  MAX_IP_GROUPS,
  type UserGroupBy,
  type SortDir,
  type UserSortKey,
  userSortFirstDir,
} from "@reelsaw/shared";
import { schema, type Db } from "./db/index.js";
import type { Services } from "./services.js";
import { decodeCursor, pageOf } from "./pagination.js";
import { allTimeUsageSql, usageByUser } from "./quota.js";
import type { UserFilter, UserStatus, userGroupsInput, userListInput } from "./accounts-schema.js";
import { SEARCH_USERS, setSearchThreshold, userMatch, userScore, words } from "./search.js";
import { msg } from "@lingui/core/runtime-macro";
import { AppError } from "./i18n.js";

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
    f.flag ? sql`${U.flags} @> ${JSON.stringify([f.flag])}::jsonb` : undefined,
    status,
    f.verified === undefined ? undefined : sql`${U.emailVerified} = ${f.verified}`,
    f.heldBy ? sql`${U.heldBy} = ${f.heldBy}` : undefined,
    f.group ? flagGroupWhere(f.group.key) : undefined,
    f.signupIp ? sql`${U.signupIp} = ${f.signupIp}` : undefined,
    f.sharedIp === undefined ? undefined : f.sharedIp ? sharedIp : sql`not ${sharedIp}`,
  );
}

/** One section of group-by-flag as SQL; `inFlagGroup` in shared is the same rule for a loaded row. */
const flagGroupWhere = (k: FlagGroup): SQL => (k === "none" ? sql`jsonb_array_length(${U.flags}) = 0` : sql`${U.flags} @> ${JSON.stringify([k])}::jsonb`);

/**
 * Another account signed up from this account's address (any account, not only the filtered ones, so an address's
 * section does not depend on the filter). `user_signup_ip_idx` answers it. Accounts with no address are never shared.
 */
const sharedIp = sql`(${U.signupIp} is not null and exists (select 1 from ${U} as other where other.signup_ip = ${U.signupIp} and other.id <> ${U.id}))`;

type Section = { key: string; label: string; help: string; total: number; filter: UserFilter };

/** The section keys and counts of one grouping over `where`, in display order, and how many sections were left out. */
async function sectionsOf(db: Db, by: UserGroupBy, filter: UserFilter, where: SQL): Promise<{ sections: Section[]; moreSections: number }> {
  return db.transaction(async (tx) => {
    await setSearchThreshold(tx);
    if (by === "ip") {
      // the busiest addresses first, then the one with the newest sign-up; `addresses` counts them all, before the limit
      const [shared, [rest] = []] = await Promise.all([
        tx.execute<{ key: string; n: number; addresses: number }>(
          sql`select ${U.signupIp} as key, count(*)::int as n, (count(*) over ())::int as addresses from ${U} where ${where} and ${sharedIp} group by 1 order by 2 desc, max(${U.createdAt}) desc, 1 limit ${MAX_IP_GROUPS}`,
        ),
        tx
          .select({ n: sql<number>`count(*)::int` })
          .from(U)
          .where(and(where, sql`not ${sharedIp}`)),
      ]);
      const sections: Section[] = shared.rows.map((r) => ({
        key: r.key,
        label: ipGroupLabel(r.key),
        help: ipGroupHelp(r.key),
        total: Number(r.n),
        filter: { ...filter, signupIp: r.key },
      }));
      if (rest && rest.n > 0)
        sections.push({
          key: IP_GROUP_REST,
          label: ipGroupLabel(IP_GROUP_REST),
          help: ipGroupHelp(IP_GROUP_REST),
          total: rest.n,
          filter: { ...filter, sharedIp: false },
        });
      return { sections, moreSections: Math.max(0, Number(shared.rows[0]?.addresses ?? 0) - shared.rows.length) };
    }
    // a left join keeps the accounts with no flag, as a null key
    const byKey = await tx.execute<{ key: string | null; n: number }>(
      sql`select f.v as key, count(*)::int as n from ${U} left join lateral jsonb_array_elements_text(${U.flags}) as f(v) on true where ${where} group by 1`,
    );
    const counts = new Map<FlagGroup, number>();
    for (const r of byKey.rows) {
      const k: FlagGroup | null = r.key === null ? "none" : isAbuseFlag(r.key) ? r.key : null;
      if (k) counts.set(k, Number(r.n));
    }
    const sections = FLAG_GROUPS.filter((k) => counts.get(k)).map((key) => ({
      key,
      label: flagGroupLabel(key),
      help: flagGroupHelp(key),
      total: counts.get(key) ?? 0,
      filter: { ...filter, group: { by: "flag" as const, key } },
    }));
    return { sections, moreSections: 0 };
  });
}

/**
 * The filtered list in sections (Users page "Group", `list_users` groupBy, `reelsaw users --group`): every section
 * that has accounts, with its count over the whole filter (not a loaded page), the filter that lists or acts on
 * exactly it, and, unless `limit` is 0, its first page from `listUsers`. By flag: FLAG_GROUPS order, the section's
 * filter sets `group`. By address: the shared addresses, busiest first (at most MAX_IP_GROUPS; `moreSections`
 * counts the rest), each filtered by `signupIp`, then `rest` (`sharedIp: false`). `total` counts each account
 * once, though one with two flags is in two flag sections.
 */
export async function userGroups(svc: Services, input: z.input<typeof userGroupsInput>) {
  const { by, limit = 20, sort, dir, ...filter } = input;
  orderOf({ sort, dir });
  const db = svc.database.db;
  const where = and(userMatch(words(filter.q ?? "")), userFilterWhere(filter)) ?? sql`true`;
  const [{ sections, moreSections }, total] = await Promise.all([
    sectionsOf(db, by, filter, where),
    db.transaction(async (tx) => {
      await setSearchThreshold(tx);
      const [r] = await tx.select({ total: sql<number>`count(*)::int` }).from(U).where(where);
      return r?.total ?? 0;
    }),
  ]);
  const groups = await Promise.all(
    sections.map(async (s) => {
      const page = limit > 0 ? await listUsers(svc, { ...s.filter, sort, dir, limit }) : null;
      /** `filter`: list_users / manage_users / the bulk bar with exactly this section */
      return { ...s, ...(page ? { items: page.items, nextCursor: page.nextCursor } : {}) };
    }),
  );
  return { by, total, moreSections, groups };
}

/**
 * How many accounts carry each flag, and how many carry any: the Users page's "Flag" filter options. Every
 * account counts, suspended ones too, so a number is what picking that option lists.
 */
export async function flagCounts(db: Db): Promise<{ any: number } & Record<AbuseFlag, number>> {
  const [byFlag, [{ any } = { any: 0 }]] = await Promise.all([
    db.execute<{ flag: string; n: number }>(sql`select f as flag, count(*)::int as n from ${U}, jsonb_array_elements_text(${U.flags}) as f group by f`),
    db.select({ any: sql<number>`count(*)::int` }).from(U).where(sql`jsonb_array_length(${U.flags}) > 0`),
  ]);
  const out = { any, ...Object.fromEntries(ABUSE_FLAGS.map((f) => [f, 0])) } as { any: number } & Record<AbuseFlag, number>;
  for (const r of byFlag.rows) if (isAbuseFlag(r.flag)) out[r.flag] = Number(r.n);
  return out;
}

/**
 * When the account was last active, in seconds since the epoch (0 = never): the later of the activity stamp and its
 * newest session (`session_user_id_idx`). The list shows it and the lastActive sort orders by it, so the two
 * cannot disagree. Both columns are read as UTC, whatever the server's time zone.
 */
const lastActiveSql = sql`greatest(coalesce(extract(epoch from ${U.lastActiveAt}), 0), coalesce((select extract(epoch from max(${schema.session.updatedAt})) from ${schema.session} where ${schema.session.userId} = ${U.id}), 0))::numeric`;

const num = (expr: SQL) => ({ expr: sql`(${expr})::numeric`, value: (v: string) => sql`${v}::numeric` });
/**
 * Each sortable column as one SQL value per account, so the database orders every match (not a loaded page) and the
 * keyset cursor carries it back as a string. The usage columns order by the all-time `usage.*` numbers of each row
 * (`allTimeUsageSql` in quota.ts, the definitions `usageByUser` and the storage quota use; the stack test
 * users-sort-stack.test.ts checks they agree). Every value is non-null so (value, id) row comparisons page cleanly.
 */
export const USER_SORT_SQL: Record<UserSortKey, { expr: SQL; value: (v: string) => SQL }> = {
  name: { expr: sql`lower(coalesce(nullif(${U.name}, ''), ${U.email}))`, value: (v) => sql`${v}::text` },
  status: {
    expr: sql`(case when ${U.banned} then 'suspended' when ${U.approvedAt} is not null then 'active' else 'pending' end)`,
    value: (v) => sql`${v}::text`,
  },
  projects: num(allTimeUsageSql.projects(sql`${U.id}`)),
  sourceMinutes: num(allTimeUsageSql.sourceMinutes(sql`${U.id}`)),
  clipsRendered: num(allTimeUsageSql.clipsRendered(sql`${U.id}`)),
  storedBytes: num(allTimeUsageSql.storedBytes(sql`${U.id}`)),
  lastActive: num(lastActiveSql),
  created: num(sql`extract(epoch from ${U.createdAt})`),
};

/**
 * The sort a list call asked for, with its default direction. `dir` without `sort` is refused rather than ignored,
 * on every surface (the CLI, tRPC and list_users share this).
 */
function orderOf(input: { sort?: UserSortKey | undefined; dir?: SortDir | undefined } | undefined) {
  if (input?.dir && !input.sort)
    throw new AppError("BAD_REQUEST", msg({ id: "list.dir_needs_sort", message: "dir needs sort: say which column to order by." }));
  return input?.sort ? { key: input.sort, dir: input.dir ?? userSortFirstDir(input.sort), ...USER_SORT_SQL[input.sort] } : null;
}

/**
 * The sort key of the unsearched list: pending first, then newest. `user_list_idx` is on exactly this
 * expression, `created_at desc, id desc`, so a page reads an index range instead of sorting every account.
 */
export const approvedRank = sql<number>`(case when ${U.approvedAt} is null then 0 else 1 end)`;

/**
 * Keyset page of accounts: pending first, then newest first, with each account's all-time usage from one
 * grouped query per metric table (see `usageByUser`) for just the page. A search returns the best
 * SEARCH_USERS matches in one page (no cursor; `total` says how many match). With `sort`, every match is
 * ordered by that column in SQL (`USER_SORT_SQL`) and paged by (value, id), searched or not.
 */
export async function listUsers(svc: Services, input: z.input<typeof userListInput> | undefined) {
  const db = svc.database.db;
  const limit = input?.limit ?? 50;
  const ws = words(input?.q ?? "");
  const match = userMatch(ws);
  const score = userScore(ws);
  const filter = userFilterWhere(input ?? {});
  const order = orderOf(input);
  let after: SQL | undefined;
  if (order && input?.cursor) {
    // the cursor names its sort, so one from another order is refused instead of misread
    const c = decodeCursor(input.cursor, 4);
    if (!c || c[0] !== order.key || c[1] !== order.dir) throw new AppError("BAD_REQUEST", msg({ id: "list.invalid_cursor", message: "Invalid cursor" }));
    const at = sql`(${order.value(String(c[2]))}, ${String(c[3])})`;
    after = order.dir === "asc" ? sql`(${order.expr}, ${U.id}) > ${at}` : sql`(${order.expr}, ${U.id}) < ${at}`;
  } else if (!order && !ws.length && input?.cursor) {
    const c = decodeCursor(input.cursor, 3);
    if (!c) throw new AppError("BAD_REQUEST", msg({ id: "list.invalid_cursor", message: "Invalid cursor" }));
    after = sql`(${approvedRank} > ${Number(c[0])} or (${approvedRank} = ${Number(c[0])} and (${U.createdAt}, ${U.id}) < (${String(c[1])}::timestamp, ${String(c[2])})))`;
  }
  // a search without a sort is its best matches, in one page; with a sort, every match pages in that order
  const ranked = ws.length > 0 && !order;
  const pageSize = ranked ? SEARCH_USERS : limit;
  // with a sort, ORDER BY names the selected sort_value so Postgres computes it once per row for both
  const orderBy = order
    ? order.dir === "asc"
      ? [sql`sort_value asc`, asc(U.id)]
      : [sql`sort_value desc`, desc(U.id)]
    : [...(score ? [desc(score)] : []), approvedRank, desc(U.createdAt), desc(U.id)];
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
          heldBy: U.heldBy,
          mustChangePassword: U.mustChangePassword,
          /** seconds since the epoch, 0 = never; the same expression the lastActive sort orders by */
          lastActiveSec: sql<string>`${lastActiveSql}`,
          createdAt: U.createdAt,
          approved: approvedRank,
          ts: sql<string>`${U.createdAt}::text`,
          // numeric and text both arrive as strings: exactly the value the cursor carries back
          sortValue: sql<string | null>`${order ? order.expr : sql`null`}`.as("sort_value"),
        })
        .from(U)
        .where(and(match, filter, after))
        .orderBy(...orderBy)
        .limit(pageSize + 1),
      tx.select({ total: sql<number>`count(*)::int` }).from(U).where(and(match, filter)),
    ]);
  });
  const { items, nextCursor } = ranked
    ? { items: fetched.slice(0, pageSize), nextCursor: null }
    : order
      ? pageOf(fetched, limit, (r) => [order.key, order.dir, String(r.sortValue), r.id])
      : pageOf(fetched, limit, (r) => [r.approved, r.ts, r.id]);
  const ids = items.map((r) => r.id);
  const [usage, plans] = await Promise.all([
    usageByUser(db, null, ids),
    svc.ee ? svc.ee.billing.plansOf(ids) : new Map<string, { plan: string; status: string }>(),
  ]);
  const usageOf = new Map(usage.map((u) => [u.id, u]));
  return {
    items: items.map(({ approved: _a, ts: _t, sortValue: _s, lastActiveSec, ...r }) => {
      const lastMs = Math.round(Number(lastActiveSec) * 1000);
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
