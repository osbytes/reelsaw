/**
 * Per-user settings and the admin/user split: project defaults round-trip and apply to new
 * projects, system settings are admin-only, /api/health hides machine numbers from strangers.
 * Run: pnpm --filter @reelsaw/server test   (needs `docker compose up`)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { BASE, db, signUp } from "./helpers.js";

const json = { "content-type": "application/json", origin: BASE };
async function trpc(cookie: string, path: string, input?: unknown, method: "GET" | "POST" = "POST") {
  const url = method === "GET" ? `${BASE}/api/trpc/${path}${input !== undefined ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}` : `${BASE}/api/trpc/${path}`;
  const res = await fetch(url, { method, headers: { ...json, cookie }, body: method === "POST" ? JSON.stringify(input ?? {}) : undefined });
  const body = (await res.json()) as { result?: { data: unknown }; error?: { message: string; data: { code: string } } };
  return { status: res.status, data: body.result?.data, error: body.error };
}

describe("settings", () => {
  const pool = db();
  let admin: Awaited<ReturnType<typeof signUp>>;
  let user: Awaited<ReturnType<typeof signUp>>;

  before(async () => {
    admin = await signUp();
    user = await signUp();
    await pool.query(`update "user" set role = 'admin' where id = $1`, [admin.userId]);
  });
  after(async () => {
    await pool.query(`delete from "user" where id = any($1)`, [[admin.userId, user.userId]]);
    await pool.end();
  });

  it("keeps system settings to admins and public status to a few words", async () => {
    assert.equal((await trpc(user.cookie, "admin.system", undefined, "GET")).error?.data.code, "FORBIDDEN");
    const sys = await trpc(admin.cookie, "admin.system", undefined, "GET");
    assert.equal(sys.status, 200);
    assert.ok((sys.data as { resources: { cpus: number } }).resources.cpus > 0);
    const pub = (await trpc("", "system.status", undefined, "GET")).data as Record<string, unknown>;
    assert.deepEqual(Object.keys(pub).sort(), ["captcha", "emailEnabled", "maxUploadMb", "paused", "privacyUrl", "signupMode", "telemetry", "termsUrl", "version"]);
  });

  it("shows machine numbers in /api/health to admins only", async () => {
    const anon = (await (await fetch(`${BASE}/api/health`)).json()) as Record<string, unknown>;
    assert.equal(anon.ok, true);
    assert.equal("resources" in anon, false);
    const asAdmin = (await (await fetch(`${BASE}/api/health`, { headers: { cookie: admin.cookie } })).json()) as Record<string, unknown>;
    assert.ok(asAdmin.resources);
    const asUser = (await (await fetch(`${BASE}/api/health`, { headers: { cookie: user.cookie } })).json()) as Record<string, unknown>;
    assert.equal("resources" in asUser, false);
  });

  it("saves project defaults and applies them under the form's values", async () => {
    const r = await trpc(user.cookie, "me.updateProjectDefaults", { vocabulary: "Reelsaw, pg-boss", minClipSeconds: 30, pauses: "tight", language: "" });
    assert.deepEqual(r.data, { ok: true, projectDefaults: { vocabulary: "Reelsaw, pg-boss", minClipSeconds: 30, pauses: "tight" } });
    const me = (await trpc(user.cookie, "me.get", undefined, "GET")).data as { projectDefaults: Record<string, unknown> };
    assert.deepEqual(me.projectDefaults, { vocabulary: "Reelsaw, pg-boss", minClipSeconds: 30, pauses: "tight" });
    // validation at the edge
    assert.equal((await trpc(user.cookie, "me.updateProjectDefaults", { minClipSeconds: 1 })).error?.data.code, "BAD_REQUEST");
    // a new project resolves built-in ← mine ← input (an invalid combination is still refused)
    const bad = await trpc(user.cookie, "projects.create", { sourceUrl: "https://example.com/v.mp4", settings: { maxClipSeconds: 25 } });
    assert.match(bad.error?.message ?? "", /minClipSeconds must be below maxClipSeconds/);
  });
});
