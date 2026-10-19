/**
 * The MCP tool catalogue as clients see it (tools/list over the stdio bridge, no instance needed): the exact tool
 * set, so adding or dropping a tool is deliberate, and the quality bar every definition has to meet: each input
 * property (nested ones included) is described, and each description says what the tool returns. `/api/mcp`
 * advertises the same catalogue (mcp-stdio.test.ts checks that against the running app).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pino } from "pino";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStdioBridge } from "../src/mcp-stdio.js";
import { INSTRUCTIONS, TOOL_NAMES } from "../src/mcp-tools.js";

const EXPECTED = [
  "add_bumper",
  "billing_checkout_url",
  "bumper_usage",
  "check_for_update",
  "create_clip",
  "create_project",
  "delete_clip",
  "delete_project",
  "export_project",
  "get_billing",
  "get_clip",
  "get_instance_settings",
  "get_project",
  "get_project_events",
  "get_transcript",
  "list_bumpers",
  "list_projects",
  "reanalyze_project",
  "remove_bumper",
  "rename_bumper",
  "rerender_clip",
  "rerender_clips",
  "restore_bumper",
  "restore_clip",
  "restore_project",
  "retry_project",
  "search_clips",
  "set_clip_bumpers",
  "set_default_bumper",
  "set_instance_settings",
  "set_project_bumpers",
  "update_clip",
  "update_project",
  "wait_for_project",
];

type Json = { type?: string | string[]; description?: string; properties?: Record<string, Json>; items?: Json; anyOf?: Json[] };

/** Every property path under a JSON schema whose description is missing (object properties, array items' objects, unions). */
function undescribed(schema: Json, at: string, out: string[] = []): string[] {
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    const path = `${at}.${k}`;
    if (!v.description?.trim() && !(v.anyOf ?? []).some((x) => x.description?.trim())) out.push(path);
    for (const sub of [v, v.items, ...(v.anyOf ?? []), ...(v.anyOf ?? []).map((x) => x.items)]) if (sub?.properties) undescribed(sub, path, out);
  }
  return out;
}

async function listTools() {
  const bridge = createStdioBridge({ REELSAW_URL: "http://127.0.0.1:1" }, pino({ level: "silent" }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  try {
    return { tools: (await client.listTools()).tools, instructions: client.getInstructions() };
  } finally {
    await client.close();
    await bridge.close();
  }
}

describe("mcp tool definitions", () => {
  it("advertises exactly the expected tools", async () => {
    const { tools } = await listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED);
    assert.deepEqual([...TOOL_NAMES].sort(), EXPECTED);
  });

  it("binds every tool on /api/mcp too", () => {
    const src = fs.readFileSync(new URL("../src/mcp.ts", import.meta.url), "utf8");
    for (const name of EXPECTED) assert.match(src, new RegExp(`"${name}",\\s*TOOLS\\.${name},`), `mcp.ts registers ${name}`);
  });

  it("describes every input property, nested ones included", async () => {
    const { tools } = await listTools();
    const missing = tools.flatMap((t) => undescribed(t.inputSchema as Json, t.name));
    assert.deepEqual(missing, [], `input properties without a description:\n  ${missing.join("\n  ")}`);
  });

  it("says what each tool returns, with a title, in a few sentences", async () => {
    const { tools } = await listTools();
    for (const t of tools) {
      assert.ok(t.title?.trim(), `${t.name} has a title`);
      assert.match(t.description ?? "", /Returns|→/, `${t.name}: the description says what it returns`);
      assert.ok((t.description ?? "").length <= 520, `${t.name}: the description stays short (${t.description?.length} chars)`);
    }
  });

  it("maps which tool to use when in the server instructions", async () => {
    const { instructions } = await listTools();
    assert.equal(instructions, INSTRUCTIONS);
    for (const w of ["inspect:", "change:", "recover:", "render:"]) assert.ok(INSTRUCTIONS.includes(w), w);
  });
});
