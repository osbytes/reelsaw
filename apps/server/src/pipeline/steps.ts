/**
 * Durable steps: the units of work of a long stage (a map window, a scoring batch) saved as they finish, so a
 * retry, a restart or a timeout resumes where the stage stopped instead of starting over (docs/SELECTION.md).
 *
 * `StepRunner` holds the logic and talks to a `StepStore`, so it runs without a database in tests; `StageContext`
 * (common.ts) wires it to the `job_steps` table (`dbStepStore`) and exposes it as `ctx.step` / `ctx.steps`.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { schema, type Db } from "../db/index.js";
import type { Logger } from "../log.js";
import { histogram } from "../metrics.js";
import { mapLimit } from "../lib/batch.js";

/** What a unit of work is keyed on: change any part and the saved result no longer applies. */
export interface StepKeyInput {
  /** the content the unit works on (transcript lines, candidate texts) */
  input: unknown;
  model: string;
  /** bumped by hand whenever the prompt text changes */
  promptVersion: string;
  /** the settings that change the answer (focus, clip lengths, samples) */
  params?: unknown;
}

/** JSON with object keys sorted, so equal values serialise equally whatever order they were built in. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function stepKey(input: StepKeyInput): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

/** A cancelled or timed-out call as the platform and the AI SDK report it. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * The signal for ONE logical model call: the caller's, plus a limit on the call as a whole (every HTTP attempt, the
 * salvage and plain-text fallbacks included). No limit given: the caller's signal as it is.
 */
export function callSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs) return signal;
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

export function medianOf(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Seconds left: the units still to do at the typical unit time, `concurrency` at a time. Null before one has run. */
export function etaSeconds(remaining: number, unitMs: number | null, concurrency = 1): number | null {
  if (unitMs === null || remaining < 0) return null;
  return Math.round((remaining * unitMs) / Math.max(1, concurrency) / 1000);
}

export interface StageDetail {
  done: number;
  total: number;
  etaSec: number | null;
  unitMs: number | null;
}

/** The stages' plain-language names (the UI calls the analyze stage "Finding moments"). */
export const STAGE_LABEL: Record<string, string> = {
  ingest: "Preparing the video",
  transcribe: "Transcribing",
  refine: "Refining the transcript",
  analyze: "Finding moments",
  render: "Rendering",
};

const humanDuration = (ms: number): string => {
  const tidy = (n: number) => (n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10));
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 90 * 60_000) return `${tidy(ms / 60_000)} min`;
  return `${tidy(ms / 3_600_000)} h`;
};

export interface StageTimeoutInfo {
  stage: string;
  /** units finished in the stage so far (0 and total 0: not a stage of steps) */
  done: number;
  total: number;
  model: string;
  /** typical time of one unit on this model, ms (null before one finished) */
  unitMs: number | null;
  /** unit: one call ran past its limit; idle: no unit finished for the idle limit */
  kind: "unit" | "idle";
  /** time spent in this attempt, ms */
  elapsedMs: number;
}

/** The sentence a person reads when a stage timed out (stored as the project's error). */
export function stageTimeoutMessage(i: StageTimeoutInfo): string {
  const label = STAGE_LABEL[i.stage] ?? i.stage;
  const progress = i.total > 0 ? `${i.done} of ${i.total} parts done in ${humanDuration(i.elapsedMs)} on ${i.model}${i.unitMs ? ` (~${humanDuration(i.unitMs)} per part)` : ""}` : `no part finished in ${humanDuration(i.elapsedMs)} on ${i.model}`;
  return `${label} timed out: ${progress}. Retry continues where it stopped; a smaller or GPU-backed model is faster.`;
}

/** One attempt's verdict from the worker's point of view; see queue/workers.ts. */
export type AttemptOutcome = "fail-now" | "requeue" | "retry";

/**
 * What to do with an attempt that threw. A non-retryable error ends the run at once. A retryable one that finished at
 * least one new step goes back on the queue with a fresh retry budget (it is getting somewhere, only slowly); one that
 * finished nothing is left to pg-boss, whose `retryLimit` caps attempts that make no progress.
 */
export function attemptOutcome(a: { progressed: boolean; retryable: boolean; nonRetryable: boolean }): AttemptOutcome {
  if (a.nonRetryable) return "fail-now";
  if (a.retryable && a.progressed) return "requeue";
  return "retry";
}

/** A saved step as `StepStore.read` returns it. */
export interface StoredStep {
  status: "done" | "failed";
  output: unknown;
}

export interface StepWrite {
  name: string;
  key: string;
  clipId?: string;
  status: "done" | "failed";
  output?: unknown;
  ms?: number;
  lastError?: string;
}

export interface StepStore {
  read(name: string, key: string): Promise<StoredStep | undefined>;
  /** Save one step in a single statement, only while the stage's version is current. False: superseded. */
  write(row: StepWrite): Promise<boolean>;
}

/** The `job_steps` table of one project and stage. `seq` is the stage version the writes are guarded by. */
export function dbStepStore(db: Db, projectId: string, stage: string, seq: number | undefined): StepStore {
  const t = schema.jobSteps;
  const current = seq === undefined ? sql`${schema.projects.id} = ${projectId} and ${schema.projects.deletedAt} is null` : sql`${schema.projects.id} = ${projectId} and ${schema.projects.deletedAt} is null and ${schema.projects.stageSeq} = ${seq}`;
  return {
    async read(name, key) {
      const [row] = await db.select({ status: t.status, output: t.output }).from(t).where(and(eq(t.projectId, projectId), eq(t.stage, stage), eq(t.name, name), eq(t.key, key)));
      return row;
    },
    async write(w) {
      const output = w.output === undefined ? null : JSON.stringify(w.output);
      // one statement: the row lands only while this job's version of the project is current
      const res = await db.execute(sql`
        insert into job_steps (project_id, clip_id, stage, name, key, status, output, attempts, last_error, stage_seq, ms)
        select ${schema.projects.id}, ${w.clipId ?? null}::text, ${stage}::text, ${w.name}::text, ${w.key}::text, ${w.status}::text, ${output}::jsonb, 1, ${w.lastError ?? null}::text, ${schema.projects.stageSeq}, ${w.ms === undefined ? null : Math.round(w.ms)}::integer
        from ${schema.projects} where ${current}
        on conflict (project_id, stage, name, key) do update set
          status = excluded.status, output = excluded.output, last_error = excluded.last_error, ms = excluded.ms,
          stage_seq = excluded.stage_seq, attempts = job_steps.attempts + 1, updated_at = now()
        returning 1 as ok`);
      return res.rows.length > 0;
    },
  };
}

export interface StepOptions<T> {
  /** validates what is read back; a row that does not parse is a miss */
  schema: z.ZodType<T>;
  /** this unit's own limit (ms) */
  timeoutMs: number;
  clipId?: string;
  /** shown in the timeout message */
  model?: string;
  /** aborts this step too (the batch it belongs to failed) */
  signal?: AbortSignal;
}

export interface StepsOptions {
  concurrency: number;
  /** stage progress runs from range[0] to range[1] as the steps finish */
  range: [number, number];
  message: (done: number, total: number) => string;
}

export interface StepRunnerDeps {
  stage: string;
  store: StepStore;
  /** the job's signal, which also fires when the idle timer ends the attempt */
  signal: AbortSignal;
  log: Logger;
  /** called with the stage's progress after each finished step */
  progress: (fraction: number, message: string, detail: StageDetail) => Promise<void>;
  /** the stage idles out after this many ms with no finished step, given the unit limit of the latest step; 0 = never */
  idleMs: (unitTimeoutMs: number) => number;
  /** build the error a timeout throws */
  timeoutError: (info: Omit<StageTimeoutInfo, "stage">) => Error;
  /** the idle timer fired: abort the attempt with this error */
  onIdle: (err: Error) => void;
  /** thrown when a write finds the stage superseded */
  stale: () => Error;
}

const RECENT = 20;

export class StepRunner {
  private recent: number[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  /** Inside `steps()`: finished units feed the idle timer. A direct `step()` does not, so work after it is not timed as a step. */
  private inBatch = false;
  private lastUnitMs = 0;
  private startedAt = Date.now();
  private model = "";
  private doneInPhase = 0;
  private totalInPhase = 0;
  /** set when the idle timer fired */
  idled?: Error;
  /** steps this attempt ran and saved (reused ones do not count): the worker re-queues an attempt that made progress */
  completed = 0;

  constructor(private readonly d: StepRunnerDeps) {}

  private arm() {
    const ms = this.d.idleMs(this.lastUnitMs);
    this.disarm();
    if (ms <= 0 || this.idled) return;
    this.timer = setTimeout(() => {
      const err = this.d.timeoutError({ done: this.doneInPhase, total: this.totalInPhase, model: this.model, unitMs: medianOf(this.recent), kind: "idle", elapsedMs: Date.now() - this.startedAt });
      this.idled = err;
      this.d.onIdle(err);
    }, ms);
    this.timer.unref();
  }

  private disarm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** After a finished unit: inside a batch the next one is expected soon (re-arm); on its own, whatever follows is not a step (disarm). */
  private feedOrStop() {
    if (this.inBatch) this.arm();
    else this.disarm();
  }

  /** Stop the idle timer (the stage ended, or is between batches of steps). */
  stop() {
    this.disarm();
  }

  /** The saved output of this unit when one exists, else run it, save it and return it. */
  async step<T>(name: string, keyInput: StepKeyInput, fn: (signal: AbortSignal) => Promise<T>, o: StepOptions<T>): Promise<T> {
    const parent = o.signal ? AbortSignal.any([this.d.signal, o.signal]) : this.d.signal;
    parent.throwIfAborted();
    this.model = o.model ?? keyInput.model;
    this.lastUnitMs = o.timeoutMs;
    const key = stepKey(keyInput);
    const saved = await this.d.store.read(name, key);
    if (saved?.status === "done") {
      const parsed = o.schema.safeParse(saved.output);
      if (parsed.success) {
        this.d.log.debug({ step: name }, "step reused");
        this.feedOrStop();
        return parsed.data;
      }
      this.d.log.warn({ step: name }, "saved step no longer matches its schema; running it again");
    }
    this.arm();
    const timeout = AbortSignal.timeout(o.timeoutMs);
    const signal = AbortSignal.any([parent, timeout]);
    const t0 = Date.now();
    let out: T;
    try {
      out = await fn(signal);
    } catch (err) {
      const ms = Date.now() - t0;
      // the job was cancelled or superseded, or the idle timer ended the attempt: say so, record nothing
      if (this.idled) throw this.idled;
      if (parent.aborted) throw err;
      const timedOut = timeout.aborted;
      const failure = timedOut ? this.d.timeoutError({ done: this.doneInPhase, total: this.totalInPhase, model: this.model, unitMs: medianOf(this.recent), kind: "unit", elapsedMs: ms }) : err;
      histogram("reelsaw.pipeline.step.duration", ms / 1000, "s", { stage: this.d.stage, outcome: timedOut ? "timeout" : "error" }, "Wall time of one pipeline step, by outcome");
      const ok = await this.d.store.write({ name, key, ...(o.clipId ? { clipId: o.clipId } : {}), status: "failed", lastError: (failure instanceof Error ? failure.message : String(failure)).slice(0, 1000) });
      if (!ok) throw this.d.stale();
      throw failure;
    }
    const ms = Date.now() - t0;
    const ok = await this.d.store.write({ name, key, ...(o.clipId ? { clipId: o.clipId } : {}), status: "done", output: out, ms });
    if (!ok) throw this.d.stale();
    this.recent = [...this.recent, ms].slice(-RECENT);
    this.completed++;
    histogram("reelsaw.pipeline.step.duration", ms / 1000, "s", { stage: this.d.stage, outcome: "ok" }, "Wall time of one pipeline step, by outcome");
    this.feedOrStop();
    return out;
  }

  /**
   * Run `fn` over `items` with bounded concurrency (each call is normally a `ctx.step`), reporting `done/total` and the
   * time left after each. The first failure stops the units still waiting to start and aborts those in flight.
   */
  async steps<I, R>(items: readonly I[], o: StepsOptions, fn: (item: I, index: number, signal: AbortSignal) => Promise<R>): Promise<R[]> {
    const total = items.length;
    this.doneInPhase = 0;
    this.totalInPhase = total;
    if (!total) return [];
    const stop = new AbortController();
    const signal = AbortSignal.any([this.d.signal, stop.signal]);
    this.inBatch = true;
    try {
      return await mapLimit(items, o.concurrency, async (item, i) => {
        signal.throwIfAborted();
        try {
          const r = await fn(item, i, signal);
          this.doneInPhase++;
          const unitMs = medianOf(this.recent);
          const detail: StageDetail = { done: this.doneInPhase, total, etaSec: etaSeconds(total - this.doneInPhase, unitMs, o.concurrency), unitMs: unitMs === null ? null : Math.round(unitMs) };
          await this.d.progress(o.range[0] + (o.range[1] - o.range[0]) * (this.doneInPhase / total), o.message(this.doneInPhase, total), detail).catch(() => {});
          return r;
        } catch (err) {
          stop.abort(err);
          throw err;
        }
      });
    } finally {
      this.inBatch = false;
      this.disarm(); // between batches nothing is expected to finish
    }
  }
}
