/**
 * `/api/mcp` serves both protocol eras (serveMcpRequest, the same call handleMcp makes): a client pinned to
 * 2026-07-28 (no `initialize`, a per-request envelope) and a 2025 client (`initialize`, then calls) both list the
 * catalogue and call a tool. SDK v1 refused 2026-07-28 with "Unsupported protocol version". The server here is the
 * stdio bridge's (the same catalogue, needs no database); `/api/mcp` against the running app is mcp.test.ts.
 * `reelsaw mcp` over a real stdio pipe serves both eras too.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pino } from "pino";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serveMcpRequest } from "../src/mcp.js";
import { createStdioBridge } from "../src/mcp-stdio.js";
import { TOOL_NAMES } from "../src/mcp-tools.js";

const log = pino({ level: "silent" });
const url = new URL("http://reelsaw.test/api/mcp");
const fetchMcp = (input: string | URL | Request, init?: RequestInit) =>
  serveMcpRequest(new Request(input, init), () => createStdioBridge({ REELSAW_URL: "http://127.0.0.1:9" }, log).server);

async function connect(mode: "legacy" | { pin: string }) {
  const client = new Client({ name: "protocol-test", version: "0" }, { versionNegotiation: { mode } });
  await client.connect(new StreamableHTTPClientTransport(url, { fetch: fetchMcp }));
  return client;
}

describe("/api/mcp protocol eras", () => {
  for (const [label, mode] of [
    ["2026-07-28", { pin: "2026-07-28" }],
    ["2025 (initialize)", "legacy"],
  ] as const) {
    it(`a ${label} client lists every tool and gets a tool result`, async () => {
      const client = await connect(mode);
      try {
        const { tools } = await client.listTools();
        assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
        // no API key in the bridge's env: the call comes back as a tool error that says what to set, not a protocol error
        const res = await client.callTool({ name: "list_projects", arguments: {} });
        assert.equal(res.isError, true);
        assert.match(JSON.stringify(res.content), /REELSAW_API_KEY/);
      } finally {
        await client.close();
      }
    });
  }
});

describe("reelsaw mcp (stdio) protocol eras", () => {
  for (const [label, mode] of [
    ["2026-07-28", { pin: "2026-07-28" }],
    ["2025 (initialize)", "legacy"],
  ] as const) {
    it(`a ${label} client lists every tool over a real pipe`, async () => {
      const env = { ...(process.env as Record<string, string>), REELSAW_URL: "http://127.0.0.1:9", CLI_LOG_LEVEL: "silent" };
      delete env.REELSAW_API_KEY;
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", "src/cli.ts", "mcp"],
        cwd: path.resolve(import.meta.dirname, ".."),
        env,
      });
      const client = new Client({ name: "protocol-test", version: "0" }, { versionNegotiation: { mode } });
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        assert.equal(tools.length, TOOL_NAMES.length);
        const res = await client.callTool({ name: "list_projects", arguments: {} });
        assert.match(JSON.stringify(res.content), /REELSAW_API_KEY/);
      } finally {
        await client.close();
      }
    });
  }
});
