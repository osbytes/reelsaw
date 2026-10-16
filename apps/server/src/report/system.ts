/**
 * Instance context for issue reports: versions, machine resources, on-device models, queue state,
 * usage and recent errors. Self-hosted installs have no crash reporting service, so the instance's
 * own logs and job table are the error history; they are read on demand and redacted.
 */
import path from "node:path";
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "drizzle-orm";
import type { Services } from "../services.js";

const run = promisify(execFile);
const MAX_ERROR_LINES = 2000;
const ERROR_WINDOW_DAYS = 7;

async function toolVersion(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 5000 });
    return stdout.split("\n")[0]!.trim().slice(0, 200);
  } catch {
    return "unavailable";
  }
}

export async function systemInfo(svc: Services) {
  const c = svc.config;
  return {
    app: { version: c.REELSAW_VERSION, commit: c.REELSAW_COMMIT, builtAt: c.REELSAW_BUILT_AT },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, uptimeSec: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1048576) },
    resources: await svc.resources.snapshot().catch(() => null),
    tools: { ffmpeg: await toolVersion(c.FFMPEG_PATH, ["-version"]), ytDlp: await toolVersion("yt-dlp", ["--version"]) },
    onDevice: { faces: !!svc.faces, text: !!svc.text, vad: !!svc.vad, aligner: !!svc.aligner },
    storage: svc.storage.driver,
    roles: { http: c.RUN_HTTP, workers: c.RUN_WORKERS },
  };
}

/** Job counts per queue/state and the most recent failures (output redacted by the caller). */
export async function queueInfo(svc: Services, projectIds: string[]) {
  const db = svc.database.db;
  try {
    const counts = await db.execute(sql`select name, state, count(*)::int as n from pgboss.job group by 1, 2 order by 1, 2`);
    const failed = projectIds.length
      ? await db.execute(sql`select name, state, retry_count as retries, data, output, created_on, completed_on from pgboss.job
          where state = 'failed' and data->>'projectId' in (${sql.join(projectIds.map((id) => sql`${id}`), sql`, `)})
          order by completed_on desc nulls last limit 50`)
      : { rows: [] };
    return { counts: counts.rows, recentFailures: failed.rows };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function usageInfo(svc: Services, userId: string) {
  const db = svc.database.db;
  const projects = await db.execute(sql`select status, count(*)::int as n from projects where user_id = ${userId} group by 1`);
  const clips = await db.execute(sql`select c.status, count(*)::int as n,
      percentile_cont(0.5) within group (order by (c.diagnostics->>'renderMs')::float) as median_render_ms,
      percentile_cont(0.9) within group (order by (c.diagnostics->>'renderMs')::float) as p90_render_ms
    from clips c join projects p on p.id = c.project_id where p.user_id = ${userId} group by 1`);
  return { projects: projects.rows, clips: clips.rows };
}

/**
 * Error/fatal log lines from the last week, instance-wide, allow-listed: a line that names a
 * project, clip or job is kept only when it belongs to the requesting user; a line that names none
 * is reduced to time, level, message, module and error type/message (no stack, no other fields), so
 * another user's content (including from projects since deleted) can't ride along.
 */
export async function recentErrors(svc: Services, own: { projectIds: string[]; clipIds: string[] }, redact: (s: string) => string): Promise<string[]> {
  const file = svc.config.LOG_FILE;
  if (!file) return [];
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/\.log$/, "");
  const since = Date.now() - ERROR_WINDOW_DAYS * 864e5;
  const mine = new Set([...own.projectIds, ...own.clipIds]);
  const out: string[] = [];
  const files = (await fsp.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(base)).sort();
  for (const f of files) {
    const text = await fsp.readFile(path.join(dir, f), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line.includes('"level":50') && !line.includes('"level":60')) continue;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const t = Date.parse(String(d.time ?? ""));
      if (Number.isFinite(t) && t < since) continue;
      const ids = [d.projectId, d.clipId].filter((x): x is string => typeof x === "string");
      if (ids.length || d.jobId !== undefined) {
        if (ids.length && ids.every((id) => mine.has(id))) out.push(redact(line));
        continue; // a job or someone else's project: not ours to share
      }
      const err = d.err as { type?: unknown; message?: unknown } | undefined;
      out.push(redact(JSON.stringify({ time: d.time, level: d.level, msg: d.msg, module: d.module, err: err ? { type: err.type, message: err.message } : undefined })));
    }
  }
  return out.slice(-MAX_ERROR_LINES);
}
