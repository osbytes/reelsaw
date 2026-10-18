import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { Hono } from "hono";
import { createLogger, formatLogLevels, logControl, parseLogLevels } from "../src/log.js";
import { mergeLogLevels, parseDuration } from "../src/log-level.js";
import { accessLevel, requestLogger, resolveRequestId, trpcLogLevel, type AppEnv } from "../src/request-log.js";
import { eventFields } from "../src/uow.js";
import { lineMatches } from "../src/log-read.js";
import { argSummary } from "../src/mcp.js";
import { loggableArgv } from "../src/media.js";

/** A logger whose JSON lines land in an array. */
function capture(spec: string) {
  const lines: Array<Record<string, unknown>> = [];
  const dest = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split("\n")) if (l.trim()) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { log: createLogger({ LOG_LEVEL: spec, LOG_FORMAT: "json" }, {}, dest), lines };
}

describe("parseLogLevels", () => {
  it("reads a global level", () => {
    assert.deepEqual(parseLogLevels("debug"), { global: "debug", modules: {} });
  });
  it("reads a global level with per-module overrides", () => {
    assert.deepEqual(parseLogLevels("info,render=debug,http=warn"), { global: "info", modules: { render: "debug", http: "warn" } });
  });
  it("defaults to info, ignores blanks and case", () => {
    assert.equal(parseLogLevels(undefined).global, "info");
    assert.deepEqual(parseLogLevels(" WARN , Render = TRACE ,"), { global: "warn", modules: { render: "trace" } });
  });
  it("module-only specs keep the fallback global", () => {
    assert.deepEqual(parseLogLevels("render=debug", "warn"), { global: "warn", modules: { render: "debug" } });
  });
  it("rejects unknown levels and bad module names", () => {
    assert.throws(() => parseLogLevels("loud"), /unknown log level "loud"/);
    assert.throws(() => parseLogLevels("render=loud"), /for module render/);
    assert.throws(() => parseLogLevels("=debug"), /bad module name/);
  });
  it("round-trips through formatLogLevels", () => {
    assert.equal(formatLogLevels(parseLogLevels("info,render=debug")), "info,render=debug");
  });
  it("an override layers on the environment's levels", () => {
    const env = parseLogLevels("info,http=warn");
    assert.equal(formatLogLevels(mergeLogLevels(env, "render=debug")), "info,http=warn,render=debug");
    assert.equal(formatLogLevels(mergeLogLevels(env, "debug")), "debug,http=warn");
  });
  it("parses durations", () => {
    assert.equal(parseDuration("90s"), 90_000);
    assert.equal(parseDuration("15m"), 900_000);
    assert.equal(parseDuration("2h"), 7_200_000);
    assert.equal(parseDuration("soon"), undefined);
  });
});

describe("module log levels", () => {
  it("a module child honours its override, others follow the global level", () => {
    const { log, lines } = capture("info,render=debug");
    log.child({ module: "render", clipId: "c1" }).debug("render detail");
    log.child({ module: "analyze" }).debug("analyze detail");
    log.child({ module: "analyze" }).info("analyze milestone");
    assert.deepEqual(lines.map((l) => l.msg), ["render detail", "analyze milestone"]);
    assert.equal(lines[0]!.clipId, "c1");
    assert.equal(lines[0]!.module, "render");
  });
  it("a module can be quieter than the global level", () => {
    const { log, lines } = capture("debug,http=warn");
    log.child({ module: "http" }).info("request");
    log.child({ module: "http" }).warn("slow request");
    log.info("root line");
    assert.deepEqual(lines.map((l) => l.msg), ["slow request", "root line"]);
  });
  it("children of a module logger inherit the module's level", () => {
    const { log, lines } = capture("info,render=debug");
    log.child({ module: "render" }).child({ clipId: "c2" }).debug("nested detail");
    assert.equal(lines.length, 1);
  });
  it("levels change at runtime for loggers that already exist, and revert", () => {
    const { log, lines } = capture("info");
    const render = log.child({ module: "render" });
    const grand = render.child({ clipId: "c3" });
    render.debug("before");
    const ctl = logControl(render)!;
    ctl.apply(mergeLogLevels(ctl.base, "render=debug"));
    render.debug("during");
    grand.debug("during nested");
    log.child({ module: "other" }).debug("other module stays quiet");
    ctl.apply(null);
    render.debug("after");
    assert.deepEqual(lines.map((l) => l.msg), ["during", "during nested"]);
  });
  it("redacts secrets", () => {
    const { log, lines } = capture("info");
    log.info({ headers: { authorization: "Bearer x", cookie: "a=b" }, user: { password: "p" } }, "hello");
    assert.equal((lines[0]!.headers as Record<string, string>).authorization, "[redacted]");
    assert.equal((lines[0]!.user as Record<string, string>).password, "[redacted]");
  });
});

describe("request logging middleware", () => {
  function appWith(spec = "debug") {
    const { log, lines } = capture(spec);
    const app = new Hono<AppEnv>();
    app.use(requestLogger(log));
    app.get("/api/ok", (c) => c.json({ id: c.get("requestId") }));
    app.get("/api/health", (c) => c.json({ ok: true }));
    app.get("/api/missing", (c) => c.json({ error: "nope" }, 404));
    app.get("/api/bad", (c) => c.json({ error: "bad" }, 400));
    app.get("/api/boom", () => {
      throw new Error("kaboom");
    });
    app.get("/media/x", (c) => c.text("no", 404));
    app.get("/api/log", (c) => {
      c.get("log").info({ marker: 1 }, "inside handler");
      return c.text("ok");
    });
    app.onError((_e, c) => c.json({ error: "internal error", requestId: c.get("requestId") }, 500));
    return { app, lines };
  }

  it("generates a request id, returns it and logs it", async () => {
    const { app, lines } = appWith();
    const res = await app.request("/api/ok");
    const id = res.headers.get("x-request-id")!;
    assert.match(id, /^[0-9a-f-]{36}$/);
    assert.equal((await res.json()).id, id);
    const line = lines.find((l) => l.msg === "request")!;
    assert.equal(line.requestId, id);
    assert.equal(line.module, "http");
    assert.equal(line.method, "GET");
    assert.equal(line.status, 200);
    assert.equal("ms" in line, false, "durations belong to the http span, not the access line");
  });
  it("propagates a caller's request id and rejects junk", async () => {
    const { app, lines } = appWith();
    const res = await app.request("/api/ok", { headers: { "x-request-id": "proxy-abc-12345" } });
    assert.equal(res.headers.get("x-request-id"), "proxy-abc-12345");
    assert.equal(lines.find((l) => l.msg === "request")!.requestId, "proxy-abc-12345");
    const bad = await app.request("/api/ok", { headers: { "x-request-id": "not an id!" } });
    assert.notEqual(bad.headers.get("x-request-id"), "not an id!");
    assert.notEqual(resolveRequestId("short"), "short");
    assert.equal(resolveRequestId("abc-12345.67_8"), "abc-12345.67_8");
  });
  it("handlers log through a child carrying the request id", async () => {
    const { app, lines } = appWith();
    const res = await app.request("/api/log");
    const inside = lines.find((l) => l.msg === "inside handler")!;
    assert.equal(inside.requestId, res.headers.get("x-request-id"));
  });
  it("levels: health and media at debug, expected 4xx info, unexpected 4xx warn, 5xx error with err", async () => {
    const { app, lines } = appWith();
    for (const p of ["/api/health", "/media/x", "/api/missing", "/api/bad", "/api/boom"]) await app.request(p);
    const by = (path: string) => lines.find((l) => l.path === path)!;
    assert.equal(by("/api/health").level, 20);
    assert.equal(by("/media/x").level, 20);
    assert.equal(by("/api/missing").level, 30);
    assert.equal(by("/api/bad").level, 40);
    const boom = by("/api/boom");
    assert.equal(boom.level, 50);
    assert.equal(boom.msg, "request failed");
    assert.match(String((boom.err as { message: string }).message), /kaboom/);
  });
  it("at the default level only API calls are logged", async () => {
    const { app, lines } = appWith("info");
    await app.request("/api/health");
    await app.request("/media/x");
    await app.request("/api/ok");
    assert.deepEqual(lines.map((l) => l.path), ["/api/ok"]);
  });
  it("accessLevel never raises a tRPC response above info (onError reports it)", () => {
    assert.equal(accessLevel("POST", "/api/trpc/projects.create", 500), "info");
    assert.equal(accessLevel("POST", "/api/trpc/projects.create", 400), "info");
    assert.equal(accessLevel("GET", "/assets/x.js", 200), "debug");
  });
  it("a slow API request is a warn with its duration; a fast one carries none", () => {
    assert.equal(accessLevel("GET", "/api/projects/p/flags/f/cut-plan", 200, 100), "info");
    assert.equal(accessLevel("GET", "/api/projects/p/flags/f/cut-plan", 200, 5000), "warn");
    assert.equal(accessLevel("GET", "/api/projects/p/export.zip", 200, 5000), "info");
    assert.equal(accessLevel("GET", "/api/trpc/events.subscribe", 200, 600_000), "info");
  });
});

describe("tRPC error levels", () => {
  it("maps codes to levels", () => {
    for (const c of ["BAD_REQUEST", "NOT_FOUND", "UNAUTHORIZED"]) assert.equal(trpcLogLevel(c), "debug", c);
    for (const c of ["FORBIDDEN", "TOO_MANY_REQUESTS"]) assert.equal(trpcLogLevel(c), "warn", c);
    assert.equal(trpcLogLevel("INTERNAL_SERVER_ERROR"), "error");
    assert.equal(trpcLogLevel("SOMETHING_NEW"), "error");
  });
});

describe("log helpers", () => {
  it("event fields keep scalars only and trim long strings", () => {
    const f = eventFields({ stage: "render", durationSec: 3.2, ok: true, nested: { a: 1 }, list: [1], error: "x".repeat(500) });
    assert.deepEqual(Object.keys(f).sort(), ["durationSec", "error", "ok", "stage"]);
    assert.ok(String(f.error).length <= 201);
  });
  it("MCP argument summary has ids and sizes, never bodies", () => {
    assert.deepEqual(argSummary({ projectId: "p1", caption: "a long caption body", limit: 5, hashtags: ["a", "b"], style: { font: "x" } }), { projectId: "p1", caption: "19 chars", limit: 5, hashtags: "2 items", style: "{font}" });
  });
  it("ffmpeg argv in logs hides the proxy and cookies", () => {
    assert.deepEqual(loggableArgv(["--proxy", "http://user:pw@host:1", "--cookies", "/c.txt", "-i", "in.mp4"]), ["--proxy", "[redacted]", "--cookies", "[redacted]", "-i", "in.mp4"]);
  });
  it("log file filter: ids, level, module, since", () => {
    const line = JSON.stringify({ level: 30, time: "2026-10-17T10:00:00.000Z", module: "render", projectId: "proj-1", msg: "x" });
    assert.ok(lineMatches(line, { ids: ["proj-1"] }));
    assert.ok(!lineMatches(line, { ids: ["proj-2"] }));
    assert.ok(!lineMatches(line, { ids: ["proj-1"], minLevel: "warn" }));
    assert.ok(lineMatches(line, { ids: ["proj-1"], minLevel: "info", module: "render" }));
    assert.ok(!lineMatches(line, { ids: ["proj-1"], module: "http" }));
    assert.ok(!lineMatches(line, { ids: ["proj-1"], since: new Date("2026-10-18T00:00:00Z") }));
    assert.ok(lineMatches(line, { ids: ["proj-1"], since: new Date("2026-10-17T00:00:00Z") }));
  });
});
