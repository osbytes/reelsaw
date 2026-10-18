/**
 * Per-provider concurrency gate: at most N model calls in flight against one provider, across every process.
 *
 * A self-hosted model (Ollama, vLLM, Speaches) is one machine shared by every job of every user; ANALYZE_CONCURRENCY
 * and TRANSCRIBE_CONCURRENCY are per job, so N jobs x M workers all hit it at once and each call slows to a crawl
 * (or times out). The gate caps the provider instead of the job.
 *
 * Two layers:
 *   - in-process: a counting semaphore per provider, so one process never has more than N calls (or N waiting
 *     database connections) for it. On its own this is only a per-process limit: two worker replicas would
 *     allow 2N.
 *   - across processes, once `attach(pool)` has run: N Postgres session advisory locks per provider (slots 0..N-1,
 *     `pg_try_advisory_lock(hashtext('provider:<name>'), slot)`), taken on a dedicated connection held for the
 *     call. A crashed process drops its connection and with it the slot, so nothing leaks. Waiters poll with
 *     backoff (no FIFO across processes; fine for a few slots).
 *
 * Why advisory locks and not a pg-boss queue: model calls are made inside jobs (many per job), not as jobs, and
 * a lock pool needs no schema, no extra worker and no change at the call sites.
 */
import type pg from "pg";
import type { LanguageModelMiddleware } from "ai";
import type { Logger } from "../log.js";

/** Default cap for a self-hosted server; cloud providers are unlimited unless PROVIDER_CONCURRENCY names them. */
export const SELF_HOSTED_DEFAULT = 2;

/** "ollama=2,openai=16" -> { ollama: 2, openai: 16 }. `compat` names the OpenAI-compatible provider whatever it is called. */
export function parseProviderConcurrency(spec: string, compatName: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of spec.split(",")) {
    const m = /^\s*([\w.-]+)\s*=\s*(\d+)\s*$/.exec(part);
    if (!part.trim()) continue;
    if (!m) throw new Error(`PROVIDER_CONCURRENCY: "${part.trim()}" must look like provider=number (e.g. ${compatName}=2,openai=16)`);
    out.set(m[1] === "compat" ? compatName : m[1]!, Number(m[2]));
  }
  return out;
}

export interface ProviderGate {
  /** calls allowed in flight for `provider` now; 0 = unlimited */
  limitOf(provider: string): number;
  /** run `fn` once a slot for `provider` is free */
  run<T>(provider: string, fn: () => PromiseLike<T>, signal?: AbortSignal): Promise<T>;
  /** AI SDK middleware that runs each generate call of a `provider` model through `run` (nothing here streams) */
  middleware(provider: string): LanguageModelMiddleware;
  /** enforce the limits across processes (Postgres advisory locks); until then they are per process */
  attach(pool: pg.Pool): void;
}

class Semaphore {
  active = 0;
  private waiters: Array<() => void> = [];
  async acquire(max: () => number, signal?: AbortSignal): Promise<void> {
    while (this.active >= max()) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => {
        const done = () => {
          signal?.removeEventListener("abort", done);
          resolve();
        };
        this.waiters.push(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    this.active++;
  }
  release() {
    this.active--;
    this.waiters.shift()?.();
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * `isSelfHosted(provider)` is asked at call time (an admin can point a provider at a local server while running).
 * Explicit PROVIDER_CONCURRENCY entries win; otherwise self-hosted = SELF_HOSTED_DEFAULT, cloud = unlimited.
 */
export function createProviderGate(spec: string, compatName: string, isSelfHosted: (provider: string) => boolean, log: Logger): ProviderGate {
  const explicit = parseProviderConcurrency(spec, compatName);
  const sems = new Map<string, Semaphore>();
  let pool: pg.Pool | null = null;
  const limitOf = (provider: string) => explicit.get(provider) ?? (isSelfHosted(provider) ? SELF_HOSTED_DEFAULT : 0);

  async function run<T>(provider: string, fn: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    if (limitOf(provider) <= 0) return await fn();
    let sem = sems.get(provider);
    if (!sem) sems.set(provider, (sem = new Semaphore()));
    await sem.acquire(() => Math.max(1, limitOf(provider)), signal);
    try {
      if (!pool) return await fn();
      const client = await pool.connect();
      const key = `provider:${provider}`;
      let slot = -1;
      let broken: Error | undefined;
      try {
        const started = Date.now();
        let logged = false;
        for (let wait = 200; ; wait = Math.min(wait * 1.5, 2000)) {
          const n = Math.max(1, limitOf(provider));
          for (let i = 0; i < n && slot < 0; i++) {
            const r = await client.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1), $2) as ok", [key, i]);
            if (r.rows[0]?.ok) slot = i;
          }
          if (slot >= 0) break;
          signal?.throwIfAborted();
          if (!logged && Date.now() - started > 5000) {
            logged = true;
            log.debug({ provider, limit: n }, "waiting for a provider slot");
          }
          await sleep(wait + Math.random() * 100, signal);
        }
        return await fn();
      } finally {
        if (slot >= 0) await client.query("select pg_advisory_unlock(hashtext($1), $2)", [key, slot]).catch((err: Error) => (broken = err));
        // a connection whose unlock failed is closed, which frees the slot
        client.release(broken);
      }
    } finally {
      sem.release();
    }
  }

  return {
    limitOf,
    run,
    middleware: (provider) => ({
      wrapGenerate: ({ doGenerate, params }) => run(provider, doGenerate, params.abortSignal),
    }),
    attach(p) {
      pool = p;
    },
  };
}
