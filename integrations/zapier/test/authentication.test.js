/* globals describe, it, expect, afterEach */
"use strict";

const zapier = require("zapier-platform-core");
const App = require("../index");
const { normalizeBaseUrl, parseToolError } = require("../lib/mcp");
const { BASE, KEY, authData, ok, toolError, mockTool, nock } = require("./helpers");

const appTester = zapier.createAppTester(App);

afterEach(() => nock.cleanAll());

describe("authentication", () => {
  it("tests the connection with list_projects (limit 1) and sends the key as a Bearer header", async () => {
    const seen = mockTool("list_projects", ok({ projects: [], total: 7, nextCursor: null }));
    const result = await appTester(App.authentication.test, { authData });
    expect(seen.called).toBe(true);
    expect(seen.arguments).toEqual({ limit: 1 });
    expect(seen.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen.headers.accept).toContain("application/json");
    expect(seen.headers.accept).toContain("text/event-stream");
    expect(seen.body.jsonrpc).toBe("2.0");
    expect(result).toEqual({ instance: "reelsaw.test", baseUrl: BASE, totalProjects: 7 });
  });

  it("accepts an address pasted with /api/mcp, a trailing slash or no scheme", async () => {
    const seen = mockTool("list_projects", ok({ projects: [], total: 0, nextCursor: null }));
    await appTester(App.authentication.test, { authData: { baseUrl: "reelsaw.test/api/mcp/", apiKey: KEY } });
    expect(seen.called).toBe(true);
    expect(normalizeBaseUrl(" https://clips.example.com/ ")).toBe("https://clips.example.com");
    expect(normalizeBaseUrl("https://example.com/reelsaw/api/mcp")).toBe("https://example.com/reelsaw");
  });

  it("fails with a sentence when the key is refused (401)", async () => {
    mockTool("list_projects", { error: "unauthorized", hint: "Send an API key" }, { status: 401 });
    await expect(appTester(App.authentication.test, { authData: { ...authData, apiKey: "rs_bad" } })).rejects.toThrow(
      /did not accept this API key/,
    );
  });

  it("fails with a sentence when the address is not a Reelsaw instance", async () => {
    nock(BASE).post("/api/mcp").reply(200, "<html>hello</html>", { "content-type": "text/html" });
    await expect(appTester(App.authentication.test, { authData })).rejects.toThrow(/did not answer like a Reelsaw instance/);
  });

  it("surfaces a 403 (account waiting for approval) with Reelsaw's message", async () => {
    mockTool("list_projects", { error: "forbidden", message: "Your account is waiting for approval." }, { status: 403 });
    await expect(appTester(App.authentication.test, { authData })).rejects.toThrow(/waiting for approval/);
  });

  it("surfaces a tool error's sentence without its code prefix", async () => {
    mockTool("list_projects", toolError("FORBIDDEN: This API key was revoked."));
    await expect(appTester(App.authentication.test, { authData })).rejects.toThrow(/This API key was revoked\./);
    expect(parseToolError('TOO_MANY_REQUESTS: Out of minutes this month.\n{"quota":{}}')).toEqual({
      code: "TOO_MANY_REQUESTS",
      message: "Out of minutes this month.",
    });
  });

  it("surfaces a JSON-RPC error (bad arguments)", async () => {
    mockTool("list_projects", { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Input validation error: limit too big" } });
    await expect(appTester(App.authentication.test, { authData })).rejects.toThrow(/Input validation error/);
  });

  it("never sends the key to another host", async () => {
    const before = App.beforeRequest[0];
    const req = before({ url: "https://cdn.example.com/file.mp4", headers: {} }, {}, { authData });
    expect(req.headers.Authorization).toBeUndefined();
    const own = before({ url: `${BASE}/api/mcp`, headers: {} }, {}, { authData });
    expect(own.headers.Authorization).toBe(`Bearer ${KEY}`);
    // a look-alike host that merely starts with the base string
    const lookalike = before({ url: `${BASE}.evil.example/api/mcp`, headers: {} }, {}, { authData });
    expect(lookalike.headers.Authorization).toBeUndefined();
  });
});
