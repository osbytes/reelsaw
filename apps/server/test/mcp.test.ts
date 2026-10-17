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
import { BASE, db, signUp } from "./helpers.js";

async function createKey(cookie: string, name: string): Promise<{ id: string; key: string }> {
  const res = await fetch(`${BASE}/api/auth/api-key/create`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, cookie }, body: JSON.stringify({ name }) });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  return JSON.parse(body) as { id: string; key: string };
}

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
    for (const n of ["list_projects", "get_project", "create_project", "wait_for_project", "get_transcript", "get_clip", "update_clip", "create_clip", "rerender_clip", "delete_project"]) assert.ok(names.includes(n), n);
  });

  it("sees only the caller's projects", async () => {
    const r = await client.callTool({ name: "list_projects", arguments: {} });
    const rows = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Array<{ id: string; title: string; clips: string }>;
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

  it("authenticates tRPC and media routes with the key", async () => {
    const h = { authorization: `Bearer ${apiKey.key}` };
    const t = await fetch(`${BASE}/api/trpc/projects.list`, { headers: h });
    assert.equal(t.status, 200);
    const body = (await t.json()) as { result: { data: Array<{ id: string }> } };
    assert.deepEqual(body.result.data.map((p) => p.id), [mine]);
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
