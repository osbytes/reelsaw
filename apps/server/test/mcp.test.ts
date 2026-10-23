/**
 * MCP server and API keys against the running app: keys authenticate MCP, tRPC and media routes;
 * tools see only the caller's projects; a revoked key stops working.
 * Run: pnpm --filter @reelsaw/server test   (needs `docker compose up`)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BASE, createKey, db, signUp } from "./helpers.js";

function mcpInit(headers: Record<string, string>) {
  return fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } }),
  });
}

describe("mcp", () => {
  const pool = db();
  let owner: Awaited<ReturnType<typeof signUp>>;
  let other: Awaited<ReturnType<typeof signUp>>;
  let apiKey: { id: string; key: string };
  const mine = randomUUID();
  const theirs = randomUUID();
  let client: Client;

  before(async () => {
    owner = await signUp();
    other = await signUp();
    apiKey = await createKey(owner.cookie, "test");
    for (const [id, uid, title] of [
      [mine, owner.userId, "Mine"],
      [theirs, other.userId, "Theirs"],
    ] as const) {
      await pool.query(`insert into projects (id, user_id, title, source_type, source_url, duration_sec, status, settings) values ($1, $2, $3, 'url', 'https://example.com/v.mp4', 61, 'done', '{}')`, [id, uid, title]);
      await pool.query(`insert into transcripts (project_id, language, text, words, raw_words, segments, flags) values ($1, 'en', 'hello world', $2, $2, $3, '[]')`, [
        id,
        JSON.stringify([{ text: "hello", start: 0, end: 0.5 }, { text: "world", start: 0.5, end: 1 }]),
        JSON.stringify([{ start: 0, end: 1, text: "hello world" }, { start: 60, end: 61, text: "bye" }]),
      ]);
      await pool.query(`insert into clips (id, project_id, index, title, hook, start_sec, end_sec, score, reasoning, hashtags, status) values ($1, $2, 0, 'Clip', 'Hook', 0, 1, 80, 'why', '[]', 'done')`, [randomUUID(), id]);
    }
    client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", BASE), { requestInit: { headers: { authorization: `Bearer ${apiKey.key}` } } }));
  });

  after(async () => {
    await client?.close().catch(() => {});
    await pool.query(`delete from "user" where id = any($1)`, [[owner?.userId, other?.userId].filter(Boolean)]);
    await pool.end();
  });

  it("rejects anonymous and bad keys", async () => {
    assert.equal((await mcpInit({})).status, 401);
    assert.equal((await mcpInit({ authorization: "Bearer rs_nope" })).status, 401);
  });

  it("lists the tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    for (const n of ["list_projects", "get_project", "create_project", "wait_for_project", "get_transcript", "search_clips", "get_clip", "update_clip", "create_clip", "rerender_clip", "rerender_clips", "export_project", "delete_project", "list_bumpers", "add_bumper", "set_default_bumper", "remove_bumper", "restore_bumper", "bumper_usage", "set_project_bumpers", "set_clip_bumpers", "restore_project", "restore_clip", "update_project", "delete_clip", "rename_bumper", "list_assets", "add_asset", "update_asset", "remove_asset", "restore_asset", "asset_usage"]) assert.ok(names.includes(n), n);
  });

  it("sees only the caller's projects", async () => {
    const r = await client.callTool({ name: "list_projects", arguments: {} });
    const page = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { projects: Array<{ id: string; title: string; clips: string }>; total: number; nextCursor: string | null };
    const rows = page.projects;
    assert.equal(page.total, 1);
    assert.equal(page.nextCursor, null);
    assert.deepEqual(rows.map((p) => p.id), [mine]);
    assert.equal(rows[0]!.clips, "1/1 rendered");
    const denied = await client.callTool({ name: "get_project", arguments: { id: theirs } });
    assert.equal(denied.isError, true);
    assert.match((denied.content as Array<{ text: string }>)[0]!.text, /NOT_FOUND/);
  });

  it("returns a timed transcript with range and truncation", async () => {
    const all = await client.callTool({ name: "get_transcript", arguments: { id: mine } });
    const text = (all.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /\[0:00\] hello world\n\[1:00\] bye/);
    const late = await client.callTool({ name: "get_transcript", arguments: { id: mine, fromSec: 30 } });
    assert.doesNotMatch((late.content as Array<{ text: string }>)[0]!.text, /hello/);
  });

  it("validates tool input", async () => {
    const r = await client.callTool({ name: "create_project", arguments: { sourceUrl: "not a url" } });
    assert.equal(r.isError, true);
  });

  it("lists an empty bumper library and validates set_clip_bumpers input", async () => {
    const r = await client.callTool({ name: "list_bumpers", arguments: {} });
    assert.deepEqual(JSON.parse((r.content as Array<{ text: string }>)[0]!.text), { assets: [], removed: [] });
    const noClips = await client.callTool({ name: "set_clip_bumpers", arguments: { projectId: mine, clipIds: [], rerender: false } });
    assert.equal(noClips.isError, true);
    const foreign = await client.callTool({ name: "set_clip_bumpers", arguments: { projectId: theirs, clipIds: [randomUUID()], intro: "none", rerender: false } });
    assert.equal(foreign.isError, true);
    assert.match((foreign.content as Array<{ text: string }>)[0]!.text, /NOT_FOUND/);
    const got = await client.callTool({ name: "get_project", arguments: { id: mine } });
    const p = JSON.parse((got.content as Array<{ text: string }>)[0]!.text) as { bumpers: { intro: { source: string } }; clips: Array<{ bumpers: unknown }> };
    assert.equal(p.bumpers.intro.source, "none");
    assert.ok(p.clips[0]!.bumpers);
  });

  const call = async <T>(name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    return { isError: r.isError === true, text, data: (r.isError ? null : JSON.parse(text)) as T };
  };

  it("update_project saves title and settings without re-running anything", async () => {
    const r = await call<{ changed: string[]; needsReanalyze: boolean; needsRerender: boolean; hint?: string }>("update_project", { id: mine, title: "Renamed", settings: { focus: "money", captionSize: 1.2 } });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(r.data.changed.sort(), ["captionSize", "focus", "title"]);
    assert.equal(r.data.needsReanalyze, true);
    assert.equal(r.data.needsRerender, true);
    const p = (await call<{ title: string; status: string; settings: Record<string, unknown> }>("get_project", { id: mine })).data;
    assert.equal(p.title, "Renamed");
    assert.equal(p.status, "done"); // nothing re-ran
    assert.equal(p.settings.focus, "money");
    assert.equal(p.settings.captionSize, 1.2);
    assert.equal(p.settings.captions, undefined); // a partial patch writes only its keys
    const cleared = await call<{ changed: string[] }>("update_project", { id: mine, clear: ["focus"] });
    assert.deepEqual(cleared.data.changed, ["focus"]);
    assert.equal((await call<{ settings: Record<string, unknown> }>("get_project", { id: mine })).data.settings.focus, undefined);
    const bumper = await call("update_project", { id: mine, settings: { introAssetId: "x" } });
    assert.equal(bumper.isError, true);
    assert.match(bumper.text, /set_project_bumpers/);
    const bad = await call("update_project", { id: mine, settings: { minClipSeconds: 90, maxClipSeconds: 60 } });
    assert.equal(bad.isError, true);
    assert.equal((await call("update_project", { id: theirs, title: "Mine now" })).isError, true);
  });

  it("delete_clip hides a clip until restore_clip brings it back", async () => {
    const p = (await call<{ clips: Array<{ id: string }> }>("get_project", { id: mine })).data;
    const id = p.clips[0]!.id;
    const del = await call<{ changed: boolean; restorable: string }>("delete_clip", { id });
    assert.equal(del.isError, false, del.text);
    assert.equal(del.data.changed, true);
    const after = (await call<{ clips: unknown[]; replacedClips: Array<{ id: string }> }>("get_project", { id: mine })).data;
    assert.equal(after.clips.length, 0);
    assert.deepEqual(after.replacedClips.map((c) => c.id), [id]);
    const gone = await call("get_clip", { id });
    assert.equal(gone.isError, true);
    assert.match(gone.text, /restore_clip/);
    assert.equal((await call<{ changed: boolean }>("delete_clip", { id })).data.changed, false);
    const back = await call<{ changed: boolean }>("restore_clip", { id });
    assert.equal(back.data.changed, true);
    assert.equal((await call<{ clips: unknown[] }>("get_project", { id: mine })).data.clips.length, 1);
    const theirClip = (await pool.query(`select id from clips where project_id = $1`, [theirs])).rows[0]!.id as string;
    assert.equal((await call("delete_clip", { id: theirClip })).isError, true);
  });

  it("rename_bumper renames only the caller's library items", async () => {
    const asset = randomUUID();
    await pool.query(`insert into bumper_assets (id, user_id, kind, name, duration_sec, width, height, has_audio, source_key, size_bytes) values ($1, $2, 'image', 'Old', 3, 1080, 1920, false, 'bumpers/x.png', 10)`, [asset, owner.userId]);
    const r = await call<{ name: string; previousName: string }>("rename_bumper", { assetId: asset, name: "  New name " });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual([r.data.previousName, r.data.name], ["Old", "New name"]);
    assert.equal((await pool.query(`select name from bumper_assets where id = $1`, [asset])).rows[0]!.name, "New name");
    assert.equal((await call("rename_bumper", { assetId: asset, name: "   " })).isError, true);
    assert.equal((await call("rename_bumper", { assetId: randomUUID(), name: "x" })).isError, true);
  });

  it("update_asset sets category and tags; asset_usage reads asset_refs", async () => {
    const asset = randomUUID();
    await pool.query(`insert into bumper_assets (id, user_id, kind, name, duration_sec, width, height, has_audio, source_key, size_bytes) values ($1, $2, 'image', 'Logo', 3, 1080, 1920, false, 'assets/x/source.png', 10)`, [asset, owner.userId]);
    const r = await call<{ category: string; tags: string[] }>("update_asset", { assetId: asset, category: "logo", tags: ["Brand", "brand", "blue"] });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual([r.data.category, r.data.tags], ["logo", ["brand", "blue"]]);
    const u = await call<{ projects: unknown[] }>("asset_usage", { assetId: asset });
    assert.deepEqual(u.data.projects, []);
    assert.equal((await call("update_asset", { assetId: asset, category: "nonsense" })).isError, true);
  });

  it("authenticates tRPC and media routes with the key", async () => {
    const h = { authorization: `Bearer ${apiKey.key}` };
    const t = await fetch(`${BASE}/api/trpc/projects.list`, { headers: h });
    assert.equal(t.status, 200);
    const body = (await t.json()) as { result: { data: { items: Array<{ id: string }> } } };
    assert.deepEqual(body.result.data.items.map((p) => p.id), [mine]);
    // the project has no stored source: auth passes (not 401), the file is missing (404)
    assert.equal((await fetch(`${BASE}/media/source/${mine}`, { headers: h })).status, 404);
    assert.equal((await fetch(`${BASE}/media/source/${theirs}`, { headers: h })).status, 404);
    assert.equal((await fetch(`${BASE}/api/trpc/projects.list`)).status, 401);
  });

  it("stops working once revoked", async () => {
    const res = await fetch(`${BASE}/api/auth/api-key/delete`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie: owner.cookie }, body: JSON.stringify({ keyId: apiKey.id }) });
    assert.equal(res.status, 200, res.statusText);
    assert.equal((await mcpInit({ authorization: `Bearer ${apiKey.key}` })).status, 401);
  });
});
