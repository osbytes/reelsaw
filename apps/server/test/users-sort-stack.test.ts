/**
 * The admin account list sorts on the server (PRINCIPLES "Sorting happens in the database"): every sort key, in
 * both directions, pages through every match in order with no account twice, and the order agrees with the
 * numbers each row shows (so `USER_SORT_SQL` / `allTimeUsageSql` cannot drift from `usageByUser`). A cursor from
 * another sort and a `dir` without `sort` are refused.
 * Run: pnpm --filter @reelsaw/server test   (needs `docker compose up`)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { USER_SORT_KEYS, type UserSortKey } from "@reelsaw/shared";
import { BASE, db, signUp } from "./helpers.js";

type Row = { id: string; name: string; email: string; status: string; createdAt: string; lastActive: string | null; usage: Record<string, number> };
type Page = { items: Row[]; nextCursor: string | null; total: number };

async function list(cookie: string, input: Record<string, unknown>) {
  const url = `${BASE}/api/trpc/admin.users.list?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await fetch(url, { headers: { origin: BASE, cookie } });
  const body = (await res.json()) as { result?: { data: Page }; error?: { message: string } };
  return { data: body.result?.data, error: body.error };
}

/** The value a row shows for a sort key, as the server should order it. */
const shown = (r: Row, k: UserSortKey): string | number => {
  switch (k) {
    case "name":
      return (r.name || r.email).toLowerCase();
    case "status":
      return r.status;
    case "lastActive":
      return r.lastActive ? Date.parse(r.lastActive) : 0;
    case "created":
      return Date.parse(r.createdAt);
    default:
      return r.usage[k] ?? 0;
  }
};

describe("admin account list sorting", () => {
  const pool = db();
  const tag = `srt${randomUUID().slice(0, 6)}`;
  let admin: Awaited<ReturnType<typeof signUp>>;
  const made: string[] = [];
  before(async () => {
    admin = await signUp();
    await pool.query(`update "user" set role = 'admin' where id = $1`, [admin.userId]);
    // four accounts with different names, minutes, project counts and activity, findable by the tag
    for (let i = 0; i < 4; i++) {
      const u = await signUp();
      made.push(u.userId);
      await pool.query(`update "user" set name = $2, last_active_at = now() - make_interval(hours => $3::int) where id = $1`, [
        u.userId,
        `${tag} ${"dbca"[i]}`,
        (i * 7) % 5,
      ]);
      for (let p = 0; p <= (i * 3) % 4; p++)
        await pool.query(`insert into source_usage (user_id, project_id, duration_sec, created_at) values ($1, $2, $3, now())`, [
          u.userId,
          `${tag}-${i}-${p}`,
          60 * (i + 1) * (p + 2),
        ]);
    }
  });
  after(async () => {
    await pool.query(`delete from source_usage where project_id like $1`, [`${tag}-%`]);
    await pool.query(`delete from "user" where id = any($1)`, [[admin.userId, ...made]]);
    await pool.end();
  });

  for (const key of USER_SORT_KEYS)
    for (const dir of ["asc", "desc"] as const)
      it(`${key} ${dir}: pages every match in the order the rows show`, async () => {
        const rows: Row[] = [];
        let cursor: string | undefined;
        do {
          const r = await list(admin.cookie, { q: tag, sort: key, dir, limit: 1, cursor });
          assert.equal(r.error, undefined, r.error?.message);
          rows.push(...r.data!.items);
          cursor = r.data!.nextCursor ?? undefined;
        } while (cursor);
        assert.deepEqual(rows.map((r) => r.id).sort(), [...made].sort(), "every account once");
        const v = rows.map((r) => shown(r, key));
        for (let i = 1; i < v.length; i++)
          assert.ok(dir === "asc" ? v[i - 1]! <= v[i]! : v[i - 1]! >= v[i]!, `${key} ${dir} out of order: ${JSON.stringify(v)}`);
      });

  it("refuses a cursor from another sort, and dir without sort", async () => {
    const first = await list(admin.cookie, { q: tag, sort: "name", limit: 1 });
    assert.ok(first.data?.nextCursor);
    const other = await list(admin.cookie, { q: tag, sort: "storedBytes", limit: 1, cursor: first.data.nextCursor });
    assert.match(other.error?.message ?? "", /Invalid cursor/);
    const bare = await list(admin.cookie, { dir: "asc" });
    assert.match(bare.error?.message ?? "", /dir needs sort/);
  });
});
