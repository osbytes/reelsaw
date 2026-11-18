/**
 * Word timestamps are tested with a bundled clip, not looked up by model name (ai/word-timestamps.ts).
 * A fake OpenRouter-style server stands in for the provider: speech models only under
 * `/models?output_modalities=transcription`, OpenAI's multipart `/audio/transcriptions`.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createAi } from "../src/ai/registry.js";
import { createModelCatalog, looksLikeSpeechModel } from "../src/ai/catalog.js";
import { PROBE_READER, PROBE_TTL_MS, askedFor, isStale, memoryVerdictStore, verdictKey, type VerdictStore } from "../src/ai/word-timestamps.js";
import { compatTranscriptionModel, segmentsOf, wordsFirst } from "../src/ai/compat-transcription.js";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import type { TranscriptionModelV4 } from "@ai-sdk/provider";
import type { ProviderGate } from "../src/ai/gate.js";
import { transcribe } from "ai";
import type { Config } from "../src/config.js";
import type { Logger } from "../src/log.js";

const log = { info() {}, warn() {}, error() {}, debug() {}, child: () => log } as unknown as Logger;

const WORDS = "Reelsaw checks that this speech model returns a time for every single word".split(" ");
/** what each model id answers: word-level, phrase-level, or nothing heard */
const behaviour: Record<string, "words" | "segments" | "silent" | "refuses" | "unauthorized" | "whisper-both"> = {
  "openai/whisper-large-v3-turbo": "words",
  "openai/gpt-4o-transcribe": "segments",
  "acme/deaf": "silent",
  "microsoft/mai-transcribe-1.5": "refuses",
  "acme/locked": "unauthorized",
  // OpenAI's and Groq's own verbose_json when asked for word and segment granularities (osbytes/reelsaw#288)
  "whisper-large-v3": "whisper-both",
};

let server: http.Server;
let base = "";
let calls: Array<{ model: string; body: string; auth: string | undefined }> = [];

before(async () => {
  server = http.createServer((req, res) => {
    const json = (v: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    if (req.method === "GET" && req.url === "/v1/models")
      return json({ data: [{ id: "anthropic/claude-sonnet-4.5", architecture: { output_modalities: ["text"] } }] });
    if (req.method === "GET" && req.url === "/v1/models?output_modalities=transcription")
      return json({
        data: Object.keys(behaviour)
          .filter((id) => behaviour[id] !== "whisper-both") // a vendor's own model, not the router's
          .map((id) => ({ id, architecture: { output_modalities: ["transcription"] } })),
      });
    if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        const model = /name="model"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? "";
        calls.push({ model, body, auth: req.headers.authorization });
        const b = behaviour[model];
        if (b === "silent") return json({ text: "" });
        if (b === "refuses")
          return void res.writeHead(400, { "content-type": "application/json" }).end('{"error":{"message":"verbose_json is not supported"}}');
        if (b === "unauthorized") return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":{"message":"bad key"}}');
        if (b === "whisper-both")
          return json({
            text: WORDS.join(" "),
            x_groq: { id: "req_1" },
            language: "en",
            duration: 5.2,
            segments: [
              {
                id: 0,
                seek: 0,
                start: 0.3,
                end: 4.8,
                text: WORDS.join(" "),
                tokens: [1],
                temperature: 0,
                avg_logprob: -0.2,
                compression_ratio: 1,
                no_speech_prob: 0,
              },
            ],
            words: WORDS.map((w, i) => ({ word: w, start: 0.3 + i * 0.35, end: 0.6 + i * 0.35 })),
          });
        // OpenRouter's verbose_json: segments carry only start, end, text, and come along with words
        const segments = [{ start: 0.3, end: 4.8, text: WORDS.join(" ") }];
        if (b === "segments") return json({ text: WORDS.join(" "), segments });
        return json({
          text: WORDS.join(" "),
          language: "en",
          duration: 5.2,
          segments,
          words: WORDS.map((w, i) => ({ word: w, start: 0.3 + i * 0.35, end: 0.6 + i * 0.35 })),
        });
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
after(() => server.close());
beforeEach(() => {
  calls = [];
});

function config(): Config {
  return {
    AI_MODEL: "openrouter:anthropic/claude-sonnet-4.5",
    TRANSCRIPTION_MODEL: "openrouter:openai/whisper-large-v3-turbo",
    OPENAI_COMPATIBLE_NAME: "openrouter",
    OPENAI_COMPATIBLE_BASE_URL: base,
    OPENAI_COMPATIBLE_API_KEY: "sk-or-test",
    OPENAI_COMPATIBLE_STRUCTURED_OUTPUTS: true,
  } as unknown as Config;
}

describe("word-timestamp test transcription", () => {
  it("passes a compatible provider's whisper on the strength of its answer, sending OpenAI's word-timestamp options", async () => {
    const ai = createAi(config(), log);
    await ai.verify("transcription", "openrouter:openai/whisper-large-v3-turbo");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.body, /name="timestamp_granularities\[\]"\r\n\r\nword/);
    assert.match(calls[0]!.body, /name="response_format"\r\n\r\nverbose_json/);
    const v = await ai.wordTimestampVerdict("openrouter:openai/whisper-large-v3-turbo");
    assert.equal(v?.wordLevel, true);
    assert.equal(ai.transcriptionOptionsKey("openrouter:openai/whisper-large-v3-turbo"), "openai");
  });

  it("stores the verdict: a second verify does not call again, fresh does", async () => {
    const ai = createAi(config(), log);
    await ai.verify("transcription", "openrouter:openai/whisper-large-v3-turbo");
    await ai.verify("transcription", "openrouter:openai/whisper-large-v3-turbo");
    assert.equal(calls.length, 1);
    await ai.verify("transcription", "openrouter:openai/whisper-large-v3-turbo", { fresh: true });
    assert.equal(calls.length, 2);
  });

  it("runs one test for concurrent callers", async () => {
    const ai = createAi(config(), log);
    await Promise.all([1, 2, 3].map(() => ai.verify("transcription", "openrouter:openai/whisper-large-v3-turbo")));
    assert.equal(calls.length, 1);
  });

  it("rejects a model whose answer is phrase-level, and remembers that too", async () => {
    const ai = createAi(config(), log);
    await assert.rejects(ai.verify("transcription", "openrouter:openai/gpt-4o-transcribe"), /does not return word timestamps.*1 segment/);
    await assert.rejects(ai.verify("transcription", "openrouter:openai/gpt-4o-transcribe"), /does not return word timestamps/);
    assert.equal(calls.length, 1);
  });

  it("stores nothing when the model hears nothing: that is no verdict", async () => {
    const ai = createAi(config(), log);
    await assert.rejects(ai.verify("transcription", "openrouter:acme/deaf"), /failed a test transcription: it returned no text/);
    assert.equal(await ai.wordTimestampVerdict("openrouter:acme/deaf"), undefined);
  });

  it("stores a refused word-timestamp request as a verdict, not a failure", async () => {
    const ai = createAi(config(), log);
    const id = "openrouter:microsoft/mai-transcribe-1.5";
    await assert.rejects(ai.verify("transcription", id), /does not return word timestamps, .*: the server refused the request .*HTTP 400/);
    await assert.rejects(ai.verify("transcription", id), /does not return word timestamps/);
    assert.equal(calls.length, 1);
    assert.equal((await ai.wordTimestampVerdict(id))?.wordLevel, false);
  });

  it("keeps the last result when a re-test only fails to call, and stores nothing when there is none", async () => {
    const id = "openrouter:acme/locked";
    await assert.rejects(createAi(config(), log).verify("transcription", id), /failed a test transcription: .*401/);
    const store = memoryVerdictStore();
    const stale = { wordLevel: true, segments: 13, text: "earlier", checkedAt: new Date(Date.now() - PROBE_TTL_MS - 60_000).toISOString() };
    await store.set(verdictKey(id, base), stale);
    const ai = createAi(config(), log, null, undefined, undefined, null, store);
    await ai.verify("transcription", id);
    assert.deepEqual(await store.get(verdictKey(id, base)), stale);
    // Test (fresh) reports the failure instead
    await assert.rejects(ai.verify("transcription", id, { fresh: true }), /failed a test transcription/);
  });

  it("holds the cross-process lock and waits for a provider slot while testing", async () => {
    const ran: string[] = [];
    const gate = { run: async (p: string, fn: () => PromiseLike<unknown>) => (ran.push(`gate:${p}`), fn()) } as unknown as ProviderGate;
    const mem = memoryVerdictStore();
    const store: VerdictStore = { ...mem, exclusive: async (k, fn) => (ran.push(`lock:${k}`), fn()) };
    const ai = createAi(config(), log, null, undefined, undefined, gate, store);
    await ai.verify("transcription", "openrouter:openai/whisper-large-v3-turbo");
    assert.deepEqual(ran, [`lock:${verdictKey("openrouter:openai/whisper-large-v3-turbo", base)}`, "gate:openrouter"]);
  });

  it("keys verdicts by model and server, without credentials, and expires them", () => {
    assert.equal(verdictKey("openai:whisper-1"), "openai:whisper-1");
    assert.equal(verdictKey("openai:x", "http://speaches:8000/v1"), "openai:x @ http://speaches:8000/v1");
    const checkedAt = new Date(Date.now() - PROBE_TTL_MS - 1000).toISOString();
    assert.equal(isStale({ wordLevel: true, segments: 13, text: "", checkedAt }), true);
    assert.equal(isStale({ wordLevel: true, segments: 13, text: "", checkedAt: new Date().toISOString(), reader: PROBE_READER }), false);
    // made by an older way of reading answers: tested again, whatever its age
    assert.equal(isStale({ wordLevel: false, segments: 1, text: "", checkedAt: new Date().toISOString() }), true);
  });

  it("tests a model again when what it is asked changes, without a PROBE_READER bump", async () => {
    const fresh = { wordLevel: false, segments: 1, text: "", checkedAt: new Date().toISOString(), reader: PROBE_READER };
    const now = askedFor({ groq: { timestampGranularities: ["word"], responseFormat: "verbose_json" } });
    const before = askedFor({ groq: { timestampGranularities: ["word", "segment"], responseFormat: "verbose_json" } });
    assert.equal(askedFor({ groq: { responseFormat: "verbose_json", timestampGranularities: ["word"] } }), now, "key order does not matter");
    assert.equal(isStale({ ...fresh, asked: before }, { asked: now }), true);
    assert.equal(isStale({ ...fresh }, { asked: now }), true, "a verdict that never recorded its request");
    assert.equal(isStale({ ...fresh, asked: now }, { asked: now }), false);

    // end to end: a refusal stored for another request does not block the model
    const store = memoryVerdictStore();
    const id = "openrouter:openai/whisper-large-v3-turbo";
    await store.set(verdictKey(id, base), { ...fresh, asked: before, text: "refused for the old request" });
    const ai = createAi(config(), log, null, undefined, undefined, null, store);
    await ai.verify("transcription", id);
    assert.equal(calls.length, 1);
    const v = await store.get(verdictKey(id, base));
    assert.equal(v?.wordLevel, true);
    assert.equal(v?.asked, askedFor(ai.transcriptionOptions(id)));
  });

  it("reads words before segments from openai: on OPENAI_BASE_URL (Speaches answers with both)", async () => {
    const cfg = { ...config(), TRANSCRIPTION_MODEL: "openai:openai/whisper-large-v3-turbo", OPENAI_BASE_URL: base, OPENAI_API_KEY: "sk-test" } as Config;
    const ai = createAi(cfg, log);
    await ai.verify("transcription", "openai:openai/whisper-large-v3-turbo");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.body, /name="timestamp_granularities\[\]"\r\n\r\nword/);
    const v = await ai.wordTimestampVerdict("openai:openai/whisper-large-v3-turbo");
    assert.equal(v?.wordLevel, true);
    assert.equal(v?.segments, WORDS.length);
  });

  it("uses a verdict from the shared store without calling", async () => {
    const store = memoryVerdictStore();
    await store.set(verdictKey("openrouter:openai/gpt-4o-transcribe", base), {
      wordLevel: true,
      segments: 13,
      text: "from another process",
      checkedAt: new Date().toISOString(),
      reader: PROBE_READER,
      asked: askedFor({ openai: { timestampGranularities: ["word"] } }),
    });
    const ai = createAi(config(), log, null, undefined, undefined, null, store);
    await ai.verify("transcription", "openrouter:openai/gpt-4o-transcribe");
    assert.equal(calls.length, 0);
  });
});

describe("compatible transcription model", () => {
  it("prefers words over segments, sends the key and OpenAI's options, reads language and duration", async () => {
    const model = compatTranscriptionModel({ provider: "openrouter", baseURL: `${base}/`, apiKey: "sk-or-test" }, "openai/whisper-large-v3-turbo");
    const r = await transcribe({
      model,
      audio: new Uint8Array([1, 2, 3]),
      providerOptions: { openai: { timestampGranularities: ["word"], prompt: "Reelsaw", language: "en" } },
    });
    assert.equal(r.segments.length, WORDS.length);
    assert.equal(r.segments[0]!.text, "Reelsaw");
    assert.equal(r.language, "en");
    assert.equal(r.durationInSeconds, 5.2);
    assert.equal(calls[0]!.auth, "Bearer sk-or-test");
    assert.match(calls[0]!.body, /name="prompt"\r\n\r\nReelsaw/);
  });

  // @ai-sdk/openai and @ai-sdk/groq map `segments ?? words`: an answer with both loses the words (osbytes/reelsaw#288)
  const packages: Array<[string, () => TranscriptionModelV4, Record<string, Record<string, unknown>>]> = [
    [
      "groq",
      () => createGroq({ baseURL: base, apiKey: "gsk-test" }).transcription("whisper-large-v3"),
      { groq: { timestampGranularities: ["word", "segment"], responseFormat: "verbose_json" } },
    ],
    [
      "openai",
      () => createOpenAI({ baseURL: base, apiKey: "sk-test" }).transcription("whisper-large-v3"),
      { openai: { timestampGranularities: ["word", "segment"] } },
    ],
  ];
  for (const [name, make, providerOptions] of packages)
    it(`reads ${name}'s words when its answer also has segments`, async () => {
      const audio = new Uint8Array([1, 2, 3]);
      const bare = await transcribe({ model: make(), audio, providerOptions: providerOptions as never });
      assert.equal(bare.segments.length, 1, `@ai-sdk/${name} now reads words first: wordsFirst may be unneeded`);
      const r = await transcribe({ model: wordsFirst(make()), audio, providerOptions: providerOptions as never });
      assert.equal(r.segments.length, WORDS.length);
      assert.equal(r.segments[1]!.text, "checks");
      assert.equal(r.language, "en");
    });

  it("keeps a package's segments when its answer has no words", async () => {
    const segments = [{ text: "a b", startSecond: 0, endSecond: 1 }];
    const inner: TranscriptionModelV4 = {
      specificationVersion: "v4",
      provider: "test.transcription",
      modelId: "m",
      doGenerate: async () => ({
        text: "a b",
        segments,
        language: undefined,
        durationInSeconds: 1,
        warnings: [],
        response: { timestamp: new Date(), modelId: "m", body: "a b" },
      }),
    };
    const r = await transcribe({ model: wordsFirst(inner), audio: new Uint8Array([1]) });
    assert.deepEqual(r.segments, segments);
  });

  it("falls back to segments, and drops entries without numeric times", () => {
    assert.deepEqual(
      segmentsOf({
        words: [],
        segments: [
          { text: "a b", start: 0, end: 1 },
          { text: "x", start: "1" },
        ],
      }),
      [{ text: "a b", startSecond: 0, endSecond: 1 }],
    );
  });
});

describe("model picker for a compatible router", () => {
  it("files models by the modalities the server reports and notes test results", async () => {
    const ai = createAi(config(), log);
    await ai.verify("transcription", "openrouter:openai/whisper-large-v3-turbo");
    await ai.verify("transcription", "openrouter:openai/gpt-4o-transcribe").catch(() => {});
    const catalog = createModelCatalog(config(), log, undefined, (ids) => ai.wordTimestampVerdicts(ids));
    const stt = (await catalog.list("transcription")).find((p) => p.provider === "openrouter")!;
    assert.deepEqual(
      stt.models.map((m) => [m.id, m.note]),
      [
        ["openrouter:openai/whisper-large-v3-turbo", "word timestamps: passed"],
        ["openrouter:openai/gpt-4o-transcribe", "no word timestamps"],
        ["openrouter:acme/deaf", undefined],
        ["openrouter:microsoft/mai-transcribe-1.5", undefined],
        ["openrouter:acme/locked", undefined],
      ],
    );
    const lang = (await catalog.list("language")).find((p) => p.provider === "openrouter")!;
    assert.deepEqual(
      lang.models.map((m) => m.id),
      ["openrouter:anthropic/claude-sonnet-4.5"],
    );
  });

  it("guesses speech models by id only for lists that say nothing", () => {
    for (const id of ["whisper-1", "Systran/faster-whisper-small", "gpt-4o-mini-transcribe", "nvidia/parakeet-asr", "acme-stt-2"])
      assert.equal(looksLikeSpeechModel(id), true, id);
    for (const id of ["gpt-4o-mini", "llama-3.3-70b-versatile", "mistral-nemo", "first-light"]) assert.equal(looksLikeSpeechModel(id), false, id);
  });
});
