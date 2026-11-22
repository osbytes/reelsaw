/**
 * OpenCode: one Console key, two plans (ai/opencode.ts). The key is stored once under `opencode` and
 * `opencode-go` borrows it (ai/provider-ids.ts); the picker lists both plans as sections of one
 * provider, a plan the key cannot use left empty with the reason; Go calls carry Reelsaw's user agent
 * and one x-opencode-session per project; structured output asks for lenient schemas. Which models
 * are listed comes from OpenCode's own listing (type, native API, price), never from model names.
 * A fake OpenCode on localhost, its entries shaped like the real listing; no real key.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createModelCatalog, isUsableOpenCodeModel, type OpenCodeModelEntry } from "../src/ai/catalog.js";
import { credentialOwner } from "../src/ai/provider-ids.js";
import { envCredentials, providerDescriptors } from "../src/ai/providers.js";
import { createAi, type CredentialSource } from "../src/ai/registry.js";
import { withLlmContext } from "../src/ai/trace.js";
import type { Config } from "../src/config.js";
import type { Logger } from "../src/log.js";

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as unknown as Logger;
const KEY = "oc-test-key";

/** an entry as OpenCode lists it: type, the APIs it is served on natively, list price per 1M tokens */
const entry = (id: string, type: string, apis: string[], input: number, output: number, name?: string): OpenCodeModelEntry => ({
  id,
  type,
  ...(name ? { name } : {}),
  api: Object.fromEntries(apis.map((a) => [a, { base_url: "https://opencode.ai/inference/openai/v1" }])),
  cost: { text: { input: { price: input }, output: { price: output } } },
});
const ZEN = [
  entry("glm-5.3", "chat", ["chat-completions"], 0.56, 1.76, "GLM-5.3"),
  entry("minimax-m3", "chat", ["chat-completions"], 0.3, 1.2),
  entry("claude-haiku-5-5", "chat", ["messages"], 0.1, 0.5),
  entry("gpt-6.2-sol", "chat", ["responses"], 2, 10),
  entry("big-pickle", "chat", ["chat-completions"], 0, 0),
  entry("gemini-decision-1", "decision", ["systemone"], 0.1, 0),
  entry("text-embedding-3-small", "embedding", ["embeddings"], 0.02, 0),
];
// the same model can be native Chat Completions on one plan and Anthropic messages on the other
const GO = [
  entry("kimi-k3", "chat", ["chat-completions"], 3, 15),
  entry("glm-5.3", "chat", ["chat-completions"], 1.4, 4.4),
  entry("minimax-m3", "chat", ["messages"], 0.3, 1.2),
];

let server: http.Server;
let base = "";
let goStatus = 200;
/** "html": Go answers 200 with a page, not JSON; "drop": Go hangs up without answering */
let goFault: "" | "html" | "drop" = "";
let zenStatus = 200;
type ChatBody = { model: string; response_format?: { type: string; json_schema: { strict: boolean } } };
const calls: Array<{ url: string; headers: http.IncomingHttpHeaders; body: ChatBody }> = [];

before(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(v));
      };
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: "no key" });
      if (req.url === "/v1/models") return zenStatus === 200 ? json(200, { object: "list", data: ZEN }) : json(zenStatus, { error: "down" });
      if (req.url === "/go/v1/models" && goFault === "drop") return req.socket.destroy();
      if (req.url === "/go/v1/models" && goFault === "html") return res.writeHead(200, { "content-type": "text/html" }).end("<html>maintenance</html>");
      if (req.url === "/go/v1/models") return goStatus === 200 ? json(200, { object: "list", data: GO }) : json(goStatus, { type: "EntitlementError" });
      if (req.url === "/openai/v1/chat/completions" || req.url === "/go/openai/v1/chat/completions") {
        const body = JSON.parse(raw) as ChatBody;
        calls.push({ url: req.url, headers: req.headers, body });
        const content = body.response_format ? JSON.stringify({ title: "ready" }) : "ready";
        return json(200, {
          id: "c1",
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  goStatus = 200;
  goFault = "";
  zenStatus = 200;
  calls.length = 0;
});

const config = () =>
  ({
    OPENAI_COMPATIBLE_NAME: "compat",
    OPENCODE_BASE_URL: base,
    REELSAW_VERSION: "9.9.9",
    AI_MODEL: "opencode:glm-5.3",
    TRANSCRIPTION_MODEL: "openai:whisper-1",
  }) as unknown as Config;
// only OpenCode has a key: a key in the developer's shell must not reach a real provider
const credentials: CredentialSource = { get: (p) => (credentialOwner(p) === "opencode" ? { apiKey: KEY } : {}), version: () => 0 };

describe("OpenCode credentials", () => {
  it("opencode-go borrows the opencode key; one descriptor, so one key field", () => {
    assert.equal(credentialOwner("opencode-go"), "opencode");
    assert.equal(credentialOwner("groq"), "groq");
    const ds = providerDescriptors(config()).filter((d) => d.provider.startsWith("opencode"));
    assert.deepEqual(
      ds.map((d) => [d.provider, d.aliases]),
      [["opencode", ["opencode-go"]]],
    );
    const env = { ...config(), OPENCODE_API_KEY: "oc-env" } as Config;
    assert.equal(envCredentials(env, "opencode-go").apiKey, "oc-env");
  });
});

describe("OpenCode listing", () => {
  it("lists Zen and Go as sections of one provider: paid chat models OpenCode serves on Chat Completions", async () => {
    const r = await createModelCatalog(config(), log, credentials).page("language", { limit: 100 });
    assert.equal(r.providers.filter((p) => p.provider.startsWith("opencode")).length, 1);
    const oc = r.providers.find((p) => p.provider === "opencode")!;
    assert.deepEqual(oc.prefixes, ["opencode", "opencode-go"]);
    assert.deepEqual(
      oc.groups?.map((g) => g.name),
      ["OpenCode Zen", "OpenCode Go"],
    );
    assert.ok(oc.groups?.[1]?.notice?.includes("coding agents"));
    // minimax-m3 is listed on Zen (native Chat Completions) and not on Go (native Anthropic messages)
    assert.deepEqual(
      oc.models.map((m) => m.id),
      ["opencode:glm-5.3", "opencode:minimax-m3", "opencode-go:glm-5.3", "opencode-go:kimi-k3"],
    );
    assert.equal(oc.models[0]!.note, "GLM-5.3 · $0.56 / $1.76 per 1M tokens");
    // an alias pages through its owner
    const go = await createModelCatalog(config(), log, credentials).page("language", { provider: "opencode-go" });
    assert.equal(go.providers[0]!.provider, "opencode");
  });

  it("decides from the entry, not the name", () => {
    assert.equal(isUsableOpenCodeModel(entry("anything", "chat", ["chat-completions"], 1, 2)), true);
    assert.equal(isUsableOpenCodeModel(entry("anything", "chat", ["chat-completions", "messages"], 1, 2)), true);
    assert.equal(isUsableOpenCodeModel(entry("anything", "chat", ["messages"], 1, 2)), false, "translated: loses structured output");
    assert.equal(isUsableOpenCodeModel(entry("anything", "chat", ["chat-completions"], 0, 0)), false, "free: OpenCode app only");
    assert.equal(isUsableOpenCodeModel(entry("anything", "embedding", ["chat-completions"], 1, 0)), false);
    assert.equal(isUsableOpenCodeModel({ id: "bare" }), false);
  });

  it("keeps sections together when a model in use is pinned", async () => {
    const r = await createModelCatalog(config(), log, credentials).page("language", { provider: "opencode", pin: ["opencode-go:kimi-k3"] });
    const groups = r.providers[0]!.models.map((m) => m.group);
    assert.deepEqual([...new Set(groups)], ["OpenCode Zen", "OpenCode Go"]);
    assert.equal(r.providers[0]!.models.find((m) => m.group === "OpenCode Go")!.id, "opencode-go:kimi-k3");
  });

  it("a key without Go lists Zen and says why Go is empty; probe accepts it", async () => {
    goStatus = 403;
    const c = createModelCatalog(config(), log, credentials);
    const oc = (await c.page("language", { provider: "opencode" })).providers[0]!;
    assert.equal(oc.error, undefined);
    assert.ok(oc.models.every((m) => m.id.startsWith("opencode:")));
    assert.match(oc.groups![1]!.notice!, /cannot use OpenCode Go \(HTTP 403\)/);
    assert.equal((await c.probe("opencode", { apiKey: KEY })).ok, true);
  });

  it("a Go listing that cannot be reached or read leaves Zen listed", async () => {
    for (const fault of ["drop", "html"] as const) {
      goFault = fault;
      const oc = (await createModelCatalog(config(), log, credentials).page("language", { provider: "opencode" })).providers[0]!;
      assert.equal(oc.error, undefined, fault);
      assert.deepEqual(
        oc.models.map((m) => m.id),
        ["opencode:glm-5.3", "opencode:minimax-m3"],
        fault,
      );
      assert.match(oc.groups![1]!.notice!, /OpenCode Go could not be listed/, fault);
    }
  });

  it("both plans failing names the rejected key, whichever plan rejected it", async () => {
    zenStatus = 503;
    goStatus = 403;
    const r = await createModelCatalog(config(), log, credentials).probe("opencode", { apiKey: KEY });
    assert.equal(r.ok, false);
    assert.match(r.error!, /rejected \(HTTP 403\)/);
  });

  it("the transcription listing has no OpenCode sections", async () => {
    const oc = (await createModelCatalog(config(), log, credentials).page("transcription", { provider: "opencode" })).providers[0]!;
    assert.equal(oc.groups, undefined);
    assert.deepEqual(oc.models, []);
  });

  it("a key neither plan takes is refused", async () => {
    const r = await createModelCatalog(config(), log, credentials).probe("opencode", { apiKey: "wrong" });
    assert.equal(r.ok, false);
    assert.match(r.error!, /rejected \(HTTP 401\)/);
  });
});

describe("OpenCode calls", () => {
  it("Go sends the user agent and the project as x-opencode-session; Zen sends no session", async () => {
    const ai = createAi(config(), log, null, undefined, credentials);
    const go = await ai.languageModel("opencode-go:kimi-k3");
    await withLlmContext({ projectId: "proj-1" }, () => generateText({ model: go, prompt: "hi" }));
    const zen = await ai.languageModel("opencode:glm-5.3");
    await generateText({ model: zen, prompt: "hi" });
    assert.equal(calls[0]!.url, "/go/openai/v1/chat/completions");
    assert.equal(calls[0]!.body.model, "kimi-k3");
    assert.equal(calls[0]!.headers["x-opencode-session"], "proj-1");
    assert.match(String(calls[0]!.headers["user-agent"]), /^reelsaw\/9\.9\.9/);
    assert.equal(calls[1]!.url, "/openai/v1/chat/completions");
    assert.equal(calls[1]!.headers["x-opencode-session"], undefined);
  });

  it("asks for a lenient json_schema, so optional fields are not refused", async () => {
    const ai = createAi(config(), log, null, undefined, credentials);
    const schema = z.object({ title: z.string(), note: z.string().optional() });
    const { output } = await generateText({ model: await ai.languageModel("opencode:glm-5.3"), prompt: "hi", output: Output.object({ schema }) });
    assert.deepEqual(output, { title: "ready" });
    assert.equal(calls[0]!.body.response_format?.type, "json_schema");
    assert.equal(calls[0]!.body.response_format?.json_schema.strict, false);
  });

  it("has no transcription models, and verify says what is missing", async () => {
    const ai = createAi(config(), log, null, undefined, credentials);
    await assert.rejects(() => ai.transcriptionModel("opencode:whisper-1"), /has no transcription models/);
    const none = createAi(config(), log, null, undefined, { get: () => ({}), version: () => 0 });
    await assert.rejects(() => none.verify("language", "opencode-go:kimi-k3"), /needs an API key for opencode: .*OPENCODE_API_KEY/);
  });
});
