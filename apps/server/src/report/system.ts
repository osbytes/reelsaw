/**
 * Instance context for issue reports: versions, machine resources, on-device models, queue state,
 * usage and recent errors. Only included when reportCapabilities.system is true (self-host or
 * admin): hosted non-admins must not see instance-wide queue/error data. Self-hosted installs
 * often have no crash reporting service, so the instance's own logs and job table are the error
 * history; they are read on demand and redacted.
 *
 * `include.instance` (admin only) widens queue failures, usage, errors and adds unfinished work
 * across every account, for problems that are not just the reporter's projects.
 */
import fsp from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ProjectStatus } from "@reelsaw/shared";
import { schema } from "../db/index.js";
import { listWorkers } from "../ops/workers.js";
import { needsPrepare } from "../pipeline/manual.js";
import type { Services } from "../services.js";
import { storageReport } from "../storage/usage.js";
import { hashOwner } from "./redact.js";
import { logFiles } from "../log-read.js";

const run = promisify(execFile);
const MAX_ERROR_LINES = 2000;
const ERROR_WINDOW_DAYS = 7;
const MAX_STUCK = 100;
const MAX_INSTANCE_PROJECTS = 200;
const MAX_FAILED_JOBS = 50;
const WORKING: ProjectStatus[] = ["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"];

async function toolVersion(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { timeout: 5000 });
    return stdout.split("\n")[0]!.trim().slice(0, 200);
  } catch {
    return "unavailable";
  }
}

function hashJobData(data: Record<string, unknown> | null) {
  if (!data || typeof data.userId !== "string") return data;
  const { userId, ...rest } = data;
  return { ...rest, ownerHash: hashOwner(userId) };
}

/** `full` (admin-generated reports only) adds the configuration dump: machine, models, storage driver, roles. Others get versions only. */
export async function systemInfo(svc: Services, instance: boolean, full: boolean) {
  const c = svc.config;
  if (!full) return { app: { version: c.REELSAW_VERSION, commit: c.REELSAW_COMMIT, builtAt: c.REELSAW_BUILT_AT }, runtime: { node: process.version, platform: process.platform, arch: process.arch } };
  const accounts = instance
    ? await svc.database.db.execute(sql`
        select
          count(*)::int as total,
          count(*) filter (where role = 'admin')::int as admins,
          count(*) filter (where approved_at is null)::int as pending,
          count(*) filter (where banned)::int as suspended
        from "user"`)
    : null;
  return {
    app: { version: c.REELSAW_VERSION, commit: c.REELSAW_COMMIT, builtAt: c.REELSAW_BUILT_AT },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, uptimeSec: Math.round(process.uptime()), rssMB: Math.round(process.memoryUsage().rss / 1048576) },
    resources: await svc.resources.snapshot().catch(() => null),
    tools: { ffmpeg: await toolVersion(c.FFMPEG_PATH, ["-version"]), ytDlp: await toolVersion("yt-dlp", ["--version"]) },
    gpu: svc.resources.gpu(),
    videoEncoder: svc.media.encoder(),
    // the execution provider each on-device model runs on (null = off); the VAD is always on the cpu
    onDevice: { requested: c.ONNX_EXECUTION_PROVIDER, faces: svc.faces?.provider ?? null, text: svc.text?.provider ?? null, vad: svc.vad ? "cpu" : null, aligner: svc.aligner?.provider ?? null },
    storage: svc.storage.driver,
    roles: { http: c.RUN_HTTP, workers: c.RUN_WORKERS },
    ...(instance
      ? {
          disk: await storageReport(svc).catch((err: Error) => ({ error: err.message })),
          accounts: accounts?.rows[0] ?? null,
          workers: await listWorkers(svc).catch((err: Error) => ({ error: err.message })),
        }
      : {}),
  };
}

/** Job counts per queue/state and the most recent failures (output redacted by the caller). */
export async function queueInfo(svc: Services, scope: { projectIds: string[] } | { instance: true }) {
  const db = svc.database.db;
  try {
    const counts = await db.execute(sql`select name, state, count(*)::int as n from pgboss.job group by 1, 2 order by 1, 2`);
    const instance = "instance" in scope;
    const failed = instance
      ? await db.execute(sql`select name, state, retry_count as retries, data, output, created_on, completed_on from pgboss.job
          where state = 'failed' order by completed_on desc nulls last limit ${MAX_FAILED_JOBS}`)
      : scope.projectIds.length
        ? await db.execute(sql`select name, state, retry_count as retries, data, output, created_on, completed_on from pgboss.job
            where state = 'failed' and data->>'projectId' in (${sql.join(scope.projectIds.map((id) => sql`${id}`), sql`, `)})
            order by completed_on desc nulls last limit ${MAX_FAILED_JOBS}`)
        : { rows: [] };
    // job data carries the owner's user id (fair scheduling); the bundle pseudonymises it like project.json's ownerHash
    const hashed = failed.rows.map((r) => {
      const d = r.data as Record<string, unknown> | null;
      return { ...r, data: hashJobData(d) };
    });
    return { scope: instance ? "instance" : "own", counts: counts.rows, recentFailures: hashed };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

export async function usageInfo(svc: Services, scope: { userId: string } | { instance: true }) {
  const db = svc.database.db;
  const instance = "instance" in scope;
  const projects = instance
    ? await db.execute(sql`select status, count(*)::int as n from projects where deleted_at is null group by 1`)
    : await db.execute(sql`select status, count(*)::int as n from projects where user_id = ${scope.userId} and deleted_at is null group by 1`);
  const clips = instance
    ? await db.execute(sql`select c.status, count(*)::int as n,
        percentile_cont(0.5) within group (order by (c.diagnostics->>'renderMs')::float) as median_render_ms,
        percentile_cont(0.9) within group (order by (c.diagnostics->>'renderMs')::float) as p90_render_ms
      from clips c join projects p on p.id = c.project_id where p.deleted_at is null and c.deleted_at is null group by 1`)
    : await db.execute(sql`select c.status, count(*)::int as n,
        percentile_cont(0.5) within group (order by (c.diagnostics->>'renderMs')::float) as median_render_ms,
        percentile_cont(0.9) within group (order by (c.diagnostics->>'renderMs')::float) as p90_render_ms
      from clips c join projects p on p.id = c.project_id where p.user_id = ${scope.userId} and p.deleted_at is null and c.deleted_at is null group by 1`);
  return { scope: instance ? "instance" : "own", projects: projects.rows, clips: clips.rows };
}

/**
 * Error/fatal log lines from the last week. Without `instance`, a line that names a project, clip
 * or job is kept only when it belongs to the requesting user; a line that names none is reduced to
 * time, level, message, module and error type/message (no stack, no other fields), so another
 * user's content (including from projects since deleted) can't ride along. Admins who opt into
 * instance-wide diagnostics get every error/fatal line, still redacted.
 */
export async function recentErrors(svc: Services, own: { projectIds: string[]; clipIds: string[]; instance?: boolean }, redact: (s: string) => string): Promise<string[]> {
  const file = svc.config.LOG_FILE;
  if (!file) return [];
  const since = Date.now() - ERROR_WINDOW_DAYS * 864e5;
  const mine = new Set([...own.projectIds, ...own.clipIds]);
  const out: string[] = [];
  const files = await logFiles(file);
  for (const f of files) {
    const text = await fsp.readFile(f, "utf8").catch(() => "");
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
      if (own.instance) {
        out.push(redact(line));
        continue;
      }
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

type LiveJob = { name: string; state: string; retries: number; singletonKey: string; startedOn: Date | null; output: unknown; projectId: string | null };

/**
 * Unfinished projects and their live jobs — the same facts `reelsaw stuck` prints. Bounded; titles
 * of other accounts' projects are included because an admin opted into instance diagnostics.
 */
export async function stuckInfo(svc: Services) {
  const db = svc.database.db;
  const rows = await db.query.projects.findMany({
    where: and(inArray(schema.projects.status, WORKING), isNull(schema.projects.deletedAt)),
    columns: { id: true, title: true, status: true, stage: true, userId: true, updatedAt: true, error: true, runSeq: true, runStartedAt: true },
    orderBy: desc(schema.projects.updatedAt),
    limit: MAX_STUCK + 1,
  });
  const truncated = rows.length > MAX_STUCK;
  const projects = rows.slice(0, MAX_STUCK);
  if (!projects.length) return { truncated: false, limit: MAX_STUCK, projects: [] as never[] };

  const ids = projects.map((p) => p.id);
  const [lastEvents, clips, jobs] = await Promise.all([
    // raw rows keep timestamptz as text (drizzle's node-postgres driver), so it is cast and read as a string
    db.execute<{ project_id: string; type: string; at: string }>(sql`
      select distinct on (project_id) project_id, type, to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
      from project_events where project_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      order by project_id, id desc`),
    db.query.clips.findMany({
      where: and(inArray(schema.clips.projectId, ids), isNull(schema.clips.deletedAt)),
      columns: { id: true, projectId: true, index: true, status: true, origin: true, reasoning: true, scores: true },
    }),
    db.execute<LiveJob>(sql`
      select name, state, retry_count as retries, singleton_key as "singletonKey", started_on as "startedOn", output, data->>'projectId' as "projectId"
      from pgboss.job
      where state in ('created','retry','active') and data->>'projectId' in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      order by created_on`).catch(() => ({ rows: [] as LiveJob[] })),
  ]);

  const lastBy = new Map(lastEvents.rows.map((e) => [e.project_id, e]));
  const jobsBy = new Map<string, LiveJob[]>();
  for (const j of jobs.rows) {
    if (!j.projectId) continue;
    const list = jobsBy.get(j.projectId) ?? [];
    list.push(j);
    jobsBy.set(j.projectId, list);
  }
  const clipsBy = new Map<string, typeof clips>();
  for (const c of clips) {
    const list = clipsBy.get(c.projectId) ?? [];
    list.push(c);
    clipsBy.set(c.projectId, list);
  }

  return {
    truncated,
    limit: MAX_STUCK,
    projects: projects.map((p) => {
      const live = jobsBy.get(p.id) ?? [];
      const unfinished = (clipsBy.get(p.id) ?? []).filter((c) => c.status !== "done" && c.status !== "failed");
      const last = lastBy.get(p.id);
      return {
        id: p.id,
        title: p.title,
        status: p.status,
        stage: p.stage,
        ownerHash: hashOwner(p.userId),
        updatedAt: p.updatedAt.toISOString(),
        runSeq: p.runSeq,
        runStartedAt: p.runStartedAt?.toISOString() ?? null,
        error: p.error,
        lastEvent: last ? { type: last.type, at: last.at } : null,
        liveJobs: live.map((j) => ({ name: j.name, state: j.state, retries: j.retries, singletonKey: j.singletonKey, startedOn: j.startedOn, output: j.output })),
        unfinishedClips: unfinished.map((c) => {
          const js = live.filter((j) => j.singletonKey === c.id);
          const problems = [needsPrepare(c) && c.status !== "preparing" ? "unprepared" : "", !js.length ? "NO JOB" : "", js.some((j) => j.retries > 0) ? "retried" : ""].filter(Boolean);
          return { id: c.id, index: c.index, status: c.status, origin: c.origin, jobs: js.map((j) => `${j.name}:${j.state}#${j.retries}`), problems };
        }),
      };
    }),
  };
}

/**
 * Bounded project list for instance-wide reports: everything in progress, plus recent failures
 * and recently updated rows. Owner ids hashed; source URLs omitted (host is enough via sourceType).
 */
export async function instanceProjectSummaries(svc: Services) {
  const db = svc.database.db;
  const cols = { id: true, title: true, status: true, stage: true, error: true, sourceType: true, durationSec: true, createdAt: true, updatedAt: true, userId: true } as const;
  const [working, failed, recent] = await Promise.all([
    db.query.projects.findMany({
      where: and(inArray(schema.projects.status, WORKING), isNull(schema.projects.deletedAt)),
      columns: cols,
      orderBy: desc(schema.projects.updatedAt),
      limit: MAX_STUCK,
    }),
    db.query.projects.findMany({
      where: and(eq(schema.projects.status, "failed"), isNull(schema.projects.deletedAt)),
      columns: cols,
      orderBy: desc(schema.projects.updatedAt),
      limit: MAX_STUCK,
    }),
    db.query.projects.findMany({
      where: isNull(schema.projects.deletedAt),
      columns: cols,
      orderBy: desc(schema.projects.updatedAt),
      limit: MAX_INSTANCE_PROJECTS,
    }),
  ]);
  const byId = new Map<string, (typeof recent)[number]>();
  for (const p of [...working, ...failed, ...recent]) byId.set(p.id, p);
  const items = [...byId.values()]
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, MAX_INSTANCE_PROJECTS)
    .map((p) => ({
      id: p.id,
      title: p.title,
      status: p.status,
      stage: p.stage,
      error: p.error,
      sourceType: p.sourceType,
      durationSec: p.durationSec,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
      ownerHash: hashOwner(p.userId),
    }));
  return { truncated: byId.size > MAX_INSTANCE_PROJECTS || working.length === MAX_STUCK || failed.length === MAX_STUCK, limit: MAX_INSTANCE_PROJECTS, projects: items };
}
