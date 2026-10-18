/** Update check: version order and the checker against a fake GitHub (pure; no stack needed). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createLogger } from "../src/log.js";
import { createUpdateChecker, releaseVersion, upgradeHowTo, MIN_CHECK_GAP_MS } from "../src/updates.js";

const log = createLogger({ LOG_LEVEL: "silent", LOG_FORMAT: "json" } as never, {}, new Writable({ write: (_c, _e, cb) => cb() }));
const cfg = (current: string, enabled = true) => ({ REELSAW_VERSION: current, UPDATE_CHECK: enabled, UPDATE_CHECK_URL: "https://example.test/latest", UPDATE_CHECK_HOURS: 6 });
const release = (tag: string) => ({ ok: true, status: 200, json: async () => ({ tag_name: tag, html_url: `https://github.com/osbytes/reelsaw/releases/tag/${tag}`, published_at: "2026-10-17T10:00:00Z" }) });

describe("releaseVersion", () => {
  it("accepts a release tag with or without v, not a source build", () => {
    assert.equal(releaseVersion("v0.6.0"), "0.6.0");
    assert.equal(releaseVersion("0.6.0-beta.1"), "0.6.0-beta.1");
    assert.equal(releaseVersion("dev"), null);
    assert.equal(releaseVersion("latest"), null);
  });
});

describe("upgradeHowTo", () => {
  it("pulls the image for a release, rebuilds for a source checkout", () => {
    assert.match(upgradeHowTo("0.5.0").command, /docker compose pull/);
    assert.match(upgradeHowTo("dev").command, /git pull/);
  });
});

describe("update checker", () => {
  it("reports a newer release with its link and the upgrade step", async () => {
    const calls: string[] = [];
    const u = createUpdateChecker(cfg("0.5.0"), log, { fetch: async (url, init) => (calls.push(init.headers["user-agent"]!), release("v0.6.0")) });
    assert.equal(u.state().available, null);
    const s = await u.check();
    assert.equal(s.available, true);
    assert.equal(s.latest?.version, "0.6.0");
    assert.equal(s.latest?.url, "https://github.com/osbytes/reelsaw/releases/tag/v0.6.0");
    assert.equal(s.error, null);
    assert.ok(s.checkedAt);
    assert.deepEqual(calls, ["reelsaw/0.5.0"]);
  });

  it("is up to date on the same version; a pre-release sits between the releases around it", async () => {
    const latest = (current: string, tag: string) => createUpdateChecker(cfg(current), log, { fetch: async () => release(tag) }).check();
    assert.equal((await latest("0.6.0", "v0.6.0")).available, false);
    assert.equal((await latest("0.7.0-beta.1", "v0.6.0")).available, false);
    assert.equal((await latest("0.7.0-beta.1", "v0.7.0")).available, true);
    assert.equal((await latest("0.5.0", "v0.10.0")).available, true);
  });

  it("shows the latest release but no verdict when running from source", async () => {
    const s = await createUpdateChecker(cfg("dev"), log, { fetch: async () => release("v0.6.0") }).check();
    assert.equal(s.available, null);
    assert.equal(s.latest?.version, "0.6.0");
  });

  it("keeps the last answer and records the error when GitHub fails", async () => {
    let fail = false;
    const u = createUpdateChecker(cfg("0.5.0"), log, { fetch: async () => (fail ? { ok: false, status: 503, json: async () => ({}) } : release("v0.6.0")) });
    await u.check();
    fail = true;
    const s = await u.check({ force: true });
    assert.equal(s.latest?.version, "0.6.0");
    assert.equal(s.available, true);
    assert.equal(s.error, "GitHub answered 503");
  });

  it("rejects an answer without a version tag", async () => {
    const s = await createUpdateChecker(cfg("0.5.0"), log, { fetch: async () => ({ ok: true, status: 200, json: async () => ({ tag_name: "nightly" }) }) }).check();
    assert.equal(s.latest, null);
    assert.match(s.error!, /unexpected release tag/);
  });

  it("asks at most once a minute unless forced, and shares one in-flight request", async () => {
    let t = 1_000_000;
    let n = 0;
    const u = createUpdateChecker(cfg("0.5.0"), log, { fetch: async () => (n++, release("v0.6.0")), now: () => t });
    await Promise.all([u.check(), u.check()]);
    assert.equal(n, 1);
    await u.check();
    assert.equal(n, 1);
    await u.check({ force: true });
    assert.equal(n, 2);
    t += MIN_CHECK_GAP_MS;
    await u.check();
    assert.equal(n, 3);
  });

  it("never fetches when UPDATE_CHECK=false", async () => {
    let n = 0;
    const u = createUpdateChecker(cfg("0.5.0", false), log, { fetch: async () => (n++, release("v0.6.0")) });
    const s = await u.check({ force: true });
    u.start();
    u.stop();
    assert.equal(n, 0);
    assert.equal(s.enabled, false);
    assert.equal(s.latest, null);
  });
});
