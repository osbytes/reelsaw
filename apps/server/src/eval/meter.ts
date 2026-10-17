/**
 * Call metering for evals: latency, tokens, cost and failures of every model call a suite makes,
 * so a run reports speed and price next to quality. Language models are wrapped with AI SDK
 * middleware (every generateText call is seen, no call-site changes); transcription is recorded
 * by `transcribeCached`. Calls served from the eval cache never reach the meter, so a cached rerun
 * shows 0 calls rather than fake latencies; use `--no-cache` for timing runs.
 */
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from "ai";

export type CallKind = "llm" | "stt";

export interface MeteredCall {
  kind: CallKind;
  model: string;
  ms: number;
  ok: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** USD, when the provider reports it (AI Gateway does in providerMetadata.gateway.cost) */
  costUsd?: number;
  /** seconds of audio transcribed (stt) */
  audioSec?: number;
  /** output could not be parsed into the requested schema (counted by the caller) */
  error?: string;
}

export interface MeterSummary {
  calls: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  /** undefined when no call reported a price */
  costUsd?: number;
  /** audio seconds per wall second across stt calls (higher is faster) */
  sttRealtimeFactor?: number;
}

export interface Meter {
  record(call: MeteredCall): void;
  /** calls since `mark()` */
  calls(): MeteredCall[];
  mark(): void;
  summary(kind?: CallKind): MeterSummary;
}

export function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

export function summarize(calls: MeteredCall[]): MeterSummary {
  const ms = calls.map((c) => c.ms).sort((a, b) => a - b);
  const priced = calls.filter((c) => typeof c.costUsd === "number");
  const stt = calls.filter((c) => c.kind === "stt" && c.ok && c.audioSec);
  const sttWall = stt.reduce((a, c) => a + c.ms, 0) / 1000;
  const sttAudio = stt.reduce((a, c) => a + (c.audioSec ?? 0), 0);
  return {
    calls: calls.length,
    errors: calls.filter((c) => !c.ok).length,
    p50Ms: percentile(ms, 50),
    p95Ms: percentile(ms, 95),
    totalMs: ms.reduce((a, b) => a + b, 0),
    inputTokens: calls.reduce((a, c) => a + (c.inputTokens ?? 0), 0),
    outputTokens: calls.reduce((a, c) => a + (c.outputTokens ?? 0), 0),
    ...(priced.length ? { costUsd: Number(priced.reduce((a, c) => a + c.costUsd!, 0).toFixed(6)) } : {}),
    ...(stt.length && sttWall > 0 ? { sttRealtimeFactor: Number((sttAudio / sttWall).toFixed(1)) } : {}),
  };
}

export function createMeter(): Meter {
  const all: MeteredCall[] = [];
  let from = 0;
  return {
    record: (c) => void all.push(c),
    calls: () => all.slice(from),
    mark: () => void (from = all.length),
    summary: (kind) => summarize(all.slice(from).filter((c) => !kind || c.kind === kind)),
  };
}

/** Cost reported by the provider, if any. AI Gateway: providerMetadata.gateway.cost (USD string). */
export function reportedCost(providerMetadata: unknown): number | undefined {
  const gw = (providerMetadata as { gateway?: { cost?: unknown } } | undefined)?.gateway;
  const raw = gw?.cost;
  const n = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Wrap a language model so every generate call is recorded in `meter`. */
export function meteredModel(meter: Meter, model: LanguageModel): LanguageModel {
  const middleware: LanguageModelMiddleware = {
    wrapGenerate: async ({ doGenerate, model: m }) => {
      const t0 = Date.now();
      try {
        const res = await doGenerate();
        meter.record({
          kind: "llm",
          model: `${m.provider}:${m.modelId}`,
          ms: Date.now() - t0,
          ok: true,
          inputTokens: res.usage.inputTokens.total ?? 0,
          outputTokens: res.usage.outputTokens.total ?? 0,
          costUsd: reportedCost(res.providerMetadata),
        });
        return res;
      } catch (err) {
        meter.record({ kind: "llm", model: `${m.provider}:${m.modelId}`, ms: Date.now() - t0, ok: false, error: (err as Error).message?.slice(0, 200) });
        throw err;
      }
    },
  };
  return wrapLanguageModel({ model: model as Parameters<typeof wrapLanguageModel>[0]["model"], middleware }) as LanguageModel;
}
