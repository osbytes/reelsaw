/**
 * Intro/outro over MCP and the CLI: input schemas, the input -> tRPC mapping, the bounded URL download and
 * the effective-bumpers read model. No database or stack needed.
 * Run: node --import tsx --test test/bumpers-mcp.test.ts
 */
import { createLogger } from "../src/log.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { addBumperInput, assetMap, bumperNameSchema, clipBumpersCall, downloadAsUpload, effectiveBumpers, FETCH_MAX_BYTES, isPrivateAddress, projectBumpersCall, requireOneSource, setClipBumpersInput, setProjectBumpersInput } from "../src/library/service.js";
import type { Services } from "../src/services.js";

const clipIn = z.object(setClipBumpersInput);
const projectIn = z.object(setProjectBumpersInput);
const addIn = z.object(addBumperInput);

describe("tool input schemas", () => {
  it("set_clip_bumpers needs clips and an explicit rerender, and bounds seconds", () => {
    assert.ok(clipIn.safeParse({ projectId: "p", clipIds: ["c"], intro: "none", rerender: false }).success);
    assert.ok(!clipIn.safeParse({ projectId: "p", clipIds: [], rerender: false }).success);
    assert.ok(!clipIn.safeParse({ projectId: "p", clipIds: ["c"] }).success);
    assert.ok(!clipIn.safeParse({ projectId: "p", clipIds: ["c"], introSec: 11, rerender: true }).success);
    assert.ok(!clipIn.safeParse({ projectId: "p", clipIds: Array(201).fill("c"), rerender: true }).success);
    assert.ok(!clipIn.safeParse({ projectId: "p", clipIds: ["c"], intro: "", rerender: true }).success);
  });
  it("set_project_bumpers takes default, none or an id", () => {
    for (const v of ["default", "none", "3f2a"]) assert.ok(projectIn.safeParse({ projectId: "p", intro: v, rerender: true }).success);
    assert.ok(!projectIn.safeParse({ projectId: "p", intro: 5, rerender: true }).success);
  });
  it("rename_bumper trims the name and refuses an empty one", () => {
    assert.equal(bumperNameSchema.parse("  Logo sting "), "Logo sting");
    assert.ok(!bumperNameSchema.safeParse("   ").success);
    assert.ok(!bumperNameSchema.safeParse("x".repeat(121)).success);
  });
  it("add_bumper wants a real url and one source", () => {
    assert.ok(!addIn.safeParse({ url: "not a url" }).success);
    assert.ok(!addIn.safeParse({ url: "https://x.test/a.png", imageSeconds: 0.5 }).success);
    assert.ok(!addIn.safeParse({ url: "https://x.test/a.png", setDefault: "middle" }).success);
    assert.throws(() => requireOneSource({}), /exactly one/);
    assert.throws(() => requireOneSource({ url: "https://x.test/a.png", uploadId: "u" }), /exactly one/);
    requireOneSource({ uploadId: "u" });
  });
});

describe("input -> procedure mapping", () => {
  it("project: projectId becomes id, the rest passes through", () => {
    assert.deepEqual(projectBumpersCall({ projectId: "p1", intro: "default", outroSec: 2, rerender: true }), { id: "p1", intro: "default", outroSec: 2, rerender: true });
  });
  it("clips: default is an alias of inherit, ids are kept", () => {
    const c = clipBumpersCall({ projectId: "p1", clipIds: ["a", "b"], intro: "default", outro: "x", rerender: false });
    assert.equal(c.intro, "inherit");
    assert.equal(c.outro, "x");
    assert.deepEqual(c.clipIds, ["a", "b"]);
  });
});

describe("effective bumpers", () => {
  const assets = assetMap([
    { id: "a", name: "Logo", kind: "video", durationSec: 4 },
    { id: "b", name: "Card", kind: "image", durationSec: 3 },
  ]);
  it("a clip that chose none has none; the other slot follows the project", () => {
    const r = effectiveBumpers({ introAssetId: "a", outroAssetId: "b", outroSec: 5 }, { bumpers: { intro: null } }, assets);
    assert.deepEqual(r.intro, { assetId: null, name: null, seconds: null, source: "none" });
    assert.deepEqual(r.outro, { assetId: "b", name: "Card", seconds: 5, source: "project" });
  });
  it("falls back to the asset's own length and reports a clip's own pick", () => {
    const r = effectiveBumpers({ introAssetId: "a" }, { bumpers: { outro: "b" } }, assets);
    assert.deepEqual(r.intro, { assetId: "a", name: "Logo", seconds: 4, source: "project" });
    assert.deepEqual(r.outro, { assetId: "b", name: "Card", seconds: 3, source: "clip" });
  });
});

describe("downloadAsUpload", () => {
  const pub = async () => ["93.184.216.34"];
  async function harness() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bm-"));
    const rows: Array<Record<string, unknown>> = [];
    const put: string[] = [];
    const svc = {
      paths: { uploads: dir },
      storage: { putFile: async (k: string) => void put.push(k) },
      log: createLogger({ LOG_LEVEL: "silent", LOG_FORMAT: "json" }),
      database: { db: { insert: () => ({ values: async (v: Record<string, unknown>) => void rows.push(v) }) } },
    } as unknown as Services;
    return { svc, rows, put, dir };
  }
  const png = () => new Response(Buffer.from("png-bytes"), { headers: { "content-type": "image/png" } });

  it("stores the file like an upload, names it after `name`, and cleans its temp file", async () => {
    const h = await harness();
    const r = await downloadAsUpload(h.svc, "u1", "https://cdn.test/x", { fetch: async () => png(), lookup: pub, name: "Brand" });
    assert.equal(r.filename, "Brand.png");
    assert.equal(h.rows[0]!.userId, "u1");
    assert.match(h.put[0]!, /^uploads\/.+\.png$/);
    assert.deepEqual(await fs.readdir(h.dir), []);
  });
  it("refuses private hosts, odd schemes, redirects into private space and unknown types", async () => {
    const h = await harness();
    const f = async () => png();
    await assert.rejects(downloadAsUpload(h.svc, "u", "http://127.0.0.1/a.png", { fetch: f, lookup: pub }), /not reachable/);
    await assert.rejects(downloadAsUpload(h.svc, "u", "https://internal.test/a.png", { fetch: f, lookup: async () => ["10.0.0.5"] }), /not reachable/);
    await assert.rejects(downloadAsUpload(h.svc, "u", "file:///etc/passwd", { fetch: f, lookup: pub }), /http/);
    const redirect = async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
    await assert.rejects(downloadAsUpload(h.svc, "u", "https://cdn.test/a.png", { fetch: redirect, lookup: pub }), /not reachable/);
    await assert.rejects(downloadAsUpload(h.svc, "u", "https://cdn.test/page", { fetch: async () => new Response("x", { headers: { "content-type": "text/html" } }), lookup: pub }), /MP4, MOV or WebM/);
    assert.equal(h.rows.length, 0);
  });
  it("enforces the size limit by header and while streaming", async () => {
    const h = await harness();
    await assert.rejects(downloadAsUpload(h.svc, "u", "https://cdn.test/a.mp4", { fetch: async () => new Response("x", { headers: { "content-length": String(FETCH_MAX_BYTES + 1) } }), lookup: pub }), /limit is 50 MB/);
    const big = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(FETCH_MAX_BYTES + 10));
        c.close();
      },
    });
    await assert.rejects(downloadAsUpload(h.svc, "u", "https://cdn.test/a.mp4", { fetch: async () => new Response(big), lookup: pub }), /larger than 50 MB/);
    assert.equal(h.rows.length, 0);
    assert.deepEqual(await fs.readdir(h.dir), []);
  });
  it("private address ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateAddress(ip), ip);
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.ok(!isPrivateAddress(ip), ip);
  });
});
