/** Runtime instance settings: precedence over the environment, validation as a whole, secrets at rest, overrides that lose their precondition. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createInstanceSettings, problemsOf, resolveSettings, settingsPatchSchema, RUNTIME_KEYS, SettingsError } from "../src/instance-settings.js";
import type { Config } from "../src/config.js";
import type { Db } from "../src/db/index.js";
import type { Logger } from "../src/log.js";

/** Just enough of drizzle for instance-settings.ts: one row keyed by `key`, plus the admin events it writes. */
function fakeDb() {
  const rows = new Map<string, { key: string; value: Record<string, unknown>; updatedBy: string | null; updatedAt: Date }>();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const tx = {
    insert: () => ({
      values: (v: any) => {
        if ("type" in v) {
          events.push(v);
          return Promise.resolve();
        }
        return { onConflictDoUpdate: () => Promise.resolve(void rows.set(v.key, { key: v.key, value: v.value, updatedBy: v.updatedBy ?? null, updatedAt: new Date() })) };
      },
    }),
    delete: () => ({ where: () => Promise.resolve(void rows.clear()) }),
  };
  const db = {
    query: { instanceSettings: { findFirst: async () => rows.get("runtime") } },
    transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  };
  return { db: db as unknown as Db, rows, events };
}

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as unknown as Logger;
const config = {
  BETTER_AUTH_SECRET: "a-very-long-test-secret-for-hkdf-derivation",
  SIGNUP_MODE: "open",
  REQUIRE_EMAIL_VERIFICATION: false,
  CAPTCHA_PROVIDER: undefined,
  CAPTCHA_SITE_KEY: undefined,
  CAPTCHA_SECRET_KEY: undefined,
  TERMS_URL: "https://example.com/terms",
  PRIVACY_URL: undefined,
  MAX_PROJECTS_PER_USER: 0,
  MAX_SOURCE_MINUTES_PER_DAY: 0,
  MAX_NEW_PROJECTS_PER_HOUR: 0,
  MAX_LIVE_JOBS_PER_USER: 0,
  MAX_RERENDERS_PER_HOUR: 0,
  MAX_STORAGE_MB: 0,
  MAX_UPLOAD_MB: 4096,
  MAX_SOURCE_FILE_MB: 8192,
  ALLOW_PRIVATE_SOURCE_URLS: false,
  SOURCE_RETENTION_DAYS: 0,
  CLIP_RETENTION_DAYS: 0,
  DELETED_RETENTION_DAYS: 7,
  EVENT_RETENTION_DAYS: 90,
  LLM_USAGE_RETENTION_DAYS: 180,
  ADMIN_EVENT_RETENTION_DAYS: 365,
  STALL_MINUTES: 15,
  UPDATE_CHECK: true,
  HEALTH_DETAILS: false,
} as unknown as Config;
const actor = { id: "u1", email: "admin@example.com" };

describe("resolveSettings / problemsOf", () => {
  it("environment when nothing is overridden; an empty optional override means none", () => {
    assert.equal(resolveSettings(config, {}).SIGNUP_MODE, "open");
    assert.equal(resolveSettings(config, { SIGNUP_MODE: "closed" }).SIGNUP_MODE, "closed");
    assert.equal(resolveSettings(config, {}).TERMS_URL, "https://example.com/terms");
    assert.equal(resolveSettings(config, { TERMS_URL: "" }).TERMS_URL, undefined);
  });
  it("names the setting that lost its precondition", () => {
    assert.deepEqual(problemsOf(resolveSettings(config, {}), { emailEnabled: false }), {});
    assert.match(problemsOf(resolveSettings(config, { REQUIRE_EMAIL_VERIFICATION: true }), { emailEnabled: false }).REQUIRE_EMAIL_VERIFICATION!, /email driver/);
    assert.deepEqual(problemsOf(resolveSettings(config, { REQUIRE_EMAIL_VERIFICATION: true }), { emailEnabled: true }), {});
    assert.match(problemsOf(resolveSettings(config, { CAPTCHA_PROVIDER: "hcaptcha", CAPTCHA_SITE_KEY: "site" }), { emailEnabled: false }).CAPTCHA_PROVIDER!, /both/);
  });
  it("the patch schema takes every runtime key, nullable", () => {
    const r = settingsPatchSchema.safeParse({ SIGNUP_MODE: null, MAX_UPLOAD_MB: 10, HEALTH_DETAILS: true });
    assert.ok(r.success);
    assert.ok(!settingsPatchSchema.safeParse({ SIGNUP_MODE: "sometimes" }).success);
    assert.ok(!settingsPatchSchema.safeParse({ MAX_UPLOAD_MB: 0 }).success);
    for (const k of RUNTIME_KEYS) assert.ok(k in settingsPatchSchema.shape, k);
  });
});

describe("createInstanceSettings", () => {
  it("stores an override, reports its source, returns to the environment on null, and audits each change", async () => {
    const { db, rows, events } = fakeDb();
    const s = createInstanceSettings(config, log, { emailEnabled: false, pollMs: 0 });
    await s.attach(db);
    assert.equal(s.get().SIGNUP_MODE, "open");
    assert.equal(s.state().source.SIGNUP_MODE, "env");

    const seen: string[] = [];
    s.subscribe((v) => seen.push(v.SIGNUP_MODE));
    let st = await s.set({ SIGNUP_MODE: "approval", MAX_UPLOAD_MB: 2048 }, actor);
    assert.equal(s.get().SIGNUP_MODE, "approval");
    assert.equal(s.get().MAX_UPLOAD_MB, 2048);
    assert.deepEqual(seen, ["approval"]);
    assert.equal(st.source.SIGNUP_MODE, "db");
    assert.equal(st.source.MAX_UPLOAD_MB, "db");
    assert.equal(st.source.HEALTH_DETAILS, "env");
    assert.equal(st.updatedBy, actor.email);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, { changed: { SIGNUP_MODE: { from: "open", to: "approval" }, MAX_UPLOAD_MB: { from: 4096, to: 2048 } } });

    // the environment's own value is not an override
    st = await s.set({ MAX_UPLOAD_MB: 4096 }, actor);
    assert.equal(st.source.MAX_UPLOAD_MB, "env");

    st = await s.set({ SIGNUP_MODE: null }, actor);
    assert.equal(s.get().SIGNUP_MODE, "open");
    assert.equal(st.source.SIGNUP_MODE, "env");
    assert.equal(rows.size, 0, "a row with nothing left is deleted");
    // subscribers hear every change of the effective settings, including the upload cap going back
    assert.deepEqual(seen, ["approval", "approval", "open"]);

    await assert.rejects(s.set({ SIGNUP_MODE: null }, actor), (e: Error) => e instanceof SettingsError && /Nothing to change/.test(e.message));
    await assert.rejects(s.set({ SIGNUP_MODE: "sometimes" as never }, actor), SettingsError);
  });

  it("validates the result as a whole with a sentence", async () => {
    const { db } = fakeDb();
    const s = createInstanceSettings(config, log, { emailEnabled: false, pollMs: 0 });
    await s.attach(db);
    await assert.rejects(s.set({ REQUIRE_EMAIL_VERIFICATION: true }, actor), (e: Error) => e instanceof SettingsError && /email driver/.test(e.message));
    await assert.rejects(s.set({ CAPTCHA_PROVIDER: "hcaptcha" }, actor), (e: Error) => e instanceof SettingsError && /both the site key and the secret key/.test(e.message));
    const st = await s.set({ CAPTCHA_PROVIDER: "hcaptcha", CAPTCHA_SITE_KEY: "site-1234", CAPTCHA_SECRET_KEY: "secret-abcd" }, actor);
    assert.equal(s.get().CAPTCHA_PROVIDER, "hcaptcha");
    assert.equal(s.get().CAPTCHA_SECRET_KEY, "secret-abcd", "the server sees the secret");
    assert.equal(st.values.CAPTCHA_SECRET_KEY, "…abcd", "the API sees only the tail");
    assert.equal(st.override.CAPTCHA_SECRET_KEY, "…abcd");
  });

  it("encrypts secrets at rest and ignores one it can no longer read", async () => {
    const { db, rows } = fakeDb();
    const s = createInstanceSettings(config, log, { emailEnabled: false, pollMs: 0 });
    await s.attach(db);
    await s.set({ CAPTCHA_PROVIDER: "hcaptcha", CAPTCHA_SITE_KEY: "site", CAPTCHA_SECRET_KEY: "secret-abcd" }, actor);
    const stored = rows.get("runtime")!.value.CAPTCHA_SECRET_KEY as { enc: string; last4: string };
    assert.match(stored.enc, /^v1:/);
    assert.equal(stored.last4, "abcd");
    assert.ok(!JSON.stringify(rows.get("runtime")!.value).includes("secret-abcd"));

    // another process with a different BETTER_AUTH_SECRET: the secret is unreadable, so the captcha cannot apply either
    const other = createInstanceSettings({ ...config, BETTER_AUTH_SECRET: "another-secret-that-is-long-enough" } as Config, log, { emailEnabled: false, pollMs: 0 });
    await other.attach(db);
    assert.equal(other.get().CAPTCHA_SECRET_KEY, undefined);
    assert.equal(other.get().CAPTCHA_PROVIDER, undefined, "provider override dropped: its keys are missing");
    assert.match(other.state().ignored.CAPTCHA_SECRET_KEY!, /cannot be decrypted/);
    assert.match(other.state().ignored.CAPTCHA_PROVIDER!, /both the site key/);
    assert.equal(other.state().source.CAPTCHA_PROVIDER, "env");
  });

  it("drops a stored override whose precondition the environment no longer meets", async () => {
    const { db } = fakeDb();
    const withEmail = createInstanceSettings(config, log, { emailEnabled: true, pollMs: 0 });
    await withEmail.attach(db);
    await withEmail.set({ REQUIRE_EMAIL_VERIFICATION: true }, actor);
    const noEmail = createInstanceSettings(config, log, { emailEnabled: false, pollMs: 0 });
    await noEmail.attach(db);
    assert.equal(noEmail.get().REQUIRE_EMAIL_VERIFICATION, false);
    assert.match(noEmail.state().ignored.REQUIRE_EMAIL_VERIFICATION!, /email driver/);
  });

  it("another process picks a change up on refresh", async () => {
    const { db } = fakeDb();
    const a = createInstanceSettings(config, log, { emailEnabled: false, pollMs: 0 });
    const b = createInstanceSettings(config, log, { emailEnabled: false, pollMs: 0 });
    await a.attach(db);
    await b.attach(db);
    await a.set({ STALL_MINUTES: 30, ALLOW_PRIVATE_SOURCE_URLS: true }, actor);
    assert.equal(b.get().STALL_MINUTES, 15);
    await b.refresh();
    assert.equal(b.get().STALL_MINUTES, 30);
    assert.equal(b.get().ALLOW_PRIVATE_SOURCE_URLS, true);
  });
});
