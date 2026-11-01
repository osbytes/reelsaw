/**
 * Durable steps, phase B: the LLM disfluency pass resumes from its saved windows and never reports a half-done pass as
 * done; clip.prepare reuses its map windows, scores and describe call. No database: an in-memory step store and a mock model.
 * Run: node --import tsx --test test/durable-steps-b.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import type { TranscriptSegment, Word } from "@reelsaw/shared";
import { StageTimeoutError, StaleJobError } from "../src/pipeline/common.js";
import { StepRunner, type StepStore, type StepWrite, type StoredStep } from "../src/pipeline/steps.js";
import { DISFLUENCY_PROMPT_VERSION, detectDisfluencies, type DisfluencyCheckpoint } from "../src/pipeline/disfluency.js";
import { describeStep, mapSelection, scoreStep } from "../src/pipeline/manual.js";
import { chunkTranscript, type SelectContext } from "../src/pipeline/select.js";

const alive = setInterval(() => {}, 1000);

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

class MemoryStore implements StepStore {
  rows = new Map<string, StoredStep & { clipId?: string }>();
  async read(name: string, key: string) {
    return this.rows.get(`${name}|${key}`);
  }
  async write(w: StepWrite) {
    this.rows.set(`${w.name}|${w.key}`, { status: w.status, output: w.output, clipId: w.clipId });
    return true;
  }
  done() {
    return [...this.rows.values()].filter((r) => r.status === "done").length;
  }
}

function runner(store: StepStore, signal: AbortSignal) {
  return new StepRunner({
    stage: "refine.disfluency",
    store,
    signal,
    log: quiet,
    progress: async () => {},
    idleMs: () => 0,
    timeoutError: (info) => new StageTimeoutError({ stage: "refine.disfluency", ...info }),
    onIdle: () => {},
    stale: () => new StaleJobError("p1", 1),
  });
}

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const reply = (text: string) => ({ content: [{ type: "text" as const, text }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] });

/** The text after "Text:" in a rewrite prompt: a model that returns every window unchanged. */
function promptText(prompt: unknown): string {
  const first = Array.isArray(prompt) ? prompt[0] : undefined;
  const part = first && Array.isArray(first.content) ? first.content[0] : undefined;
  const text = part && typeof part.text === "string" ? part.text : "";
  return text.slice(text.indexOf("Text:\n") + 6);
}

const words: Word[] = Array.from({ length: 600 }, (_, i) => ({ text: `word${i}`, start: i * 0.4, end: i * 0.4 + 0.3 }));
const WINDOWS = 5; // 600 words / 120

function checkpoint(r: StepRunner, model: string, timeoutMs: number): DisfluencyCheckpoint {
  return {
    all: (items, _phase, fn) => r.steps(items, { concurrency: 1, range: [0, 1], message: () => "" }, fn),
    step: (name, key, fn, schema, o) =>
      r.step(name, { ...key, model, promptVersion: DISFLUENCY_PROMPT_VERSION }, fn, { schema, timeoutMs: timeoutMs * (o.calls ?? 1), model, signal: o.signal }),
  };
}

describe("refine.disfluency windows as steps", () => {
  it("resumes after an abort: only the windows not saved are asked again, and the result matches a clean run", async () => {
    const asked: number[] = [];
    let kill: (() => void) | undefined;
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        asked.push(calls);
        if (++calls === 3) kill?.();
        return reply(JSON.stringify({ cleaned: promptText(opts.prompt) }));
      },
    });
    const store = new MemoryStore();
    const attempt = (abortAtThird: boolean) => {
      const ctl = new AbortController();
      if (abortAtThird) kill = () => ctl.abort(new Error("attempt killed"));
      const r = runner(store, ctl.signal);
      return detectDisfluencies(model, words, {
        signal: ctl.signal,
        checkpoint: checkpoint(r, "ollama:m", 5000),
        concurrency: 1,
        isFatal: (e) => e instanceof StageTimeoutError || e instanceof StaleJobError,
      });
    };
    await assert.rejects(attempt(true), /attempt killed/);
    const saved = store.done();
    assert.ok(saved >= 2 && saved < WINDOWS, `saved ${saved}`);
    const before = calls;
    const flags = await attempt(false);
    assert.equal(calls - before, WINDOWS - saved);
    assert.equal(store.done(), WINDOWS);
    assert.deepEqual(flags, []);
    // a third run with everything saved asks the model nothing
    const again = calls;
    await attempt(false);
    assert.equal(calls, again);
  });

  it("a window past its limit fails the pass instead of finishing with the flags found so far", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        if (++calls === 2) await new Promise((_, rej) => opts.abortSignal?.addEventListener("abort", () => rej(opts.abortSignal?.reason)));
        return reply(JSON.stringify({ cleaned: promptText(opts.prompt) }));
      },
    });
    const store = new MemoryStore();
    const ctl = new AbortController();
    const r = runner(store, ctl.signal);
    await assert.rejects(
      detectDisfluencies(model, words, {
        signal: ctl.signal,
        checkpoint: checkpoint(r, "ollama:m", 40),
        concurrency: 1,
        isFatal: (e) => e instanceof StageTimeoutError,
      }),
      (e) => e instanceof StageTimeoutError,
    );
    assert.equal(store.done(), 1); // the window before the slow one is kept for the retry
  });

  it("a window the model answers badly is skipped; the others still count", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => (++calls === 2 ? reply("not json at all") : reply(JSON.stringify({ cleaned: promptText(opts.prompt) }))),
    });
    const store = new MemoryStore();
    const ctl = new AbortController();
    const r = runner(store, ctl.signal);
    await detectDisfluencies(model, words, {
      signal: ctl.signal,
      checkpoint: checkpoint(r, "ollama:m", 5000),
      concurrency: 1,
      isFatal: (e) => e instanceof StageTimeoutError,
    });
    assert.equal(store.done(), WINDOWS - 1);
  });

  it("without a checkpoint a timed-out window is no longer swallowed", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        await new Promise((_, rej) => opts.abortSignal?.addEventListener("abort", () => rej(opts.abortSignal?.reason)));
        return reply("{}");
      },
    });
    await assert.rejects(detectDisfluencies(model, words, { timeoutMs: 30, concurrency: 1 }), (e) => e instanceof Error && e.name === "TimeoutError");
  });
});

function selection(): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (let t = 0; t < 1200; t += 5) segments.push({ start: t, end: t + 4.8, text: `Sentence number ${t} about budgeting and saving money for the future.` });
  return segments;
}
const sc: SelectContext = { title: "t", durationSec: 1200, minSec: 20, maxSec: 60 };

function stubCtx(r: StepRunner, signal: AbortSignal) {
  return { step: r.step.bind(r), signal, progress: async () => {} };
}

describe("clip.prepare as clip-scoped steps", () => {
  it("maps a long selection in windows and resumes with only the missing ones", async () => {
    const segments = selection();
    const windows = chunkTranscript(segments).length;
    assert.ok(windows >= 5);
    let calls = 0;
    let kill: (() => void) | undefined;
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        if (++calls === 3) kill?.();
        return reply('{"clips":[]}');
      },
    });
    const store = new MemoryStore();
    const run = (abort: boolean) => {
      const ctl = new AbortController();
      if (abort) kill = () => ctl.abort(new Error("attempt killed"));
      const r = runner(store, ctl.signal);
      return mapSelection(
        stubCtx(r, ctl.signal),
        { model, telemetry: false },
        { inside: segments, sc, clipId: "c1", modelId: "ollama:m", unitMs: 5000, concurrency: 1, log: quiet },
      );
    };
    await assert.rejects(run(true), /attempt killed/);
    const saved = store.done();
    assert.ok(saved >= 2 && saved < windows);
    const before = calls;
    assert.deepEqual(await run(false), []);
    assert.equal(calls - before, windows - saved);
    assert.ok([...store.rows.values()].every((row) => row.clipId === "c1"));
  });

  it("a map window that times out fails the prepare instead of falling back to the whole selection", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        await new Promise((_, rej) => opts.abortSignal?.addEventListener("abort", () => rej(opts.abortSignal?.reason)));
        return reply("{}");
      },
    });
    const ctl = new AbortController();
    const r = runner(new MemoryStore(), ctl.signal);
    await assert.rejects(
      mapSelection(
        stubCtx(r, ctl.signal),
        { model, telemetry: false },
        { inside: selection(), sc, clipId: "c1", modelId: "ollama:m", unitMs: 40, concurrency: 1, log: quiet },
      ),
      (e) => e instanceof StageTimeoutError,
    );
  });

  it("describe and score are reused on a retry", async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        calls++;
        const text = JSON.stringify(opts.prompt);
        return reply(
          text.includes("packaging")
            ? '{"title":"T","hook":"H","caption":"C","hashtags":["x"]}'
            : '{"scores":[{"id":1,"hook":7,"flow":6,"value":8,"shareability":5,"emphasis":["money"]}]}',
        );
      },
    });
    const store = new MemoryStore();
    const ctl = new AbortController();
    const ctx = stubCtx(runner(store, ctl.signal), ctl.signal);
    const o = { model, telemetry: false };
    const items = [{ id: 0, durationSec: 30, text: "money talk" }];
    const d1 = await describeStep(ctx, "c1", o, "ollama:m", 5000, "Vid", "money talk");
    const s1 = await scoreStep(ctx, "score", "c1", o, "ollama:m", 5000, items, sc);
    assert.equal(calls, 2);
    const ctx2 = stubCtx(runner(store, ctl.signal), ctl.signal);
    const d2 = await describeStep(ctx2, "c1", o, "ollama:m", 5000, "Vid", "money talk");
    const s2 = await scoreStep(ctx2, "score", "c1", o, "ollama:m", 5000, items, sc);
    assert.equal(calls, 2);
    assert.deepEqual(d2, d1);
    assert.deepEqual(s2, s1);
    assert.equal(s2.get(0)?.emphasis[0], "money");
    // other text, other answer: the saved describe no longer applies
    await describeStep(ctx2, "c1", o, "ollama:m", 5000, "Vid", "different words");
    assert.equal(calls, 3);
    assert.ok(z.string().safeParse(d1.title).success);
  });
});

it("(last) lets the process exit", () => clearInterval(alive));
