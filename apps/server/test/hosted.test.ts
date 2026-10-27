/**
 * Hosting features against the running app: quotas (instance + per-user override) refuse with a
 * sentence, usage is reported per user, retention removes files but keeps rows, OAuth discovery and
 * dynamic client registration work when MCP_OAUTH=true.
 * Run: pnpm --filter @reelsaw/server test   (needs `docker compose up`)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { BASE, cli, db, dotenv, signUp } from "./helpers.js";

const json = { "content-type": "application/json", origin: BASE };
async function trpc(cookie: string, path: string, input?: unknown, method: "GET" | "POST" = "POST") {
  const url = method === "GET" ? `${BASE}/api/trpc/${path}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}` : `${BASE}/api/trpc/${path}`;
  const res = await fetch(url, { method, headers: { ...json, cookie }, body: method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await res.json()) as { result?: { data: unknown }; error?: { message: string; data: { code: string } } };
  return { status: res.status, data: body.result?.data, error: body.error };
}

describe("hosted", () => {
  const pool = db();
  let admin: Awaited<ReturnType<typeof signUp>>;
  let user: Awaited<ReturnType<typeof signUp>>;
  const projectId = randomUUID();

  before(async () => {
    admin = await signUp();
    user = await signUp();
    await pool.query(`update "user" set role = 'admin' where id = $1`, [admin.userId]);
    await pool.query(
      `insert into projects (id, user_id, title, source_type, source_url, source_key, source_bytes, duration_sec, status, settings, created_at, updated_at)
       values ($1, $2, 'Old', 'url', 'https://example.com/v.mp4', 'projects/none/source.mp4', 123456, 600, 'done', '{}', now() - interval '100 days', now() - interval '100 days')`,
      [projectId, user.userId],
    );
    await pool.query(`insert into llm_usage (user_id, project_id, stage, call, model, input_tokens, output_tokens, ms) values ($1, $2, 'analyze', 'analyze.map', 'test:model', 1000, 200, 50)`, [user.userId, projectId]);
    // projects and minutes in admin.usage come from the source_usage ledger (kept after a purge), not the project row
    await pool.query(`insert into source_usage (user_id, project_id, duration_sec, created_at) values ($1, $2, 600, now() - interval '100 days')`, [user.userId, projectId]);
  });
  after(async () => {
    await pool.query(`delete from "user" where id = any($1)`, [[admin.userId, user.userId]]);
    await pool.query(`delete from llm_usage where user_id = any($1)`, [[admin.userId, user.userId]]);
    await pool.query(`delete from source_usage where user_id = any($1)`, [[admin.userId, user.userId]]);
    await pool.end();
  });

  it("enforces a per-user project limit with a sentence", async () => {
    const set = await trpc(admin.cookie, "admin.users.setLimits", { id: user.userId, limits: { MAX_PROJECTS_PER_USER: 1 } });
    assert.deepEqual(set.data, { ok: true, overrides: { MAX_PROJECTS_PER_USER: 1 } });
    const refused = await trpc(user.cookie, "projects.create", { sourceUrl: "https://example.com/other.mp4" });
    assert.equal(refused.error?.data.code, "TOO_MANY_REQUESTS");
    assert.match(refused.error!.message, /You have 1 projects?, the most this account may keep \(1\)/);
    const lim = (await trpc(admin.cookie, "admin.users.limits", { id: user.userId }, "GET")).data as { effective: Record<string, number> };
    assert.equal(lim.effective.MAX_PROJECTS_PER_USER, 1);
    // back to the instance default; the event is recorded with the change
    const clear = await trpc(admin.cookie, "admin.users.setLimits", { id: user.userId, limits: { MAX_PROJECTS_PER_USER: null } });
    assert.deepEqual(clear.data, { ok: true, overrides: {} });
    const ev = await pool.query(`select count(*)::int as n from admin_events where user_id = $1 and type = 'user.limits_changed'`, [user.userId]);
    assert.equal(ev.rows[0].n, 2);
    assert.equal((await trpc(user.cookie, "admin.users.setLimits", { id: user.userId, limits: {} })).error?.data.code, "FORBIDDEN");
  });

  it("lets an admin turn the watermark off for one account", async () => {
    const off = await trpc(admin.cookie, "admin.users.setWatermark", { id: user.userId, watermark: false });
    assert.deepEqual(off.data, { ok: true, watermark: false });
    const lim = (await trpc(admin.cookie, "admin.users.limits", { id: user.userId }, "GET")).data as { watermark: { override: boolean | null; effective: boolean; source: string } };
    assert.equal(lim.watermark.override, false);
    assert.equal(lim.watermark.effective, false);
    assert.equal(lim.watermark.source, "override");
    const me = (await trpc(user.cookie, "me.get", undefined, "GET")).data as { watermark: { on: boolean; source: string } };
    assert.equal(me.watermark.on, false);
    assert.equal(me.watermark.source, "override");
    const on = await trpc(admin.cookie, "admin.users.setWatermark", { id: user.userId, watermark: true });
    assert.deepEqual(on.data, { ok: true, watermark: true });
    const follow = await trpc(admin.cookie, "admin.users.setWatermark", { id: user.userId, watermark: null });
    assert.deepEqual(follow.data, { ok: true, watermark: null });
    const cleared = (await trpc(admin.cookie, "admin.users.limits", { id: user.userId }, "GET")).data as { watermark: { override: boolean | null; source: string } };
    assert.equal(cleared.watermark.override, null);
    assert.notEqual(cleared.watermark.source, "override");
    const ev = await pool.query(`select count(*)::int as n from admin_events where user_id = $1 and type = 'user.watermark_changed'`, [user.userId]);
    assert.equal(ev.rows[0].n, 3);
    assert.equal((await trpc(user.cookie, "admin.users.setWatermark", { id: user.userId, watermark: false })).error?.data.code, "FORBIDDEN");
    const r = cli(["limits", user.email, "--watermark", "never"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /override never/);
    const fromCli = (await trpc(admin.cookie, "admin.users.limits", { id: user.userId }, "GET")).data as { watermark: { override: boolean | null; effective: boolean } };
    assert.equal(fromCli.watermark.override, false);
    assert.equal(fromCli.watermark.effective, false);
  });

  it("reports usage per user", async () => {
    const r = (await trpc(admin.cookie, "admin.usage", { days: 365 }, "GET")).data as { users: Array<{ id: string; projects: number; sourceMinutes: number; llmCalls: number; llmInputTokens: number; storedBytes: number }> };
    const me = r.users.find((u) => u.id === user.userId)!;
    assert.equal(me.projects, 1);
    assert.equal(me.sourceMinutes, 10);
    assert.equal(me.llmCalls, 1);
    assert.equal(me.llmInputTokens, 1000);
    assert.equal(me.storedBytes, 123456);
    assert.equal((await trpc(user.cookie, "admin.usage", undefined, "GET")).error?.data.code, "FORBIDDEN");
  });

  it("retention removes the stored source but keeps the project", async () => {
    const days = Number(dotenv().SOURCE_RETENTION_DAYS ?? "0");
    if (!days) {
      // sweep is off on this instance: the project is untouched and the control reads as a no-op
      const r = cli(["retention"]);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /SOURCE_RETENTION_DAYS=0/);
      return;
    }
    const r = cli(["retention"]);
    assert.equal(r.code, 0, r.out);
    const row = await pool.query(`select source_expired_at is not null as expired, source_bytes from projects where id = $1`, [projectId]);
    assert.deepEqual(row.rows[0], { expired: true, source_bytes: null });
    const p = (await trpc(user.cookie, "projects.get", { id: projectId }, "GET")).data as { sourceVideoUrl: string | null; sourceExpiredAt: string | null };
    assert.equal(p.sourceVideoUrl, null);
    assert.ok(p.sourceExpiredAt);
    const ev = await pool.query(`select type from project_events where project_id = $1 and type = 'source.expired'`, [projectId]);
    assert.equal(ev.rows.length, 1);
  });

  it("serves OAuth discovery and registers MCP clients when MCP_OAUTH=true", async () => {
    const on = /^(1|true|yes|on)$/i.test(dotenv().MCP_OAUTH ?? "");
    const challenge = await fetch(`${BASE}/api/mcp`, { method: "POST", headers: { ...json, accept: "application/json, text/event-stream" }, body: "{}" });
    assert.equal(challenge.status, 401);
    const www = challenge.headers.get("www-authenticate") ?? "";
    if (!on) {
      assert.doesNotMatch(www, /resource_metadata/);
      assert.equal((await fetch(`${BASE}/.well-known/oauth-protected-resource/api/mcp`)).status, 404);
      return;
    }
    assert.match(www, /resource_metadata="http:\/\/localhost:3100\/\.well-known\/oauth-protected-resource\/api\/mcp"/);
    const prm = (await (await fetch(`${BASE}/.well-known/oauth-protected-resource/api/mcp`)).json()) as { resource: string; authorization_servers: string[] };
    assert.equal(prm.resource, `${BASE}/api/mcp`);
    assert.ok(prm.authorization_servers.length);
    // RFC 8414 with an issuer that has a path (/api/auth): metadata lives at /.well-known/oauth-authorization-server/api/auth
    const issuer = new URL(prm.authorization_servers[0]!);
    const asUrl = `${issuer.origin}/.well-known/oauth-authorization-server${issuer.pathname}`;
    const as = (await (await fetch(asUrl)).json()) as { authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; code_challenge_methods_supported: string[] };
    assert.match(as.authorization_endpoint, /\/api\/auth\/oauth2\/authorize$/);
    assert.ok(as.registration_endpoint, "dynamic client registration must be advertised");
    assert.ok(as.code_challenge_methods_supported.includes("S256"));
    const reg = await fetch(as.registration_endpoint!, { method: "POST", headers: json, body: JSON.stringify({ client_name: "test connector", redirect_uris: ["https://example.com/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) });
    const client = (await reg.json()) as { client_id?: string; error?: string; error_description?: string };
    assert.equal(reg.status, 201, JSON.stringify(client));
    assert.ok(client.client_id);
    // a made-up bearer token is refused, not treated as an API key
    const bad = await fetch(`${BASE}/api/mcp`, { method: "POST", headers: { ...json, accept: "application/json, text/event-stream", authorization: "Bearer not-a-real-token" }, body: "{}" });
    assert.equal(bad.status, 401);
    await pool.query(`delete from oauth_client where client_id = $1`, [client.client_id]);
  });
});
