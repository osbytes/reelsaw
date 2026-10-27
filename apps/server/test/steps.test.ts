/**
 * Durable steps: reuse on retry, content-addressed keys, validated reads, aborts and timeouts that are never swallowed,
 * a superseded stage that stops, the idle timer, retry accounting, and an analyze-shaped resume with a mock model.
 * No database: the runner talks to an in-memory store. Run: node --import tsx --test test/steps.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import type { TranscriptSegment } from "@reelsaw/shared";
import { StageTimeoutError, StaleJobError, NonRetryableError, SourceExpiredError } from "../src/pipeline/common.js";
import { QuotaExceededError } from "../src/quota.js";
import { StepRunner, attemptOutcome, callSignal, etaSeconds, medianOf, stableStringify, stageTimeoutMessage, stepKey, type StageDetail, type StepKeyInput, type StepStore, type StepWrite, type StoredStep } from "../src/pipeline/steps.js";
import { MAP_PROMPT_VERSION, chunkTranscript, mapChunk, type SelectContext } from "../src/pipeline/select.js";
import { clipCandidateSchema } from "@reelsaw/shared";

// AbortSignal.timeout and the idle timer are unref'd: keep the loop alive while a test waits on them
const alive = setInterval(() => {}, 1000);

const quiet = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, trace() {}, child() { return quiet; } } as never;

/** The job_steps table in memory: rows by (name, key), writes refused once `stale` is set. */
class MemoryStore implements StepStore {
  rows = new Map<string, StoredStep & { attempts: number; lastError?: string; clipId?: string }>();
  stale = false;
  writes: StepWrite[] = [];
  async read(name: string, key: string) {
    return this.rows.get(`${name}|${key}`);
  }
  async write(w: StepWrite) {
    if (this.stale) return false;
    this.writes.push(w);
    const prev = this.rows.get(`${w.name}|${w.key}`);
    this.rows.set(`${w.name}|${w.key}`, { status: w.status, output: w.output, attempts: (prev?.attempts ?? 0) + 1, lastError: w.lastError, clipId: w.clipId });
    return true;
  }
  done() {
    return [...this.rows.values()].filter((r) => r.status === "done").length;
  }
}

function runner(store: StepStore, over: { signal?: AbortSignal; idleMs?: number; onIdle?: (e: Error) => void; progress?: Array<[number, string, StageDetail]> } = {}) {
  const ctl = new AbortController();
  const signal = over.signal ?? ctl.signal;
  const r = new StepRunner({
    stage: "analyze",
    store,
    signal,
    log: quiet,
    progress: async (f, m, d) => void over.progress?.push([f, m, d]),
    idleMs: () => over.idleMs ?? 0,
    timeoutError: (info) => new StageTimeoutError({ stage: "analyze", ...info }),
    onIdle: (e) => {
      over.onIdle?.(e);
      ctl.abort(e);
    },
    stale: () => new StaleJobError("p1", 3),
  });
  return { r, ctl };
}

const key = (over: Partial<StepKeyInput> = {}): StepKeyInput => ({ input: ["line a", "line b"], model: "ollama:m", promptVersion: "v1", params: { minSec: 20, focus: undefined }, ...over });
/** A model call that never answers and rejects when its signal fires, like fetch does (also when it is already fired). */
const hang = (signal: AbortSignal, as?: Error) =>
  new Promise<number[]>((_, rej) => {
    if (signal.aborted) return rej(as ?? signal.reason);
    signal.addEventListener("abort", () => rej(as ?? signal.reason));
  });
const numbers = z.array(z.number());

describe("step keys", () => {
  it("do not depend on object key order, and ignore undefined fields", () => {
    assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 1, x: 2 }], c: undefined } }), stableStringify({ a: { c: undefined, d: [1, { x: 2, y: 1 }] }, b: 1 }));
    assert.equal(stepKey(key({ params: { a: 1, b: 2 } })), stepKey(key({ params: { b: 2, a: 1 } })));
  });
  it("change with the input, the model, the prompt version and the parameters", () => {
    const base = stepKey(key());
    assert.notEqual(base, stepKey(key({ input: ["line a", "line c"] })));
    assert.notEqual(base, stepKey(key({ model: "ollama:other" })));
    assert.notEqual(base, stepKey(key({ promptVersion: "v2" })));
    assert.notEqual(base, stepKey(key({ params: { minSec: 25 } })));
    assert.match(base, /^[0-9a-f]{64}$/);
  });
});

describe("ctx.step", () => {
  it("runs once, saves the output, and a retry reuses it without calling fn", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const fn = async () => (calls++, [1, 2, 3]);
    assert.deepEqual(await runner(store).r.step("map:0", key(), fn, { schema: numbers, timeoutMs: 1000 }), [1, 2, 3]);
    // a new attempt: a new runner over the same table
    assert.deepEqual(await runner(store).r.step("map:0", key(), fn, { schema: numbers, timeoutMs: 1000 }), [1, 2, 3]);
    assert.equal(calls, 1);
    assert.equal(store.done(), 1);
  });

  it("counts only the steps it ran, not the ones it reused (the worker's progress test)", async () => {
    const store = new MemoryStore();
    const first = runner(store).r;
    await first.step("a", key(), async () => [1], { schema: numbers, timeoutMs: 1000 });
    assert.equal(first.completed, 1);
    const second = runner(store).r;
    await second.step("a", key(), async () => [1], { schema: numbers, timeoutMs: 1000 });
    assert.equal(second.completed, 0);
  });

  it("misses when the content, model, prompt version or parameters changed", async () => {
    const store = new MemoryStore();
    let calls = 0;
    const fn = async () => (calls++, [calls]);
    const { r } = runner(store);
    for (const k of [key(), key(), key({ input: ["new"] }), key({ model: "m2" }), key({ promptVersion: "v2" }), key({ params: { minSec: 30 } })]) await r.step("map:0", k, fn, { schema: numbers, timeoutMs: 1000 });
    assert.equal(calls, 5); // the second key() was the only hit
  });

  it("treats a stored output that no longer parses as a miss and runs the step again", async () => {
    const store = new MemoryStore();
    const k = key();
    store.rows.set(`map:0|${stepKey(k)}`, { status: "done", output: { not: "an array" }, attempts: 1 });
    let calls = 0;
    const out = await runner(store).r.step("map:0", k, async () => (calls++, [7]), { schema: numbers, timeoutMs: 1000 });
    assert.deepEqual(out, [7]);
    assert.equal(calls, 1);
    assert.deepEqual(store.rows.get(`map:0|${stepKey(k)}`)?.output, [7]);
  });

  it("does not reuse a failed row, and counts the attempt", async () => {
    const store = new MemoryStore();
    const { r } = runner(store);
    await assert.rejects(r.step("a", key(), async () => Promise.reject(new Error("model said no")), { schema: numbers, timeoutMs: 1000 }), /model said no/);
    assert.equal(store.rows.get(`a|${stepKey(key())}`)?.status, "failed");
    assert.equal(await r.step("a", key(), async () => [1], { schema: numbers, timeoutMs: 1000 }).then((x) => x[0]), 1);
    assert.equal(store.rows.get(`a|${stepKey(key())}`)?.attempts, 2);
  });

  it("does not swallow a cancelled job: the error comes back as it was and nothing is recorded", async () => {
    const store = new MemoryStore();
    const { r, ctl } = runner(store);
    const reason = new Error("job aborted (expired or cancelled)");
    const p = r.step("a", key(), (signal) => hang(signal), { schema: numbers, timeoutMs: 5000 });
    ctl.abort(reason);
    await assert.rejects(p, (e) => e === reason);
    assert.equal(store.writes.length, 0);
  });

  it("turns a unit that runs past its limit into a StageTimeoutError and records it as failed", async () => {
    const store = new MemoryStore();
    const { r } = runner(store);
    await assert.rejects(
      r.step("map:12", key({ model: "ollama:qwen2.5:14b" }), (signal) => hang(signal), { schema: numbers, timeoutMs: 20 }),
      (e) => e instanceof StageTimeoutError && e.kind === "unit" && e.model === "ollama:qwen2.5:14b" && /Finding moments timed out/.test(e.message),
    );
    assert.equal(store.writes[0]?.status, "failed");
  });

  it("exits with StaleJobError when the stage was superseded, on success and on failure", async () => {
    const stale = new MemoryStore();
    stale.stale = true;
    await assert.rejects(runner(stale).r.step("a", key(), async () => [1], { schema: numbers, timeoutMs: 1000 }), StaleJobError);
    await assert.rejects(runner(stale).r.step("b", key(), async () => Promise.reject(new Error("x")), { schema: numbers, timeoutMs: 1000 }), StaleJobError);
    assert.equal(stale.rows.size, 0);
  });

  it("stops a stage that finishes no step within the idle limit, and reports why", async () => {
    const store = new MemoryStore();
    let idled: Error | undefined;
    const { r } = runner(store, { idleMs: 30, onIdle: (e) => (idled = e) });
    await assert.rejects(
      r.step("a", key(), (signal) => hang(signal, new Error("This operation was aborted")), { schema: numbers, timeoutMs: 10_000 }),
      (e) => e instanceof StageTimeoutError && e.kind === "idle",
    );
    assert.ok(idled instanceof StageTimeoutError);
    assert.equal(r.idled, idled);
    assert.equal(store.writes.length, 0);
  });

  it("keeps the idle timer fed by finished steps", async () => {
    const store = new MemoryStore();
    const { r } = runner(store, { idleMs: 60 });
    for (let i = 0; i < 4; i++) await r.step(`s${i}`, key({ input: i }), async () => (await new Promise((res) => setTimeout(res, 25)), [i]), { schema: numbers, timeoutMs: 1000 });
    assert.equal(r.idled, undefined);
    r.stop();
  });
});

describe("idle timer outside a batch", () => {
  it("does not time work that follows a direct step", async () => {
    const store = new MemoryStore();
    const { r } = runner(store, { idleMs: 30 });
    await r.step("a", key(), async () => [1], { schema: numbers, timeoutMs: 1000 });
    await new Promise((res) => setTimeout(res, 100)); // non-step work (a scene-cut detect, a text scan) longer than the idle limit
    assert.equal(r.idled, undefined);
    r.stop();
  });
});

describe("ctx.steps", () => {
  it("reports done/total with a time left, bounds concurrency, and keeps input order", async () => {
    const store = new MemoryStore();
    const progress: Array<[number, string, StageDetail]> = [];
    const { r } = runner(store, { progress });
    let live = 0;
    let peak = 0;
    const items = [0, 1, 2, 3, 4, 5];
    const out = await r.steps(items, { concurrency: 2, range: [0.1, 0.5], message: (d, t) => `${d}/${t}` }, (i, _k, signal) =>
      r.step(`map:${i}`, key({ input: i }), async () => {
        peak = Math.max(peak, ++live);
        await new Promise((res) => setTimeout(res, 15));
        live--;
        return [i * 10];
      }, { schema: numbers, timeoutMs: 1000, signal }),
    );
    assert.deepEqual(out, [[0], [10], [20], [30], [40], [50]]);
    assert.ok(peak <= 2);
    assert.equal(progress.length, 6);
    const last = progress.at(-1)!;
    assert.ok(Math.abs(last[0] - 0.5) < 1e-9);
    assert.deepEqual([last[2].done, last[2].total, last[2].etaSec], [6, 6, 0]);
    assert.ok(progress[0]![2].etaSec !== null && progress[0]![2].unitMs !== null);
  });

  it("stops the units still waiting when one fails", async () => {
    const store = new MemoryStore();
    const { r } = runner(store);
    const started: number[] = [];
    await assert.rejects(
      r.steps([0, 1, 2, 3, 4, 5], { concurrency: 1, range: [0, 1], message: () => "" }, (i, _k, signal) =>
        r.step(`s${i}`, key({ input: i }), async () => {
          started.push(i);
          if (i === 1) throw new Error("bad window");
          return [i];
        }, { schema: numbers, timeoutMs: 1000, signal }),
      ),
      /bad window/,
    );
    assert.deepEqual(started, [0, 1]);
  });

  it("resumes after an abort in the middle of a map: only the windows not yet saved are asked again", async () => {
    const segments: TranscriptSegment[] = [];
    for (let t = 0; t < 1200; t += 5) segments.push({ start: t, end: t + 4.8, text: `Sentence number ${t} about budgeting and saving money for the future.` });
    const chunks = chunkTranscript(segments);
    assert.ok(chunks.length >= 5);
    const sc: SelectContext = { title: "t", durationSec: 1200, minSec: 20, maxSec: 60 };
    const asked: number[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        asked.push(opts.prompt.length);
        return { content: [{ type: "text", text: '{"clips":[]}' }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [] };
      },
    });
    const store = new MemoryStore();
    const schema = z.array(clipCandidateSchema);
    const attempt = async (signal: AbortSignal, stopAfter?: number) => {
      const ctl = new AbortController();
      const { r } = runner(store, { signal: AbortSignal.any([signal, ctl.signal]) });
      let done = 0;
      return r.steps(chunks, { concurrency: 1, range: [0, 1], message: () => "" }, (ch, i, sig) =>
        r.step(`map:${i}`, { input: ch.lines, model: "ollama:m", promptVersion: MAP_PROMPT_VERSION, params: sc }, async (s) => {
          const out = await mapChunk({ model, signal: s, telemetry: false }, ch, sc);
          if (stopAfter !== undefined && ++done >= stopAfter) ctl.abort(new Error("attempt killed"));
          return out;
        }, { schema, timeoutMs: 5000, signal: sig }),
      );
    };
    await assert.rejects(attempt(new AbortController().signal, 2), /attempt killed/);
    const saved = store.done();
    assert.ok(saved >= 2 && saved < chunks.length);
    const before = asked.length;
    const out = await attempt(new AbortController().signal);
    assert.equal(out.length, chunks.length);
    assert.equal(asked.length - before, chunks.length - saved);
    assert.equal(store.done(), chunks.length);
  });
});

describe("stage timeout message", () => {
  it("names the stage, the progress, the model and the way out", () => {
    const msg = stageTimeoutMessage({ stage: "analyze", done: 13, total: 43, model: "qwen2.5:14b", unitMs: 138_000, kind: "idle", elapsedMs: 30 * 60_000 });
    assert.equal(msg, "Finding moments timed out: 13 of 43 parts done in 30 min on qwen2.5:14b (~2.3 min per part). Retry continues where it stopped; a smaller or GPU-backed model is faster.");
    assert.equal(new StageTimeoutError({ stage: "analyze", done: 0, total: 0, model: "m", unitMs: null, kind: "unit", elapsedMs: 90_000 }).message, "Finding moments timed out: no part finished in 1.5 min on m. Retry continues where it stopped; a smaller or GPU-backed model is faster.");
  });
});

describe("retry accounting", () => {
  it("a retryable failure that finished steps is re-queued with a fresh budget; one that did not is left to pg-boss", () => {
    assert.equal(attemptOutcome({ progressed: true, retryable: true, nonRetryable: false }), "requeue");
    assert.equal(attemptOutcome({ progressed: false, retryable: true, nonRetryable: false }), "retry");
    assert.equal(attemptOutcome({ progressed: false, retryable: false, nonRetryable: false }), "retry");
    assert.equal(attemptOutcome({ progressed: true, retryable: false, nonRetryable: false }), "retry");
  });
  it("a non-retryable error fails the run at once, progress or not", () => {
    assert.equal(attemptOutcome({ progressed: true, retryable: false, nonRetryable: true }), "fail-now");
    assert.equal(attemptOutcome({ progressed: false, retryable: true, nonRetryable: true }), "fail-now");
  });
  it("the quota and expired-source errors are non-retryable", () => {
    assert.ok(new QuotaExceededError("too long") instanceof NonRetryableError);
    assert.ok(new SourceExpiredError(30) instanceof NonRetryableError);
    assert.ok(!(new StageTimeoutError({ stage: "analyze", done: 1, total: 2, model: "m", unitMs: 1, kind: "idle", elapsedMs: 1 }) instanceof NonRetryableError));
  });
});

describe("helpers", () => {
  it("median and time left", () => {
    assert.equal(medianOf([]), null);
    assert.equal(medianOf([3, 1, 2]), 2);
    assert.equal(medianOf([1, 2, 3, 10]), 2.5);
    assert.equal(etaSeconds(30, 120_000, 1), 3600);
    assert.equal(etaSeconds(30, 120_000, 2), 1800);
    assert.equal(etaSeconds(5, null), null);
  });
  it("a call limit is added to the caller's signal", async () => {
    assert.equal(callSignal(undefined, undefined), undefined);
    const parent = new AbortController();
    assert.equal(callSignal(parent.signal, undefined), parent.signal);
    const limited = callSignal(parent.signal, 15)!;
    await new Promise((res) => setTimeout(res, 40));
    assert.equal(limited.aborted, true);
    assert.equal(parent.signal.aborted, false);
  });
});

it("(last) lets the process exit", () => clearInterval(alive));
