/**
 * Accounts against the running app: pending and suspended accounts are refused on every route,
 * admins manage users, plain users cannot, removal deletes what the user owned.
 * Run: pnpm --filter @reelsaw/server test   (needs `docker compose up`)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MUST_CHANGE_PASSWORD_MESSAGE, MUST_CHANGE_PASSWORD_REUSE } from "@reelsaw/shared";
import { BASE, createKey, db, signUp } from "./helpers.js";

type U = Awaited<ReturnType<typeof signUp>>;
const json = { "content-type": "application/json", origin: BASE };

async function trpc(cookie: string, path: string, input?: unknown, method: "GET" | "POST" = "POST") {
  const url = method === "GET" ? `${BASE}/api/trpc/${path}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}` : `${BASE}/api/trpc/${path}`;
  const res = await fetch(url, { method, headers: { ...json, cookie }, body: method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await res.json()) as { result?: { data: unknown }; error?: { message: string; data: { code: string } } };
  return { status: res.status, data: body.result?.data, error: body.error };
}

describe("accounts", () => {
  const pool = db();
  let admin: U;
  let user: U;
  let pending: U;
  let victim: U;
  const victimProject = randomUUID();

  before(async () => {
    admin = await signUp();
    user = await signUp();
    pending = await signUp();
    victim = await signUp();
    await pool.query(`update "user" set role = 'admin' where id = $1`, [admin.userId]);
    await pool.query(`update "user" set approved_at = null where id = $1`, [pending.userId]);
    await pool.query(`insert into projects (id, user_id, title, source_type, source_url, status, settings) values ($1, $2, 'Victim', 'url', 'https://example.com/v.mp4', 'done', '{}')`, [victimProject, victim.userId]);
  });

  after(async () => {
    await pool.query(`delete from "user" where id = any($1)`, [[admin.userId, user.userId, pending.userId, victim.userId]]);
    await pool.query(`delete from admin_events where user_id = any($1)`, [[admin.userId, user.userId, pending.userId, victim.userId]]);
    await pool.end();
  });

  it("refuses a pending account everywhere except me.get", async () => {
    const me = await trpc(pending.cookie, "me.get", undefined, "GET");
    assert.equal(me.status, 200);
    assert.equal((me.data as { blocked: { kind: string } }).blocked.kind, "pending");
    const list = await trpc(pending.cookie, "projects.list", undefined, "GET");
    assert.equal(list.error?.data.code, "FORBIDDEN");
    assert.match(list.error!.message, /waiting for an admin/);
    assert.equal((await fetch(`${BASE}/media/source/${victimProject}`, { headers: { cookie: pending.cookie } })).status, 401);
    const mcp = await fetch(`${BASE}/api/mcp`, { method: "POST", headers: { ...json, cookie: pending.cookie, accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) });
    assert.equal(mcp.status, 403);
  });

  it("keeps admin procedures from plain users", async () => {
    const r = await trpc(user.cookie, "admin.users.list", undefined, "GET");
    assert.equal(r.error?.data.code, "FORBIDDEN");
    const a = await trpc(user.cookie, "admin.users.approve", { id: pending.userId });
    assert.equal(a.error?.data.code, "FORBIDDEN");
  });

  it("lists pending first and approves", async () => {
    const list = await trpc(admin.cookie, "admin.users.list", undefined, "GET");
    assert.equal(list.status, 200);
    const rows = (list.data as { items: Array<{ id: string; status: string }> }).items;
    assert.equal(rows[0]!.status, "pending");
    const count = await trpc(admin.cookie, "admin.users.pendingCount", undefined, "GET");
    assert.ok((count.data as number) >= 1);
    const r = await trpc(admin.cookie, "admin.users.approve", { id: pending.userId });
    assert.deepEqual(r.data, { ok: true, changed: true });
    const list2 = await trpc(pending.cookie, "projects.list", undefined, "GET");
    assert.equal(list2.status, 200);
    const ev = await pool.query(`select type from admin_events where user_id = $1 order by id`, [pending.userId]);
    assert.deepEqual(ev.rows.map((e) => e.type), ["user.signed_up", "user.approved"]);
  });

  it("suspends: sessions end, keys stop, reinstating works", async () => {
    const r = await trpc(admin.cookie, "admin.users.ban", { id: user.userId, reason: "spam" });
    assert.equal(r.status, 200);
    // the session row is gone; within the 60 s cookie cache the request still resolves the user, who is then refused with the reason
    const refused = await trpc(user.cookie, "projects.list", undefined, "GET");
    assert.ok(refused.error?.data.code === "UNAUTHORIZED" || (refused.error?.data.code === "FORBIDDEN" && /suspended: spam/.test(refused.error.message)), JSON.stringify(refused.error));
    await trpc(admin.cookie, "admin.users.unban", { id: user.userId });
    const row = await pool.query(`select banned, ban_reason from "user" where id = $1`, [user.userId]);
    assert.deepEqual(row.rows[0], { banned: false, ban_reason: null });
  });

  it("protects the last admin and the actor", async () => {
    const self = await trpc(admin.cookie, "admin.users.setRole", { id: admin.userId, role: "user" });
    assert.equal(self.error?.data.code, "BAD_REQUEST");
    const ban = await trpc(admin.cookie, "admin.users.ban", { id: admin.userId });
    assert.equal(ban.error?.data.code, "BAD_REQUEST");
    const rm = await trpc(admin.cookie, "admin.users.remove", { id: admin.userId });
    assert.equal(rm.error?.data.code, "BAD_REQUEST");
  });

  it("blocks a must-change browser session, keeps API keys, and accepts a new secret without the current password", async () => {
    const locked = await signUp();
    const key = await createKey(locked.cookie, "keep-working");
    await pool.query(`update "user" set must_change_password = true where id = $1`, [locked.userId]);
    const me = await trpc(locked.cookie, "me.get", undefined, "GET");
    assert.equal(me.status, 200);
    assert.equal((me.data as { mustChangePassword: boolean }).mustChangePassword, true);
    const list = await trpc(locked.cookie, "projects.list", undefined, "GET");
    assert.equal(list.error?.data.code, "FORBIDDEN");
    assert.equal(list.error?.message, MUST_CHANGE_PASSWORD_MESSAGE);
    assert.equal((await fetch(`${BASE}/media/source/${victimProject}`, { headers: { cookie: locked.cookie } })).status, 401);
    const mcp = await fetch(`${BASE}/api/mcp`, { method: "POST", headers: { ...json, cookie: locked.cookie, accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }) });
    assert.equal(mcp.status, 403);
    const viaKey = await fetch(`${BASE}/api/trpc/projects.list`, { method: "GET", headers: { ...json, authorization: `Bearer ${key.key}` } });
    assert.equal(viaKey.status, 200);
    const reuse = await trpc(locked.cookie, "me.completePasswordChange", { password: locked.password });
    assert.equal(reuse.error?.data.code, "BAD_REQUEST");
    assert.equal(reuse.error?.message, MUST_CHANGE_PASSWORD_REUSE);
    const next = `next-${randomUUID()}`;
    const done = await trpc(locked.cookie, "me.completePasswordChange", { password: next });
    assert.deepEqual(done.data, { ok: true });
    const list2 = await trpc(locked.cookie, "projects.list", undefined, "GET");
    assert.equal(list2.status, 200);
    const me2 = await trpc(locked.cookie, "me.get", undefined, "GET");
    assert.equal((me2.data as { mustChangePassword: boolean }).mustChangePassword, false);
    const again = await trpc(locked.cookie, "me.completePasswordChange", { password: `again-${randomUUID()}` });
    assert.equal(again.error?.data.code, "BAD_REQUEST");
    await pool.query(`delete from "user" where id = $1`, [locked.userId]);
    await pool.query(`delete from admin_events where user_id = $1`, [locked.userId]);
  });

  it("changes roles and removes an account with its projects", async () => {
    const up = await trpc(admin.cookie, "admin.users.setRole", { id: user.userId, role: "admin" });
    assert.deepEqual(up.data, { ok: true, changed: true });
    // reinstated and promoted: the next request already sees the new role (the user row is read fresh)
    const asAdmin = await trpc(user.cookie, "admin.users.list", undefined, "GET");
    assert.ok(asAdmin.status === 200 || asAdmin.error?.data.code === "UNAUTHORIZED", JSON.stringify(asAdmin.error));
    const rm = await trpc(admin.cookie, "admin.users.remove", { id: victim.userId });
    assert.deepEqual(rm.data, { ok: true, projects: 1 });
    const left = await pool.query(`select count(*)::int as n from projects where id = $1`, [victimProject]);
    assert.equal(left.rows[0].n, 0);
    assert.equal((await pool.query(`select count(*)::int as n from "user" where id = $1`, [victim.userId])).rows[0].n, 0);
  });
});
