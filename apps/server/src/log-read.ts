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
  since?: Date;
  /** drop lines below this level (`debug`, `warn`, ...) */
  minLevel?: keyof typeof LEVEL_NUM;
  /** keep one module's lines (`render`, `http`, ...) */
  module?: string;
  /** keep at most this many (the newest) */
  limit?: number;
}

/** The rotated files that belong to LOG_FILE, oldest first. */
export async function logFiles(file: string): Promise<string[]> {
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/\.log$/, "");
  return (await fsp.readdir(dir).catch(() => [] as string[]))
    .filter((f) => f.startsWith(base))
    .sort()
    .map((f) => path.join(dir, f));
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
  const hits: string[] = [];
  for (const f of files) {
    const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: "utf8" }), crlfDelay: Infinity });
    try {
      for await (const line of rl) if (line && lineMatches(line, q)) hits.push(line);
    } catch {
      /* a file rotated away mid-read */
    }
    if (q.limit && hits.length > q.limit * 2) hits.splice(0, hits.length - q.limit);
  }
  return { lines: q.limit ? hits.slice(-q.limit) : hits, files };
}
