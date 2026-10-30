/**
 * `reelsaw mcp` (the stdio bridge): advertises exactly the tools of /api/mcp, answers tools/list
 * with no instance at all, explains a missing key or an unreachable instance as a tool error, and
 * forwards real calls to the running app as the key's owner.
 * Run: pnpm --filter @reelsaw/server test   (needs `docker compose up`)
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pino } from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createStdioBridge, resolveUrl } from "../src/mcp-stdio.js";
import { TOOL_NAMES } from "../src/mcp-tools.js";
import { BASE, createKey, db, signUp } from "./helpers.js";

const silent = pino({ level: "silent" });
const textOf = (r: { content?: unknown }) => (r.content as Array<{ text: string }>)[0]!.text;

/** A client talking to the bridge in this process (no stdio, no instance needed). */
async function inMemory(env: Parameters<typeof createStdioBridge>[0]) {
  const bridge = createStdioBridge(env, silent);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return { client, bridge };
}

describe("mcp stdio bridge", () => {
  it("resolves the instance url from REELSAW_URL, else the app's own port", () => {
    assert.equal(resolveUrl({ REELSAW_URL: "https://clips.example.com" }).toString(), "https://clips.example.com/api/mcp");
    assert.equal(resolveUrl({ PORT: "3100" }).toString(), "http://localhost:3100/api/mcp");
    assert.equal(resolveUrl({}).toString(), "http://localhost:3000/api/mcp");
  });

  it("lists every tool without any instance, and explains a missing key", async () => {
    const { client, bridge } = await inMemory({ REELSAW_URL: "http://127.0.0.1:1" });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(names, [...TOOL_NAMES].sort());
      const r = await client.callTool({ name: "list_projects", arguments: {} });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /REELSAW_API_KEY is not set/);
      const noInput = await client.callTool({ name: "search_assets", arguments: {} });
      assert.equal(noInput.isError, true);
      assert.match(textOf(noInput), /REELSAW_API_KEY/);
    } finally {
      await client.close();
      await bridge.close();
    }
  });

  it("reports an unreachable instance as a tool error and keeps serving", async () => {
    const { client, bridge } = await inMemory({ REELSAW_URL: "http://127.0.0.1:1", REELSAW_API_KEY: "rs_x" });
    try {
      const r = await client.callTool({ name: "list_projects", arguments: {} });
      assert.equal(r.isError, true);
      assert.match(textOf(r), /Cannot reach Reelsaw at http:\/\/127\.0\.0\.1:1\/api\/mcp/);
      assert.equal((await client.listTools()).tools.length, TOOL_NAMES.length);
    } finally {
      await client.close();
      await bridge.close();
    }
  });

  describe("against the running app", () => {
    const pool = db();
    let owner: Awaited<ReturnType<typeof signUp>>;
    let other: Awaited<ReturnType<typeof signUp>>;
    let apiKey: { id: string; key: string };
    const mine = randomUUID();
    const theirs = randomUUID();

    before(async () => {
      owner = await signUp();
      other = await signUp();
      apiKey = await createKey(owner.cookie, "stdio");
      for (const [id, uid, title] of [
        [mine, owner.userId, "Mine"],
        [theirs, other.userId, "Theirs"],
      ] as const)
        await pool.query(
          `insert into projects (id, user_id, title, source_type, source_url, duration_sec, status, settings) values ($1, $2, $3, 'url', 'https://example.com/v.mp4', 61, 'done', '{}')`,
          [id, uid, title],
        );
    });

    after(async () => {
      await pool.query(`delete from "user" where id = any($1)`, [[owner?.userId, other?.userId].filter(Boolean)]);
      await pool.end();
    });

    it("advertises the same tools and schemas as /api/mcp", async () => {
      const http = new Client({ name: "test", version: "0" });
      await http.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", BASE), { requestInit: { headers: { authorization: `Bearer ${apiKey.key}` } } }));
      const { client, bridge } = await inMemory({ REELSAW_URL: BASE, REELSAW_API_KEY: apiKey.key });
      try {
        const strip = (tools: Array<Record<string, unknown>>) =>
          tools
            .map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }))
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        assert.deepEqual(strip((await client.listTools()).tools), strip((await http.listTools()).tools));
      } finally {
        await client.close();
        await bridge.close();
        await http.close();
      }
    });

    it("forwards calls over real stdio as the key's owner", async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/cli.ts", "mcp"],
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...(process.env as Record<string, string>), REELSAW_URL: BASE, REELSAW_API_KEY: apiKey.key, CLI_LOG_LEVEL: "silent" },
      });
      const client = new Client({ name: "test", version: "0" });
      await client.connect(transport);
      try {
        const r = await client.callTool({ name: "list_projects", arguments: {} });
        assert.ok(!r.isError, textOf(r));
        const page = JSON.parse(textOf(r)) as { projects: Array<{ id: string }>; total: number };
        assert.deepEqual(
          page.projects.map((p) => p.id),
          [mine],
        );
        const denied = await client.callTool({ name: "get_project", arguments: { id: theirs } });
        assert.equal(denied.isError, true);
        assert.match(textOf(denied), /NOT_FOUND/);
        const bad = await client.callTool({ name: "create_project", arguments: { sourceUrl: "not a url" } });
        assert.equal(bad.isError, true);
      } finally {
        await client.close();
      }
    });
  });
});
