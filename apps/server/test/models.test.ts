/** Runtime model override: precedence over the environment, verification before save, ignored-when-invalid on load. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createModelSettings, parseOverride, resolveModels } from "../src/ai/models.js";
import { supportsWordTimestamps } from "../src/ai/registry.js";
import type { Config } from "../src/config.js";
import type { Db } from "../src/db/index.js";
import type { Logger } from "../src/log.js";

const env = { language: "openai:gpt-4o-mini", transcription: "openai:whisper-1", align: "openai:whisper-1" };

/** Just enough of drizzle for models.ts: one row keyed by `key`, plus the admin events it writes. */
function fakeDb() {
  const rows = new Map<string, { key: string; value: Record<string, unknown>; updatedBy: string | null; updatedAt: Date }>();
  const events: unknown[] = [];
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
    query: { instanceSettings: { findFirst: async () => rows.get("models") } },
    transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
  };
  return { db: db as unknown as Db, rows, events };
}

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as unknown as Logger;
const config = { AI_MODEL: env.language, TRANSCRIPTION_MODEL: env.transcription, TRANSCRIPT_ALIGN_MODEL: undefined } as unknown as Config;
const actor = { id: "u1", email: "admin@example.com" };

describe("resolveModels", () => {
  it("environment when nothing is overridden; align follows transcription unless the env pins it", () => {
    assert.deepEqual(resolveModels(env, {}, false), env);
    assert.deepEqual(resolveModels(env, { transcription: "deepgram:nova-3" }, false), { ...env, transcription: "deepgram:nova-3", align: "deepgram:nova-3" });
    const pinned = { ...env, align: "openai:Systran/faster-whisper-medium" };
    assert.deepEqual(resolveModels(pinned, { transcription: "deepgram:nova-3" }, true), { ...pinned, transcription: "deepgram:nova-3" });
    assert.equal(resolveModels(env, { align: "groq:whisper-large-v3-turbo" }, false).align, "groq:whisper-large-v3-turbo");
  });
  it("parseOverride keeps only provider:model strings for the three kinds", () => {
    assert.deepEqual(parseOverride({ language: "anthropic:claude-haiku-4.5", transcription: 3, align: "nope", other: "x:y" }), { language: "anthropic:claude-haiku-4.5" });
    assert.deepEqual(parseOverride(null), {});
  });
});

describe("supportsWordTimestamps", () => {
  it("whisper everywhere, deepgram/assemblyai/groq; not gpt-4o-transcribe", () => {
    for (const id of ["openai:whisper-1", "gateway:openai/whisper-1", "openai:Systran/faster-whisper-small", "deepgram:nova-3", "assemblyai:best", "groq:whisper-large-v3-turbo"]) assert.equal(supportsWordTimestamps(id), true, id);
    for (const id of ["openai:gpt-4o-transcribe", "gateway:openai/gpt-4o-mini-transcribe", "gateway:google/gemini-3.5-transcribe"]) assert.equal(supportsWordTimestamps(id), false, id);
  });
});

describe("createModelSettings", () => {
  it("saves a verified override, applies it at once, records an admin event, and clears back to the environment", async () => {
    const { db, rows, events } = fakeDb();
    const verified: string[] = [];
    const ms = createModelSettings(config, log, async (_k, id) => void verified.push(id), { pollMs: 0 });
    await ms.attach(db);
    assert.deepEqual(ms.get(), env);

    const st = await ms.set({ language: "anthropic:claude-haiku-4.5" }, actor);
    assert.equal(st.current.language, "anthropic:claude-haiku-4.5");
    assert.equal(ms.get().language, "anthropic:claude-haiku-4.5");
    assert.deepEqual(st.override, { language: "anthropic:claude-haiku-4.5" });
    assert.equal(rows.get("models")?.updatedBy, actor.email);
    assert.equal((events[0] as { type: string }).type, "models.changed");
    assert.ok(verified.includes("anthropic:claude-haiku-4.5"));

    // setting the env value or null removes the override; an empty override removes the row
    await ms.set({ language: null }, actor);
    assert.deepEqual(ms.get(), env);
    assert.equal(rows.size, 0);
  });

  it("refuses an override that fails verification and saves nothing", async () => {
    const { db, rows } = fakeDb();
    const ms = createModelSettings(
      config,
      log,
      async (_k, id) => {
        if (id.startsWith("openai:gpt-4o-transcribe")) throw new Error("no word timestamps");
      },
      { pollMs: 0 },
    );
    await ms.attach(db);
    await assert.rejects(() => ms.set({ transcription: "openai:gpt-4o-transcribe", language: "anthropic:claude-haiku-4.5" }, actor), /transcription: no word timestamps/);
    assert.equal(rows.size, 0);
    assert.deepEqual(ms.get(), env);
  });

  it("ignores a stored override that no longer verifies (key removed) and says why", async () => {
    const { db, rows } = fakeDb();
    rows.set("models", { key: "models", value: { language: "anthropic:claude-haiku-4.5", transcription: "deepgram:nova-3" }, updatedBy: "x", updatedAt: new Date() });
    const ms = createModelSettings(
      config,
      log,
      async (_k, id) => {
        if (id.startsWith("anthropic:")) throw new Error('"anthropic:claude-haiku-4.5" needs ANTHROPIC_API_KEY to be set');
      },
      { pollMs: 0 },
    );
    const st = await ms.attach(db);
    assert.equal(st.current.language, env.language);
    assert.equal(st.current.transcription, "deepgram:nova-3");
    assert.equal(st.current.align, "deepgram:nova-3");
    assert.match(st.ignored.language ?? "", /ANTHROPIC_API_KEY/);
    assert.deepEqual(st.override, { transcription: "deepgram:nova-3" });
  });

  it("refresh picks up a change made by another process", async () => {
    const { db, rows } = fakeDb();
    const ms = createModelSettings(config, log, async () => {}, { pollMs: 0 });
    await ms.attach(db);
    rows.set("models", { key: "models", value: { language: "google:gemini-2.5-flash" }, updatedBy: "other", updatedAt: new Date() });
    assert.equal(ms.get().language, env.language);
    await ms.refresh();
    assert.equal(ms.get().language, "google:gemini-2.5-flash");
    assert.equal(ms.state().updatedBy, "other");
  });
});
