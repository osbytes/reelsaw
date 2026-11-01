/**
 * Transcribe chunk steps (key and the small saved output), the speech-to-text cache shared through an S3-style store
 * (write-through, read-through, prune), and the stall sentence. No stack: fakes for the store and the model.
 * Run: node --import tsx --test test/asr-cache-steps.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockTranscriptionModelV4 } from "ai/test";
import { createAsr, asrCacheKey } from "../src/ai/asr.js";
import { keys, type Storage } from "../src/storage/index.js";
import { chunkStepKey, chunkStepName, chunkStepOutput, chunkStepSchema } from "../src/pipeline/asr-loops.js";
import { stepKey } from "../src/pipeline/steps.js";
import { stallSentence } from "../src/queue/reconcile.js";

const quiet = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  trace() {},
  child() {
    return quiet;
  },
} as never;

/** An S3-shaped store in memory: objects by key with a modified time. */
class FakeStore implements Storage {
  driver: "local" | "s3";
  objects = new Map<string, { body: string; modifiedAt: Date }>();
  constructor(driver: "local" | "s3" = "s3") {
    this.driver = driver;
  }
  async check() {}
  async putFile(key: string, localPath: string) {
    this.objects.set(key, { body: await fs.readFile(localPath, "utf8"), modifiedAt: new Date() });
  }
  async ensureLocal(key: string, localPath: string) {
    const o = this.objects.get(key);
    if (!o) throw new Error(`storage object missing: ${key}`);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, o.body);
    return localPath;
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
  async resolve(): Promise<{ url: string }> {
    return { url: "" };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async deletePrefix() {}
  async list(prefix: string, limit: number) {
    return [...this.objects]
      .filter(([k]) => k.startsWith(prefix))
      .slice(0, limit)
      .map(([key, o]) => ({ key, modifiedAt: o.modifiedAt }));
  }
}

function fakeAi(calls: { n: number }) {
  const model = new MockTranscriptionModelV4({
    doGenerate: async () => {
      calls.n++;
      return {
        text: "hello there",
        segments: [{ text: "hello there", startSecond: 0, endSecond: 1 }],
        language: "en",
        durationInSeconds: 1,
        warnings: [],
        response: { timestamp: new Date(), modelId: "m", headers: {} },
      };
    },
  });
  return { transcriptionOptions: () => ({}), transcriptionModel: async () => model } as never;
}

const audio = new Uint8Array([1, 2, 3, 4]);

describe("ASR cache on a shared store", () => {
  it("writes through after a provider call and reads through on a local miss from another host", async () => {
    const store = new FakeStore();
    const calls = { n: 0 };
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), "asr-a-"));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), "asr-b-"));
    const a = createAsr(fakeAi(calls), () => "openai/whisper-1", dirA, quiet, null, store);
    const first = await a.transcribe(audio);
    assert.equal(first.cached, false);
    assert.equal(calls.n, 1);
    const key = a.keyFor(audio);
    assert.equal(key, asrCacheKey("openai/whisper-1", {}, audio));
    assert.ok(store.objects.has(keys.asrCache(key)), "the entry is in the store");
    // a second host: empty local cache, same store
    const b = createAsr(fakeAi(calls), () => "openai/whisper-1", dirB, quiet, null, store);
    const second = await b.transcribe(audio);
    assert.equal(second.cached, true);
    assert.equal(second.text, "hello there");
    assert.equal(calls.n, 1, "no second provider call");
  });

  it("keeps today's behaviour with the local driver: nothing goes to the store", async () => {
    const store = new FakeStore("local");
    const calls = { n: 0 };
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asr-l-"));
    const asr = createAsr(fakeAi(calls), () => "openai/whisper-1", dir, quiet, null, store);
    await asr.transcribe(audio);
    assert.equal(store.objects.size, 0);
    assert.equal((await asr.transcribe(audio)).cached, true);
  });

  it("prunes store entries older than the cutoff and keeps newer ones", async () => {
    const store = new FakeStore();
    store.objects.set("cache/asr/old.json", { body: "{}", modifiedAt: new Date(Date.now() - 30 * 86_400_000) });
    store.objects.set("cache/asr/new.json", { body: "{}", modifiedAt: new Date() });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "asr-p-"));
    const removed = await createAsr(fakeAi({ n: 0 }), () => "m", dir, quiet, null, store).prune(14);
    assert.equal(removed, 1);
    assert.deepEqual([...store.objects.keys()], ["cache/asr/new.json"]);
  });
});

describe("transcribe chunk steps", () => {
  it("names the step by chunk and keys it on the audio hash, model, chunk place and rule version", () => {
    assert.equal(chunkStepName(3), "chunk:3");
    const k = chunkStepKey("abc", "openai/whisper-1", 3, 1800.0004);
    assert.equal(k.input, "abc");
    assert.equal(stepKey(k), stepKey(chunkStepKey("abc", "openai/whisper-1", 3, 1800.0004)));
    assert.notEqual(stepKey(k), stepKey(chunkStepKey("abd", "openai/whisper-1", 3, 1800.0004)), "other audio");
    assert.notEqual(stepKey(k), stepKey(chunkStepKey("abc", "openai/whisper-1", 4, 1800.0004)), "other chunk");
    assert.notEqual(stepKey(k), stepKey(chunkStepKey("abc", "other-model", 3, 1800.0004)), "other model");
  });

  it("saves counts and a pointer, never the words", () => {
    const out = chunkStepOutput(2, "so I think  we should go", 3, 4200.4);
    assert.deepEqual(out, { chunkIndex: 2, segments: 3, words: 6, durationMs: 4200, fromRow: false });
    assert.ok(chunkStepSchema.safeParse(out).success);
    assert.ok(!("text" in out));
    assert.equal(chunkStepSchema.safeParse({ chunkIndex: 1 }).success, false);
  });
});

describe("stallSentence", () => {
  it("says which stage, how many parts are done and when the last finished", () => {
    assert.equal(
      stallSentence({ stage: "analyze", idleMinutes: 15, done: 13, total: 43, lastStepMinutes: 16, ticking: false }),
      "Finding moments has made no progress for 15 min: 13 of 43 parts done, last part finished 16 min ago.",
    );
  });
  it("flags a model that keeps ticking without finishing a part", () => {
    assert.equal(
      stallSentence({ stage: "transcribe", idleMinutes: 5, done: 2, total: 9, lastStepMinutes: 21, ticking: true }),
      "Transcribing is still reporting activity but no part has finished for 21 min: 2 of 9 parts done.",
    );
  });
  it("still reads for a stage with no steps", () => {
    assert.equal(
      stallSentence({ stage: "ingest", idleMinutes: 20, done: null, total: null, lastStepMinutes: null, ticking: false }),
      "Preparing the video has made no progress for 20 min.",
    );
    assert.equal(
      stallSentence({ stage: null, idleMinutes: 20, done: null, total: null, lastStepMinutes: null, ticking: false }),
      "This project has made no progress for 20 min.",
    );
  });
});
