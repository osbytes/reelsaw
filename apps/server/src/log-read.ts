/**
 * Read back the rotated LOG_FILE: lines about a project/clip/job/request id, newest last. Used by
 * `reelsaw logs` and by the issue-report bundle, so both see the same thing.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

/** pino numeric levels */
export const LEVEL_NUM = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export const LEVEL_LABEL: Record<number, string> = { 10: "TRC", 20: "DBG", 30: "INF", 40: "WRN", 50: "ERR", 60: "FTL" };

export interface LogQuery {
  /** keep lines mentioning any of these (project, clip, job, request ids) */
  ids?: string[];
  /** drop lines older than this */
  since?: Date | undefined;
  /** drop lines below this level (`debug`, `warn`, ...) */
  minLevel?: keyof typeof LEVEL_NUM | undefined;
  /** keep one module's lines (`render`, `http`, ...) */
  module?: string | undefined;
  /** keep at most this many (the newest) */
  limit?: number;
}

/**
 * LOG_FILE with the process's id before the extension: `/data/logs/reelsaw.log` becomes
 * `/data/logs/reelsaw.<id>.log`. The app and every scaled worker share the directory, and each
 * pino-roll rotates (and prunes) only its own files; without the id they pruned each other's.
 * `id` is the worker id (`WORKER_ID`, or `hostname:pid`), reduced to `[A-Za-z0-9._-]`.
 */
export function logFileFor(file: string, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_") || "proc";
  const ext = path.extname(file);
  return ext ? `${file.slice(0, -ext.length)}.${safe}${ext}` : `${file}.${safe}`;
}

function isLogFileOf(stem: string, name: string): boolean {
  return name.startsWith(`${stem}.`) && name.includes(".log");
}

/** The files written under LOG_FILE (`reelsaw.*.log*`: every process and rotation), in name order. */
export async function logFiles(file: string): Promise<string[]> {
  const dir = path.dirname(file);
  const stem = path.basename(file, path.extname(file));
  return (await fsp.readdir(dir).catch(() => [] as string[]))
    .filter((f) => isLogFileOf(stem, f))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * Delete log files nobody has written to for `days`. A restarted container gets a new hostname:pid
 * and so a new set of files that no running pino-roll would ever prune.
 */
export function pruneOldLogs(file: string, days: number): void {
  try {
    const dir = path.dirname(file);
    const stem = path.basename(file, path.extname(file));
    const cutoff = Date.now() - days * 86400_000;
    for (const f of fs.readdirSync(dir)) {
      if (!isLogFileOf(stem, f)) continue;
      const p = path.join(dir, f);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    }
  } catch {
    /* no directory yet, or a file raced away: logging must not fail over housekeeping */
  }
}

/** Milliseconds of a raw JSON line's `time` (0 when it has none, so a stack trace stays near its neighbours). */
function timeOf(line: string): number {
  const m = /"time":"([^"]+)"/.exec(line);
  const t = m ? Date.parse(m[1]!) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** True when a raw JSON line passes the query's time/level/module filters (ids are checked on the raw text first). */
export function lineMatches(line: string, q: LogQuery): boolean {
  if (q.ids?.length && !q.ids.some((id) => line.includes(id))) return false;
  if (!q.since && !q.minLevel && !q.module) return true;
  try {
    const d = JSON.parse(line) as { time?: string; level?: number; module?: string };
    if (q.minLevel && (d.level ?? 0) < LEVEL_NUM[q.minLevel]) return false;
    if (q.module && d.module !== q.module) return false;
    if (q.since && d.time && Date.parse(d.time) < q.since.getTime()) return false;
    return true;
  } catch {
    return !q.minLevel && !q.module; // an unparseable line (a stack, a crash) is kept unless filtering by level/module
  }
}

export async function readLogLines(file: string, q: LogQuery): Promise<{ lines: string[]; files: string[] }> {
  const files = await logFiles(file);
  // every process writes its own files; merge them by timestamp (stable: file order, then line order)
  const merged: Array<{ t: number; i: number; line: string }> = [];
  for (const f of files) {
    let hits: string[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line || !lineMatches(line, q)) continue;
        hits.push(line);
        // lines inside one file are in time order, so only its newest `limit` can make the cut
        if (q.limit && hits.length > q.limit * 2) hits = hits.slice(-q.limit);
      }
    } catch {
      /* a file rotated away mid-read */
    }
    if (q.limit) hits = hits.slice(-q.limit);
    // a line without a time (a stack, a crash) takes the time of the line before it
    let last = 0;
    for (const line of hits) {
      const t = timeOf(line) || last;
      last = t;
      merged.push({ t, i: merged.length, line });
    }
  }
  merged.sort((a, b) => a.t - b.t || a.i - b.i);
  const lines = merged.map((m) => m.line);
  return { lines: q.limit ? lines.slice(-q.limit) : lines, files };
}
