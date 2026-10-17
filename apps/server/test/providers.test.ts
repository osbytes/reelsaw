/** Provider credentials: encryption round trip, stored-over-environment precedence, unreadable keys ignored. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSecretBox } from "../src/ai/crypto.js";
import { createProviderSettings, envCredentials } from "../src/ai/providers.js";
import type { Config } from "../src/config.js";
import type { Db } from "../src/db/index.js";
import type { Logger } from "../src/log.js";

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as unknown as Logger;
const config = { BETTER_AUTH_SECRET: "a-very-long-test-secret-for-hkdf-derivation", OPENAI_COMPATIBLE_NAME: "compat", OPENAI_API_KEY: "sk-env-openai", OPENAI_BASE_URL: undefined, OPENAI_COMPATIBLE_BASE_URL: "http://ollama:11434/v1", OPENAI_COMPATIBLE_API_KEY: undefined } as unknown as Config;
const actor = { id: "u1", email: "admin@example.com" };

function fakeDb() {
  const rows = new Map<string, { provider: string; apiKeyEnc: string | null; apiKeyHint: string | null; baseUrl: string | null; updatedBy: string | null; updatedAt: Date }>();
  const events: unknown[] = [];
  const tx = {
    insert: () => ({
      values: (v: any) => {
        if ("type" in v) {
          events.push(v);
          return Promise.resolve();
        }
        return { onConflictDoUpdate: () => Promise.resolve(void rows.set(v.provider, { ...v, updatedAt: new Date() })) };
      },
    }),
    delete: () => ({ where: (w: any) => Promise.resolve(void rows.delete(w?.provider ?? [...rows.keys()][0]!)) }),
  };
  const db = {
    query: { providerSettings: { findMany: async () => [...rows.values()], findFirst: async () => undefined } },
    transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  };
  return { db: db as unknown as Db, rows, events };
}

describe("secret box", () => {
  it("round-trips and rejects a different secret", () => {
    const a = createSecretBox("secret-one-that-is-long-enough");
    const sealed = a.encrypt("sk-live-1234");
    assert.notEqual(sealed, "sk-live-1234");
    assert.equal(a.decrypt(sealed), "sk-live-1234");
    assert.notEqual(a.encrypt("sk-live-1234"), sealed, "fresh iv each time");
    assert.throws(() => createSecretBox("another-secret-that-is-long-enough").decrypt(sealed));
  });
});

describe("provider settings", () => {
  it("environment by default; a stored key overrides it and bumps the version; clearing goes back", async () => {
    const { db, rows, events } = fakeDb();
    const ps = createProviderSettings(config, log, { pollMs: 0 });
    await ps.attach(db);
    assert.deepEqual(envCredentials(config, "openai"), { apiKey: "sk-env-openai" });
    assert.deepEqual(ps.get("openai"), { apiKey: "sk-env-openai" });
    assert.deepEqual(ps.get("compat"), { baseUrl: "http://ollama:11434/v1" });
    const v0 = ps.version();

    await ps.set("anthropic", { apiKey: "sk-ant-abcd1234" }, actor);
    assert.equal(ps.get("anthropic").apiKey, "sk-ant-abcd1234");
    assert.ok(ps.version() > v0);
    const row = rows.get("anthropic")!;
    assert.ok(row.apiKeyEnc && !row.apiKeyEnc.includes("abcd1234"), "stored encrypted");
    assert.equal(row.apiKeyHint, "1234");
    const st = ps.state().find((p) => p.provider === "anthropic")!;
    assert.equal(st.keySource, "db");
    assert.equal(st.keyLast4, "1234");
    assert.equal((events[0] as { type: string }).type, "provider.changed");

    // stored key wins over the environment, and a base URL can be set alone
    await ps.set("openai", { apiKey: "sk-db-openai", baseUrl: "http://speaches:8000/v1/" }, actor);
    assert.deepEqual(ps.get("openai"), { apiKey: "sk-db-openai", baseUrl: "http://speaches:8000/v1" });

    await ps.set("anthropic", { apiKey: null }, actor);
    assert.equal(ps.get("anthropic").apiKey, undefined);
    assert.equal(ps.state().find((p) => p.provider === "anthropic")!.keySource, null);
  });

  it("a key sealed under another secret is ignored and flagged, not fatal", async () => {
    const { db, rows } = fakeDb();
    const other = createSecretBox("some-other-secret-that-is-long-enough");
    rows.set("groq", { provider: "groq", apiKeyEnc: other.encrypt("gsk_x"), apiKeyHint: "sk_x", baseUrl: null, updatedBy: "x", updatedAt: new Date() });
    const ps = createProviderSettings(config, log, { pollMs: 0 });
    await ps.attach(db);
    assert.equal(ps.get("groq").apiKey, undefined);
    const st = ps.state().find((p) => p.provider === "groq")!;
    assert.equal(st.unreadable, true);
    assert.equal(st.hasKey, false);
  });
});
