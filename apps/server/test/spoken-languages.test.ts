/**
 * The spoken languages a transcription model takes (ai/spoken-languages.ts): what Speaches and Deepgram
 * list, Whisper's set for the providers that say nothing, and a failed listing. No network: fetch is stubbed.
 * Run: node --import tsx --test test/spoken-languages.test.ts
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { WHISPER_SPOKEN_LANGUAGES } from "@reelsaw/shared";
import type { Logger } from "../src/log.js";
import {
  canonicalCodes,
  clearSpokenLanguagesCache,
  compatModelLanguages,
  deepgramModelLanguages,
  languageForModel,
  spokenLanguages,
} from "../src/ai/spoken-languages.js";

const warned: unknown[] = [];
const log = { info() {}, warn: (o: unknown) => warned.push(o), error() {}, debug() {}, child: () => log } as unknown as Logger;

function deps(transcription: string, creds: Record<string, { apiKey?: string; baseUrl?: string }> = {}) {
  return {
    models: { get: () => ({ language: "x:y", transcription, align: transcription }) },
    providers: { get: (p: string) => creds[p] ?? {}, version: () => 1 },
    config: { OPENAI_COMPATIBLE_NAME: "local" },
    log,
  } as unknown as Parameters<typeof spokenLanguages>[0];
}

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; headers: Record<string, string> }> = [];
function stubFetch(answer: (url: string) => unknown) {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
    const body = answer(String(url));
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status: body === undefined ? 404 : 200 });
  }) as typeof fetch;
}
beforeEach(() => {
  clearSpokenLanguagesCache();
  calls = [];
  warned.length = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("listings", () => {
  it("canonicalises and drops what is not a language", () => {
    assert.deepEqual(canonicalCodes(["en", "en-US", "jw", "zh-CN", "multi", "mul", "und", 3, "pt-BR"]), ["en", "jv", "zh", "pt"]);
  });
  it("reads a Speaches model's languages, and nothing from a server that does not say", () => {
    const body = { data: [{ id: "Systran/faster-whisper-small", language: ["en", "de", "jw"] }, { id: "other" }] };
    assert.deepEqual(compatModelLanguages(body, "Systran/faster-whisper-small"), ["en", "de", "jv"]);
    assert.equal(compatModelLanguages(body, "other"), undefined);
    assert.equal(compatModelLanguages({ data: [{ id: "whisper-1" }] }, "whisper-1"), undefined, "OpenAI's own /models");
  });
  it("unions the languages of the Deepgram batch models an id names", () => {
    const body = {
      stt: [
        { name: "general", canonical_name: "nova-3-general", architecture: "nova-3", languages: ["en", "en-US", "es"], batch: true },
        { name: "medical", canonical_name: "nova-3-medical", architecture: "nova-3", languages: ["en"], batch: true },
        { name: "general", canonical_name: "nova-3-general", architecture: "nova-3", languages: ["fr"], batch: false },
        { name: "general", canonical_name: "nova-2-general", architecture: "nova-2", languages: ["de", "multi"], batch: true },
      ],
    };
    assert.deepEqual(deepgramModelLanguages(body, "nova-3"), ["en", "es"]);
    assert.deepEqual(deepgramModelLanguages(body, "nova-2-general"), ["de"]);
    assert.equal(deepgramModelLanguages(body, "general"), undefined, "a name shared by several architectures names none of them");
    assert.equal(deepgramModelLanguages(body, "nova-9"), undefined);
  });
});

describe("spokenLanguages", () => {
  it("asks a self-hosted server for the model in force", async () => {
    stubFetch(() => ({ data: [{ id: "Systran/faster-whisper-small", language: ["en", "de"] }] }));
    const r = await spokenLanguages(deps("openai:Systran/faster-whisper-small", { openai: { baseUrl: "http://speaches:8000/v1/" } }));
    assert.equal(r.source, "model");
    assert.deepEqual(r.languages, [
      { code: "en", name: "English" },
      { code: "de", name: "German" },
    ]);
    assert.equal(calls[0]?.url, "http://speaches:8000/v1/models");
  });
  it("asks Deepgram with its key", async () => {
    stubFetch(() => ({ stt: [{ architecture: "nova-3", languages: ["es"], batch: true }] }));
    const r = await spokenLanguages(deps("deepgram:nova-3", { deepgram: { apiKey: "k" } }));
    assert.deepEqual(r.languages, [{ code: "es", name: "Spanish" }]);
    assert.equal(calls[0]?.headers.authorization, "Token k");
  });
  it("assumes Whisper's set for a provider that says nothing, without asking", async () => {
    stubFetch(() => new Error("should not be called"));
    const r = await spokenLanguages(deps("groq:whisper-large-v3-turbo", { groq: { apiKey: "k" } }));
    assert.equal(r.source, "whisper");
    assert.equal(r.languages.length, WHISPER_SPOKEN_LANGUAGES.length);
    assert.equal(calls.length, 0);
  });
  it("sends a base URL's credentials as a header, never in the URL or the log", async () => {
    stubFetch(() => ({ data: [{ id: "m", language: ["en"] }] }));
    const r = await spokenLanguages(deps("local:m", { local: { baseUrl: "http://us%40er:s3cret@speaches:8000/v1" } }));
    assert.equal(r.source, "model");
    assert.equal(calls[0]?.url, "http://speaches:8000/v1/models");
    assert.equal(calls[0]?.headers.authorization, `Basic ${btoa("us@er:s3cret")}`);
    clearSpokenLanguagesCache();
    stubFetch(() => new Error("connect ECONNREFUSED http://us:s3cret@speaches:8000/v1/models"));
    await spokenLanguages(deps("local:m", { local: { baseUrl: "http://us:s3cret@speaches:8000/v1" } }));
    assert.doesNotMatch(JSON.stringify(warned), /s3cret/);
  });
  it("falls back to Whisper's set when the listing fails, and says so in the log", async () => {
    stubFetch(() => new Error("connect ECONNREFUSED"));
    const r = await spokenLanguages(deps("local:whisper", { local: { baseUrl: "http://nowhere/v1" } }));
    assert.equal(r.source, "whisper");
    assert.equal(warned.length, 1);
  });
  it("sends a language only when the model takes it", async () => {
    stubFetch(() => ({ data: [{ id: "Systran/faster-whisper-small", language: ["en", "de"] }] }));
    const m = "openai:Systran/faster-whisper-small";
    const d = deps(m, { openai: { baseUrl: "http://speaches:8000/v1" } });
    assert.equal(await languageForModel(d, m, "German"), "de");
    assert.equal(await languageForModel(d, m, "yue"), undefined, "not listed: detect, never a 400");
    assert.equal(await languageForModel(d, m, "Englsh"), undefined);
    assert.equal(await languageForModel(deps("groq:whisper-large-v3"), "groq:whisper-large-v3", "xx"), undefined, "Whisper's set holds for a Whisper model");
    assert.equal(await languageForModel(deps("assemblyai:best"), "assemblyai:best", "xx"), "xx", "a model that does not say is sent the code");
  });
  it("caches per model", async () => {
    stubFetch(() => ({ data: [{ id: "m", language: ["en"] }] }));
    const d = deps("local:m", { local: { baseUrl: "http://s/v1" } });
    await spokenLanguages(d);
    await spokenLanguages(d);
    assert.equal(calls.length, 1);
  });
});
