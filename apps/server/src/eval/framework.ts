/**
 * Eval / regression framework.
 *
 *  - A suite is a named set of cases (`Suite.run` returns one `CaseResult` per case) plus summary
 *    metrics (`Suite.summarize`). Suites register in `suites/index.ts`.
 *  - Fixtures live in `eval/fixtures/<suite>/…` (case.json + small media, in git). Large media is
 *    referenced by URL + time range and materialised into `eval/.cache/media` by `materialize`.
 *  - Expensive calls (ASR, models) go through `ctx.cached(key, fn)`: JSON results keyed by a hash of
 *    their inputs under `eval/.cache/calls`, so reruns are fast and deterministic.
 *  - Baselines (`eval/baselines/<suite>.json`, in git) record which cases passed and the summary
 *    metrics; a run fails when a baseline-passing case fails or a metric gets worse than its tolerance.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import type { AiService } from "../ai/registry.js";
import type { Meter } from "./meter.js";

export type Need = "models" | "network" | "media";

export interface CaseResult {
  id: string;
  pass: boolean;
  /** set when the case could not run (missing media/model); skipped cases never count as regressions */
  skipped?: string;
  metrics?: Record<string, number | string | boolean>;
  notes?: string;
}

export interface SummaryMetric {
  value: number;
  /** which direction is better */
  better: "higher" | "lower";
  /** allowed drift before it counts as a regression (absolute) */
  tolerance?: number;
}

export interface Suite {
  name: string;
  description: string;
  /** what the suite needs at run time; `--offline` skips suites that need models or network */
  needs: Need[];
  run(ctx: EvalContext): Promise<CaseResult[]>;
  summarize?(results: CaseResult[]): Record<string, SummaryMetric>;
}

export interface EvalContext {
  /** eval/ directory (fixtures, baselines, reports, .cache) */
  root: string;
  fixtures(suite: string): string;
  cacheDir: string;
  offline: boolean;
  verbose: boolean;
  /** extra `--key value` args for suites, e.g. `--transcription-models a,b` */
  opt(name: string): string | undefined;
  /**
   * Which configuration this run uses: "default" is the repo .env; a matrix run (`--matrix`,
   * `--set`) names one profile per pass. Only "default" is compared with the baselines.
   */
  profile: string;
  /** the configuration of this profile (the .env with the profile's overrides applied) */
  config(): Config;
  /** models for this profile; language models come back metered (see meter.ts) */
  ai: AiService;
  meter: Meter;
  log: Logger;
  cached<T>(key: unknown, fn: () => Promise<T>): Promise<T>;
  /** run a command, return stdout; throws with stderr tail on failure */
  exec(cmd: string, args: string[]): Promise<Buffer>;
}

export function hashOf(value: unknown): string {
  const h = crypto.createHash("sha256");
  const feed = (v: unknown) => {
    if (v instanceof Uint8Array) h.update(v);
    else h.update(JSON.stringify(v, (_k, x) => (x instanceof Uint8Array || Buffer.isBuffer(x) ? `bytes:${crypto.createHash("sha256").update(x).digest("hex")}` : x)));
  };
  if (Array.isArray(value)) value.forEach(feed);
  else feed(value);
  return h.digest("hex").slice(0, 32);
}

export function exec(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    let err = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${path.basename(cmd)} exited ${code}: ${err.slice(-400)}`))));
  });
}

/** `readThrough: false` (--no-cache) always calls `fn` but still stores the result, for timing runs. */
export function makeCache(dir: string, readThrough = true) {
  return async <T>(key: unknown, fn: () => Promise<T>): Promise<T> => {
    const file = path.join(dir, "calls", `${hashOf(key)}.json`);
    if (readThrough) {
      try {
        return JSON.parse(await fs.readFile(file, "utf8")) as T;
      } catch {
        /* miss */
      }
    }
    const value = await fn();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value));
    return value;
  };
}

/** Locate eval/: EVAL_DIR, or walk up from cwd and from this file looking for eval/fixtures. */
export function findEvalRoot(): string {
  if (process.env.EVAL_DIR) return path.resolve(process.env.EVAL_DIR);
  const starts = [process.cwd(), path.dirname(new URL(import.meta.url).pathname)];
  for (const start of starts) {
    let d = start;
    for (let i = 0; i < 8; i++) {
      if (existsSync(path.join(d, "eval", "fixtures"))) return path.join(d, "eval");
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  }
  throw new Error("cannot find eval/fixtures; run from the repo or set EVAL_DIR (in the container: docker compose cp eval app:/data/eval && EVAL_DIR=/data/eval)");
}

// ---------- media ----------

/** A slice of a long source video that a fixture needs but that is too big for git. */
export interface MediaSource {
  /** cache key; also the file name under .cache/media */
  id: string;
  url: string;
  start: number;
  end: number;
  /** sha256 of the materialised file when the fixture was made (informational: encoders differ) */
  sha256?: string;
  /** optional local copy of the full source (e.g. inside the app container) */
  localPath?: string;
}

/**
 * Make `source` available as a local mp4 under .cache/media. Order: cached file → `localPath`
 * (ffmpeg stream copy of the range) → yt-dlp `--download-sections`. Throws a clear error when none
 * works, so suites can mark cases skipped.
 */
export async function materialize(ctx: EvalContext, source: MediaSource): Promise<string> {
  // v2: sections are cut frame-accurately (v1 stream-copied from a local file, which starts at the
  // previous keyframe and shifted every section-relative label by up to a few seconds)
  const out = path.join(ctx.cacheDir, "media", `${source.id}.v2.mp4`);
  if (existsSync(out)) return out;
  await fs.mkdir(path.dirname(out), { recursive: true });
  const cfg = ctx.config();
  const dur = (source.end - source.start).toFixed(3);
  const tmp = `${out}.part.mp4`;
  if (source.localPath && existsSync(source.localPath)) {
    await exec(cfg.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(source.start), "-i", source.localPath, "-t", dur, "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-c:a", "aac", "-b:a", "160k", tmp]);
  } else {
    if (ctx.offline) throw new Error(`media ${source.id} not cached and --offline is set`);
    try {
      await exec(cfg.YTDLP_PATH, ["--version"]);
    } catch {
      throw new Error(`media ${source.id} not cached and yt-dlp is not available (set YTDLP_PATH, or run in the app container)`);
    }
    await exec(cfg.YTDLP_PATH, ["-q", "--no-warnings", "-f", "bv*[height<=1080][vcodec^=avc1]+ba/b[height<=1080]/b", "--download-sections", `*${source.start}-${source.end}`, "--force-keyframes-at-cuts", "--merge-output-format", "mp4", "-o", tmp, source.url]);
  }
  await fs.rename(tmp, out);
  const sha = crypto.createHash("sha256").update(await fs.readFile(out)).digest("hex");
  if (source.sha256 && source.sha256 !== sha) ctx.log.warn({ media: source.id }, "materialised media differs from the fixture's recorded sha256 (encoder/version drift); results may shift slightly");
  return out;
}

// ---------- baselines ----------

export interface Baseline {
  updatedAt: string;
  cases: Record<string, boolean>;
  metrics: Record<string, SummaryMetric>;
}

export interface Comparison {
  regressions: string[];
  improvements: string[];
}

export function compare(baseline: Baseline | null, results: CaseResult[], metrics: Record<string, SummaryMetric>): Comparison {
  const regressions: string[] = [];
  const improvements: string[] = [];
  if (!baseline) return { regressions, improvements };
  for (const r of results) {
    if (r.skipped) continue;
    const was = baseline.cases[r.id];
    if (was === true && !r.pass) regressions.push(`case ${r.id} passed before, fails now`);
    if (was === false && r.pass) improvements.push(`case ${r.id} now passes`);
  }
  for (const [name, m] of Object.entries(metrics)) {
    const b = baseline.metrics[name];
    if (!b || !Number.isFinite(m.value)) continue;
    const tol = b.tolerance ?? m.tolerance ?? 0;
    const worse = m.better === "higher" ? m.value < b.value - tol : m.value > b.value + tol;
    const better = m.better === "higher" ? m.value > b.value + tol : m.value < b.value - tol;
    if (worse) regressions.push(`${name} ${fmt(b.value)} → ${fmt(m.value)} (${m.better} is better, tolerance ${fmt(tol)})`);
    else if (better) improvements.push(`${name} ${fmt(b.value)} → ${fmt(m.value)}`);
  }
  return { regressions, improvements };
}

export const fmt = (v: unknown) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(3)) : String(v));

/** Fraction of box `a` covered by box `b` (normalized [x1,y1,x2,y2]). */
export function coverage(a: [number, number, number, number], b: [number, number, number, number]) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = (a[2] - a[0]) * (a[3] - a[1]);
  return area > 0 ? (ix * iy) / area : 0;
}

export function iou(a: [number, number, number, number], b: [number, number, number, number]) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return u > 0 ? inter / u : 0;
}

/** True for "the model/server isn't there" errors (including billing/quota refusals), which make a case skipped rather than failed. */
export function isUnavailable(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err);
  return /Cannot connect to API|ECONNREFUSED|ENOTFOUND|fetch failed|EAI_AGAIN|socket hang up|model .* not found|requires a valid credit card|insufficient[_ ]quota|insufficient credits|needs [A-Z_]+ (or [A-Z_]+ )?to be set/i.test(m);
}
