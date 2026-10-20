/**
 * Pool of yt-dlp egress candidates (a home Pi, a cheap VPS, a paid residential proxy, or this
 * server's own IP).
 *
 * Two independent knobs — they are never multiplied into one score:
 *
 *   - **priority** (the operator, HAProxy `backup` / Envoy priority levels): which candidate to
 *     prefer. Higher is tried first. It never changes at runtime. A more reliable expensive proxy
 *     cannot overtake a cheaper one that is still healthy.
 *   - **reliability** (runtime, Polly circuit breaker): consecutive proxy faults open the circuit
 *     so that candidate is skipped while it cools, then the operator ranking applies again among
 *     whoever is closed. Implemented with [cockatiel](https://github.com/connor4312/cockatiel)
 *     (`ConsecutiveBreaker` + `bulkhead`), not a custom cooldown.
 *
 * yt-dlp itself takes one `--proxy` and will not rotate ([yt-dlp#10718](https://github.com/yt-dlp/yt-dlp/issues/10718)).
 * Dedicated "proxy pool" packages tend to rank by success rate, which would burn the paid proxy
 * whenever the Pi blips — the opposite of the COGS goal.
 *
 * Spec (`YTDLP_PROXY`, one URL or a comma- / newline-separated pool):
 *   `[id=]<url-or-direct>[;priority=N][;concurrency=N]`
 * A bare URL is still one candidate (priority 100). `direct` = no `--proxy` (this server's IP).
 * `socks5h` resolves DNS on the proxy, which is what you want when the exit is a home IP.
 * URLs never appear in logs; only `id`.
 */
import {
  BrokenCircuitError,
  CircuitState,
  ConsecutiveBreaker,
  ExponentialBackoff,
  bulkhead,
  circuitBreaker,
  handleWhen,
  isBrokenCircuitError,
  isBulkheadRejectedError,
  isTaskCancelledError,
  type BulkheadPolicy,
  type CircuitBreakerPolicy,
} from "cockatiel";
import type { Logger } from "./log.js";

const SCHEMES = new Set(["http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:"]);
const NEVER_ABORT = new AbortController().signal;
const ATTR = /;(priority|concurrency)=(-?\d+)\s*$/i;
const NAMED_DIRECT = /^(?:([\w.-]+)=)?direct$/i;
const NAMED_URL = /^([\w.-]+)=(https?|socks5h?|socks4a?):\/\//i;

export const PROXY_FAULTS_BEFORE_OPEN = 2;
export const PROXY_COOLDOWN_CAP_MS = 15 * 60 * 1000;
export const PROXY_RESULT_WINDOW = 20;

export interface ProxyCandidate {
  id: string;
  /** null = direct (no --proxy) */
  url: string | null;
  /** operator preference; higher is tried first among currently-healthy candidates */
  priority: number;
  /** max in-flight downloads through this candidate; 0 = unlimited */
  concurrency: number;
}

export type ProxyCircuit = "closed" | "open" | "halfOpen" | "isolated";

export interface ProxySnapshot {
  id: string;
  /** hostname only, never userinfo */
  host: string;
  priority: number;
  concurrency: number;
  inFlight: number;
  /** false while the circuit is open (cooling after consecutive faults) */
  healthy: boolean;
  circuit: ProxyCircuit;
  successes: number;
  faults: number;
  /** last-N successes / (successes+faults); display only, not used to rank */
  successRate: number | null;
}

export interface YtdlpProxyPool {
  readonly size: number;
  snapshot(): { next: string | null; candidates: ProxySnapshot[] };
  /**
   * Run `fn` through the highest-priority healthy candidate, then the next, and so on.
   * Proxy faults cool that candidate and continue; content errors and abort stop the walk.
   */
  run<T>(fn: (choice: { id: string; args: string[] }, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<{ value: T; id: string }>;
}

/** Hostname for logs and the CLI; never the URL (it may carry a password). */
export function proxyHost(url: string | null): string {
  if (!url) return "direct";
  try {
    return new URL(url).host || "proxy";
  } catch {
    return "proxy";
  }
}

export function parseYtdlpProxies(spec: string): ProxyCandidate[] {
  const out: ProxyCandidate[] = [];
  const seenId = new Set<string>();
  const seenUrl = new Set<string>();
  for (const raw of spec.split(/[,\n]/)) {
    const part = raw.trim();
    if (!part) continue;
    const c = parseEntry(part);
    if (seenId.has(c.id)) throw new Error(`YTDLP_PROXY: duplicate id "${c.id}"`);
    const urlKey = c.url ?? "direct";
    if (seenUrl.has(urlKey)) throw new Error(`YTDLP_PROXY: duplicate URL for "${c.id}"`);
    seenId.add(c.id);
    seenUrl.add(urlKey);
    out.push(c);
  }
  return out;
}

function parseEntry(part: string): ProxyCandidate {
  let rest = part;
  let priority = 100;
  let concurrency = 0;
  for (;;) {
    const m = ATTR.exec(rest);
    if (!m) break;
    const key = m[1]!.toLowerCase();
    const n = Number(m[2]);
    if (!Number.isInteger(n) || (key === "concurrency" && n < 0)) {
      throw new Error(`YTDLP_PROXY: "${mask(part)}" has a bad ${key} (integer${key === "concurrency" ? " ≥ 0" : ""})`);
    }
    if (key === "priority") priority = n;
    else concurrency = n;
    rest = rest.slice(0, m.index).trim();
  }
  const direct = NAMED_DIRECT.exec(rest);
  if (direct) return { id: direct[1] ?? "direct", url: null, priority, concurrency };
  let id: string;
  let url: string;
  const named = NAMED_URL.exec(rest);
  if (named) {
    id = named[1]!;
    url = rest.slice(named[1]!.length + 1);
  } else {
    url = rest;
    id = idFromUrl(url);
  }
  return { id, url: parseProxyUrl(url, part), priority, concurrency };
}

function parseProxyUrl(url: string, part: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`YTDLP_PROXY: "${mask(part)}" is not a proxy URL (http, https, socks4, socks4a, socks5, socks5h) or "direct"`);
  }
  if (!SCHEMES.has(parsed.protocol) || !parsed.hostname) {
    throw new Error(`YTDLP_PROXY: "${mask(part)}" is not a proxy URL (http, https, socks4, socks4a, socks5, socks5h) or "direct"`);
  }
  return url;
}

function idFromUrl(url: string): string {
  const host = proxyHost(url);
  const id = host.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) throw new Error(`YTDLP_PROXY: could not derive an id from "${mask(url)}"; write id=url`);
  return id;
}

/** Drop userinfo so a parse error cannot echo a password. */
function mask(s: string): string {
  return s.replace(/\/\/([^/?#]*@)/g, "//");
}

export type YtdlpErrorKind = "content" | "abort" | "proxy" | "other";

/**
 * content = the video, not the path (private / unavailable / too big): do not try another proxy
 * and do not open this one's circuit. abort = the job was cancelled. proxy = the path failed
 * (bot check, 403, connection): trip the breaker and try the next. other = retry the next
 * without a reliability hit.
 */
export function classifyYtdlpError(text: string): YtdlpErrorKind {
  if (/\bAbortError\b|The operation was aborted|aborted by signal/i.test(text)) return "abort";
  if (/this video is private|video unavailable|confirm your age|age-restricted|file is larger than max-filesize|requested format is not available/i.test(text)) return "content";
  if (/sign in to confirm|not a bot|HTTP Error 403|HTTP Error 429|unable to connect to proxy|\bproxy\b|\bsocks\b|connection (refused|reset|timed out)|timed out|timeout|network is unreachable|no route to host|temporary failure in name resolution|nodename nor servname|ssl|tls handshake/i.test(text)) {
    return "proxy";
  }
  return "other";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function circuitOf(state: CircuitState): ProxyCircuit {
  switch (state) {
    case CircuitState.Closed:
      return "closed";
    case CircuitState.Open:
      return "open";
    case CircuitState.HalfOpen:
      return "halfOpen";
    default:
      return "isolated";
  }
}

interface Slot {
  candidate: ProxyCandidate;
  breaker: CircuitBreakerPolicy;
  bulkhead: BulkheadPolicy | null;
  results: boolean[];
}

const proxyFaults = handleWhen((err) => classifyYtdlpError(err.message) === "proxy");

export function createYtdlpProxyPool(
  candidates: ProxyCandidate[],
  opts: { halfOpenAfter?: number; faultsBeforeOpen?: number; slotWaitMs?: number; log?: Logger } = {},
): YtdlpProxyPool {
  const halfOpenAfter = opts.halfOpenAfter ?? new ExponentialBackoff({ initialDelay: 30_000, maxDelay: PROXY_COOLDOWN_CAP_MS });
  const faultsBeforeOpen = opts.faultsBeforeOpen ?? PROXY_FAULTS_BEFORE_OPEN;
  const slotWaitMs = opts.slotWaitMs ?? 50;
  const log = opts.log;

  const slots: Slot[] = candidates.map((candidate) => {
    const breaker = circuitBreaker(proxyFaults, {
      halfOpenAfter,
      breaker: new ConsecutiveBreaker(faultsBeforeOpen),
    });
    const bulkheadPolicy = candidate.concurrency > 0 ? bulkhead(candidate.concurrency, 0) : null;
    const slot: Slot = { candidate, breaker, bulkhead: bulkheadPolicy, results: [] };
    breaker.onSuccess(() => remember(slot, true));
    breaker.onFailure((ev) => {
      if (ev.handled) remember(slot, false);
    });
    return slot;
  });

  const healthy = (s: Slot) => s.breaker.state === CircuitState.Closed || s.breaker.state === CircuitState.HalfOpen;
  const hasSlot = (s: Slot) => !s.bulkhead || s.bulkhead.executionSlots > 0;
  const rank = (a: Slot, b: Slot) => b.candidate.priority - a.candidate.priority || a.candidate.id.localeCompare(b.candidate.id);

  /** Operator ranking only. An open circuit is a fail-fast skip inside `execute`, not a re-rank. */
  function ordered(exclude: ReadonlySet<string>): Slot[] {
    return slots.filter((s) => !exclude.has(s.candidate.id) && hasSlot(s)).sort(rank);
  }

  function snapOf(s: Slot): ProxySnapshot {
    const faults = s.results.filter((ok) => !ok).length;
    const successes = s.results.filter((ok) => ok).length;
    return {
      id: s.candidate.id,
      host: proxyHost(s.candidate.url),
      priority: s.candidate.priority,
      concurrency: s.candidate.concurrency,
      inFlight: s.bulkhead ? s.candidate.concurrency - s.bulkhead.executionSlots : 0,
      healthy: healthy(s),
      circuit: circuitOf(s.breaker.state),
      successes,
      faults,
      successRate: s.results.length ? successes / s.results.length : null,
    };
  }

  return {
    size: slots.length,
    snapshot() {
      const walk = ordered(new Set());
      const next = walk.find(healthy) ?? walk[0];
      return { next: next?.candidate.id ?? null, candidates: slots.map(snapOf) };
    },
    async run(fn, signal) {
      const exclude = new Set<string>();
      let lastErr: unknown;
      let usedFallback = false;
      for (;;) {
        signal?.throwIfAborted();
        const walk = ordered(exclude);
        if (!walk.length) {
          const busy = slots.some((s) => !exclude.has(s.candidate.id) && !hasSlot(s));
          if (busy) {
            await sleep(slotWaitMs, signal);
            continue;
          }
          if (lastErr !== undefined) throw lastErr;
          throw new Error("YTDLP_PROXY: no candidate available");
        }
        let skippedBusy = false;
        for (const slot of walk) {
          signal?.throwIfAborted();
          const id = slot.candidate.id;
          const args = slot.candidate.url ? ["--proxy", slot.candidate.url] : [];
          try {
            const value = await slot.breaker.execute(async (ctx) => {
              if (slot.bulkhead) return slot.bulkhead.execute(() => fn({ id, args }, ctx.signal), ctx.signal);
              return fn({ id, args }, ctx.signal);
            }, signal);
            if (usedFallback) log?.warn({ proxyId: id, skipped: [...exclude] }, "yt-dlp proxy fallback");
            else log?.debug({ proxyId: id }, "yt-dlp proxy ok");
            return { value, id };
          } catch (err) {
            if (isTaskCancelledError(err) || signal?.aborted) throw err;
            if (isBulkheadRejectedError(err)) {
              skippedBusy = true;
              continue;
            }
            if (isBrokenCircuitError(err)) {
              // still cooling: try the next-priority candidate rather than wait
              continue;
            }
            lastErr = err;
            const kind = classifyYtdlpError(errorText(err));
            if (kind === "content" || kind === "abort") throw err;
            exclude.add(id);
            usedFallback = true;
            log?.warn({ proxyId: id, kind }, "yt-dlp proxy failed, trying next");
          }
        }
        if (skippedBusy) {
          await sleep(slotWaitMs, signal);
          continue;
        }
        // every remaining circuit is open and halfOpenAfter has not elapsed: last resort, bypass
        // the breaker on the highest-priority candidate so a download is not stuck until cooldown
        const panic = [...slots].filter((s) => !exclude.has(s.candidate.id)).sort(rank)[0];
        if (panic && lastErr === undefined) {
          const id = panic.candidate.id;
          const args = panic.candidate.url ? ["--proxy", panic.candidate.url] : [];
          log?.warn({ proxyId: id }, "yt-dlp proxy all cooling, trying anyway");
          try {
            const value = await fn({ id, args }, signal ?? NEVER_ABORT);
            return { value, id };
          } catch (err) {
            lastErr = err;
            const kind = classifyYtdlpError(errorText(err));
            if (kind === "content" || kind === "abort") throw err;
            exclude.add(id);
            continue;
          }
        }
        if (lastErr !== undefined) throw lastErr;
        throw new BrokenCircuitError();
      }
    },
  };
}

function remember(slot: Slot, ok: boolean) {
  slot.results.push(ok);
  if (slot.results.length > PROXY_RESULT_WINDOW) slot.results.shift();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
