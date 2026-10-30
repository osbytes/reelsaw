/**
 * End-to-end bench: the real pipeline (ingest → transcribe → refine → analyze → render) on a whole
 * video, once per profile, in the isolated `reelsaw-bench` compose stack (eval/bench/compose.bench.yml).
 *
 *   npx tsx src/eval/e2e.ts --matrix ../../eval/bench/models.json [--profiles a,b] \
 *       --source https://www.youtube.com/watch?v=... [--max-clips 3] [--repeat 1] [--out ../../eval/bench/results/<stamp>]
 *
 * Per profile: recreate the bench app container with the profile's env on top of the repo .env, wait
 * for /api/health, sign up a throwaway user, create a project from the source URL, poll until done or
 * failed, then read stage timings from project_events, the clips, what models ran (stage_artifacts)
 * and every LLM call (LLM_TRACE=logs lines in the container's LOG_FILE). Writes one JSON per run and a
 * summary.{md,json}. Nothing here touches the main stack: own project name, image, volumes, ports.
 *
 * Step isolation (`--steps refine,analyze [--base-profile <name>]`): one base project is created and
 * finished with the base profile (the first profile by default), then every profile re-runs only the
 * named steps on that same transcript (`projects.refine`, `projects.reanalyze`), so download and
 * transcription are out of the comparison and only the language model changes. Analyze includes the
 * render of the new clips. Minutes per profile instead of a full pipeline each.
 */
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { parseProfiles, type Profile } from "./profiles.js";
import { percentile } from "./meter.js";
import { firstStageSeconds, runsOf } from "../pipeline/runs.js";

const argv = process.argv.slice(2);
const BOOL = new Set(["keep", "verbose", "no-recreate", "gpu"]);
const flagValue = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);
/** With --gpu, reserve the NVIDIA device for the bench app (NVENC). Speaches CUDA is separate. */
const benchGpuFiles = () => (has("gpu") ? ["eval/bench/compose.bench.gpu.yml"] : []);

// fileURLToPath: URL.pathname is `/C:/…` on Windows and is not a valid cwd for spawn (ENOENT).
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const dotenv = (() => {
  const out: Record<string, string> = {};
  const file = path.join(repoRoot, ".env");
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "");
  }
  return out;
})();

const COMPOSE_PROJECT = flagValue("project") ?? "reelsaw-bench";
const BASE = flagValue("base") ?? "http://localhost:3200";
const DB_URL = flagValue("db") ?? `postgres://reelsaw:${dotenv.POSTGRES_PASSWORD ?? "reelsaw"}@127.0.0.1:5442/reelsaw`;
const TIMEOUT_MIN = Number(flagValue("timeout-min") ?? 90);
const STAGES = ["ingest", "transcribe", "refine", "analyze", "render"] as const;

interface LlmLine {
  stage?: string;
  call?: string;
  model: string;
  provider?: string;
  ms: number;
  usage?: { input: number; output: number };
  failed: boolean;
}

interface RunResult {
  profile: string;
  env: Record<string, string>;
  run: number;
  /** "full" = whole pipeline from the URL; "refine" / "analyze" = that step re-run on the base project */
  step: "full" | "refine" | "analyze";
  /** for a step re-run: only events and LLM calls at or after this instant belong to it */
  since?: string;
  /** transcription was served from the ASR cache (same STT as the previous profile): its time is not a measurement */
  sttCached?: boolean;
  projectId: string;
  status: string;
  error?: string | null;
  durationSec?: number | null;
  startedAt: string;
  finishedAt: string;
  /** seconds per stage, wall clock, from stage.started to the last stage.completed of that stage */
  stages: Partial<Record<(typeof STAGES)[number], number>>;
  totalSec: number;
  models: Record<string, string>;
  clips: Array<{ index: number; title: string; hook: string; startSec: number; endSec: number; score: number; status: string; layout: string | null }>;
  llm: { calls: number; failed: number; totalSec: number; p50Ms: number; inputTokens: number; outputTokens: number; byStage: Record<string, { calls: number; totalSec: number }> };
  machine: { platform: string; arch: string; cpus: number; memGb: number; node: string };
}

/** The base compose file's port variables, so the bench stack binds where --base / --db say. */
const composeEnv = {
  ...process.env,
  PORT: new URL(BASE).port || "80",
  POSTGRES_PORT: `127.0.0.1:${new URL(DB_URL).port || "5432"}`,
  BENCH_APP_URL: BASE,
};

/**
 * Resolve the docker CLI. On Windows, spawn() without a shell often misses WinGet/Docker Desktop
 * shims that PowerShell finds via PATH — prefer an absolute path from `where.exe`.
 */
function resolveDockerBin(): string {
  if (process.platform !== "win32") return "docker";
  try {
    const lines = execFileSync("where.exe", ["docker"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const exe = lines.find((p) => /\.exe$/i.test(p)) ?? lines[0];
    if (exe) return exe;
  } catch {
    /* fall through */
  }
  return "docker.exe";
}
const dockerBin = resolveDockerBin();

function sh(cmd: string, args: string[], opts: { cwd?: string; input?: string; quiet?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd ?? repoRoot, env: composeEnv, stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr!.on("data", (d: Buffer) => {
      err += d.toString();
      if (!opts.quiet && has("verbose")) process.stderr.write(d);
    });
    if (opts.input !== undefined) p.stdin!.end(opts.input);
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${err.slice(-800)}`))));
  });
}

const compose = (extraFiles: string[], ...args: string[]) =>
  sh(dockerBin, [
    "compose",
    "-p",
    COMPOSE_PROJECT,
    "-f",
    "docker-compose.yml",
    "-f",
    "eval/bench/compose.bench.yml",
    ...benchGpuFiles().flatMap((f) => ["-f", f]),
    ...extraFiles.flatMap((f) => ["-f", f]),
    ...args,
  ]);

/** Inside the container, the host's services live at host.docker.internal. */
const containerUrl = (v: string) => v.replace(/\/\/(localhost|127\.0\.0\.1)(?=[:/])/g, "//host.docker.internal");

/** The transcription model a profile runs with: its override, else the repo .env. */
const sttOf = (profile: Profile) => profile.env.TRANSCRIPTION_MODEL ?? dotenv.TRANSCRIPTION_MODEL ?? "openai:whisper-1";

/**
 * Recreate the bench app with the profile's env and wait for it. The ASR cache (in the data volume)
 * is cleared when the transcription model changed from the previous profile (or with --fresh-stt),
 * so each STT is timed for real exactly once and profiles that only change the language model
 * don't pay to transcribe the same audio again; their transcribe cell is reported as cached.
 */
async function startProfile(profile: Profile, scratch: string, prevStt?: string): Promise<{ env: Record<string, string>; sttCached: boolean }> {
  const env = Object.fromEntries(Object.entries(profile.env).map(([k, v]) => [k, containerUrl(v)]));
  const clearAsr = has("fresh-stt") || prevStt === undefined || sttOf(profile) !== prevStt;
  const file = path.join(scratch, `profile-${profile.name.replace(/[^A-Za-z0-9._-]+/g, "_")}.yml`);
  const yaml = ["services:", "  app:", "    environment:", ...Object.entries(env).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`)].join("\n") + "\n";
  await fs.writeFile(file, yaml);
  if (!has("no-recreate")) await compose([file], "up", "-d", "--no-build", "app");
  const deadline = Date.now() + 180_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        if (clearAsr) await compose([file], "exec", "-T", "app", "sh", "-c", "rm -rf /data/cache/asr").catch((err: Error) => console.log(`  ⚠ could not clear the ASR cache: ${err.message.slice(0, 120)}`));
        else console.log(`  (same transcription model as the previous profile: ASR cache kept, transcribe will be served from it)`);
        return { env, sttCached: !clearAsr };
      }
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await sleep(2000);
  }
  const logs = await compose([file], "logs", "--tail", "40", "app").catch(() => "");
  throw new Error(`bench app did not become healthy at ${BASE} (${last}). Last logs:\n${logs}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A session cookie. With BENCH_EMAIL / BENCH_PASSWORD set, signs in to that account (creating it on
 * first use) so the bench projects show up when you log in to the bench stack; otherwise a throwaway.
 */
async function signUp(): Promise<string> {
  const email = process.env.BENCH_EMAIL ?? `bench-${randomUUID().slice(0, 8)}@example.test`;
  const password = process.env.BENCH_PASSWORD ?? `pw-${randomUUID()}`;
  const headers = { "content-type": "application/json", origin: BASE };
  const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  if (process.env.BENCH_EMAIL) {
    const res = await fetch(`${BASE}/api/auth/sign-in/email`, { method: "POST", headers, body: JSON.stringify({ email, password }) });
    if (res.ok) return cookieOf(res);
  }
  const res = await fetch(`${BASE}/api/auth/sign-up/email`, { method: "POST", headers, body: JSON.stringify({ email, password, name: "Bench" }) });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
  return cookieOf(res);
}

async function trpcMutation<T>(cookie: string, proc: string, input: unknown): Promise<T> {
  const res = await fetch(`${BASE}/api/trpc/${proc}`, { method: "POST", headers: { "content-type": "application/json", cookie, origin: BASE }, body: JSON.stringify(input) });
  const body = (await res.json()) as { result?: { data: T }; error?: { message: string } };
  if (!res.ok || body.error) throw new Error(`${proc}: ${res.status} ${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
  return body.result!.data;
}

async function llmLines(projectId: string, since?: Date, until?: Date): Promise<LlmLine[]> {
  // pino-roll names the files reelsaw.<date>.<n>.log; read them all and keep this project's calls
  const raw = await compose([], "exec", "-T", "app", "sh", "-c", "cat /data/logs/reelsaw*.log* 2>/dev/null || true").catch(() => "");
  const out: LlmLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes(projectId) || !line.includes('"llm call')) continue;
    try {
      const j = JSON.parse(line) as { time?: string; projectId?: string; msg?: string; stage?: string; call?: string; model?: string; provider?: string; ms?: number; usage?: { input: number; output: number } };
      if (j.projectId !== projectId || !j.model || typeof j.ms !== "number") continue;
      if (j.time && ((since && new Date(j.time).getTime() < since.getTime()) || (until && new Date(j.time).getTime() > until.getTime() + 5000))) continue;
      out.push({ stage: j.stage, call: j.call, model: j.model, provider: j.provider, ms: j.ms, usage: j.usage, failed: j.msg === "llm call failed" });
    } catch {
      /* not JSON (pretty line) */
    }
  }
  return out;
}

type ProjectRow = { status: string; stage: string | null; stage_progress: number | null; error: string | null; duration_sec: number | null };

/** Poll the project until done / failed (and, for a step re-run, until it has left `settleAfter`'s running state). */
async function waitForProject(pool: pg.Pool, projectId: string, opts: { since?: Date } = {}): Promise<ProjectRow | undefined> {
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let row: ProjectRow | undefined;
  let lastShown = "";
  while (Date.now() < deadline) {
    const r = await pool.query("select status, stage, stage_progress, error, duration_sec from projects where id = $1", [projectId]);
    row = r.rows[0];
    if (!row) throw new Error(`project ${projectId} vanished`);
    const shown = `${row.status}${row.stage ? `/${row.stage}` : ""}`;
    if (shown !== lastShown) {
      process.stdout.write(`${shown} `);
      lastShown = shown;
    }
    if (row.status === "done" || row.status === "failed") {
      // a step re-run ends with the project back in "done": make sure that is a new finish, not the old one
      if (!opts.since) break;
      const fin = await pool.query("select 1 from project_events where project_id = $1 and type in ('project.done','project.failed') and created_at >= $2 limit 1", [projectId, opts.since]);
      const refineDone = await pool.query("select 1 from project_events where project_id = $1 and type = 'stage.completed' and payload->>'stage' = 'refine' and created_at >= $2 limit 1", [projectId, opts.since]);
      if (fin.rowCount || refineDone.rowCount) break;
    }
    await sleep(4000);
  }
  if (!row || (row.status !== "done" && row.status !== "failed")) console.log(`\n  ⚠ timed out after ${TIMEOUT_MIN} min (status ${row?.status})`);
  else console.log(row.status === "done" ? "✓" : `✗ ${row.error ?? ""}`);
  return row;
}

/** Seconds per stage from the project's events at or after `since` (all events when omitted). */
async function stageSeconds(pool: pg.Pool, projectId: string, since: Date | undefined, fallbackStart: Date, fallbackEnd: Date, until: Date = fallbackEnd) {
  const events = (await pool.query("select type, payload, created_at from project_events where project_id = $1 and ($2::timestamptz is null or created_at >= $2) and created_at <= $3 order by id", [projectId, since ?? null, new Date(until.getTime() + 5000)])).rows as Array<{ type: string; payload: Record<string, unknown>; created_at: Date }>;
  // runs.ts is the one reader of stage timings (payload durations, with timestamp fallbacks for old events)
  const runs = runsOf(events.map((e) => ({ type: e.type, payload: e.payload, createdAt: e.created_at })));
  const stages: RunResult["stages"] = {};
  for (const stage of STAGES) {
    const sec = firstStageSeconds(runs)[stage];
    if (sec !== undefined) stages[stage] = round(sec);
  }
  const lastFinished = [...runs].reverse().find((r) => r.finishedAt);
  const startMs = runs[0] ? new Date(runs[0].startedAt).getTime() : (events[0]?.created_at ?? fallbackStart).getTime();
  const totalSec = round(((lastFinished?.finishedAt ? new Date(lastFinished.finishedAt) : fallbackEnd).getTime() - startMs) / 1000);
  return { stages, totalSec };
}

async function collect(pool: pg.Pool, profile: Profile, env: Record<string, string>, run: number, step: RunResult["step"], projectId: string, row: ProjectRow | undefined, since: Date | undefined, startedAt: Date, finishedAt: Date): Promise<RunResult> {
  const { stages, totalSec } = await stageSeconds(pool, projectId, since, startedAt, finishedAt);

  const models: Record<string, string> = {};
  for (const a of (await pool.query("select models from stage_artifacts where project_id = $1 and ($2::timestamptz is null or created_at >= $2) order by id", [projectId, since ?? null])).rows as Array<{ models: Record<string, string> }>) Object.assign(models, a.models);
  const clips = ((await pool.query("select index, title, hook, start_sec, end_sec, score, status, layout from clips where project_id = $1 order by index", [projectId])).rows as Array<Record<string, unknown>>).map((c) => ({
    index: Number(c.index),
    title: String(c.title),
    hook: String(c.hook),
    startSec: round(Number(c.start_sec)),
    endSec: round(Number(c.end_sec)),
    score: Number(c.score),
    status: String(c.status),
    layout: (c.layout as string | null) ?? null,
  }));

  const llm = llmSummary(await llmLines(projectId, since, finishedAt));
  return {
    profile: profile.name,
    env,
    run,
    step,
    ...(since ? { since: since.toISOString() } : {}),
    projectId,
    status: row?.status ?? "timeout",
    error: row?.error ?? null,
    durationSec: row?.duration_sec ?? null,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    stages,
    totalSec,
    models,
    clips,
    llm,
    machine: { platform: `${os.platform()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length, memGb: Math.round(os.totalmem() / 2 ** 30), node: process.version },
  };
}

/** The whole pipeline from the URL under `profile`'s env. */
async function runOnce(pool: pg.Pool, cookie: string, profile: Profile, env: Record<string, string>, run: number, source: string, maxClips: number | undefined, sttCached = false): Promise<RunResult> {
  const startedAt = new Date();
  const created = await trpcMutation<{ id: string }>(cookie, "projects.create", { sourceUrl: source, title: `bench ${profile.name} #${run}`, ...(maxClips ? { settings: { maxClips } } : {}) });
  process.stdout.write(`  project ${created.id} … `);
  const row = await waitForProject(pool, created.id);
  const r = await collect(pool, profile, env, run, "full", created.id, row, undefined, startedAt, new Date());
  return sttCached ? { ...r, sttCached: true } : r;
}

/** One step re-run on the base project under `profile`'s env: refine (all steps) or analyze (re-pick + render). */
async function runStep(pool: pg.Pool, cookie: string, profile: Profile, env: Record<string, string>, run: number, step: "refine" | "analyze", projectId: string): Promise<RunResult> {
  const since = new Date();
  if (step === "refine") await trpcMutation(cookie, "projects.refine", { id: projectId });
  else await trpcMutation(cookie, "projects.reanalyze", { id: projectId });
  process.stdout.write(`  ${step} on ${projectId} … `);
  const row = await waitForProject(pool, projectId, { since });
  return collect(pool, profile, env, run, step, projectId, row, since, since, new Date());
}

const round = (n: number) => Math.round(n * 10) / 10;
const secs = (n: number | undefined) => (n === undefined ? "" : n >= 100 ? `${Math.round(n)}s` : `${n.toFixed(1)}s`);
const tokens = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function summaryTable(results: RunResult[]): { head: string[]; rows: string[][] } {
  const head = ["profile", "step", "run", "status", "total", ...STAGES, "clips", "llm calls", "llm total", "llm p50", "tokens in/out", "language", "transcription"];
  const rows = results.map((r) => [
    r.profile,
    r.step ?? "full",
    String(r.run),
    r.status,
    secs(r.totalSec),
    ...STAGES.map((s) => (s === "transcribe" && r.sttCached ? "cached" : secs(r.stages[s]))),
    `${r.clips.filter((c) => c.status === "done").length}/${r.clips.length}`,
    r.llm.calls ? `${r.llm.calls}${r.llm.failed ? ` (${r.llm.failed} failed)` : ""}` : "",
    r.llm.calls ? secs(r.llm.totalSec) : "",
    r.llm.calls ? `${(r.llm.p50Ms / 1000).toFixed(1)}s` : "",
    r.llm.calls ? `${tokens(r.llm.inputTokens)}/${tokens(r.llm.outputTokens)}` : "",
    r.models.language ?? r.env.AI_MODEL ?? "",
    r.models.transcription ?? r.env.TRANSCRIPTION_MODEL ?? "",
  ]);
  return { head, rows };
}

function printTable(head: string[], rows: string[][]) {
  const w = head.map((h, i) => Math.min(44, Math.max(h.length, ...rows.map((r) => r[i]!.length))));
  console.log("  " + head.map((h, i) => h.padEnd(w[i]!)).join("  "));
  for (const r of rows) console.log("  " + r.map((x, i) => x.slice(0, w[i]).padEnd(w[i]!)).join("  "));
}

function markdown(results: RunResult[], source: string, profiles: Profile[], maxClips: number | undefined): string {
  const { head, rows } = summaryTable(results);
  const m = results[0]?.machine;
  const out = [
    `# End-to-end bench ${new Date().toISOString().slice(0, 10)}`,
    "",
    `Source: ${source}  `,
    `Clips requested: ${maxClips ?? "default"}  `,
    m ? `Machine: ${m.platform} ${m.arch}, ${m.cpus} cores, ${m.memGb} GB, node ${m.node}  ` : "",
    `Stack: compose project \`${COMPOSE_PROJECT}\` (eval/bench/compose.bench.yml), LLM_TRACE=logs, ASR cache cleared only when the transcription model changes between profiles (or with \`--fresh-stt\`)`,
    "",
    "Stage seconds are wall clock between `stage.started` and the last `stage.completed` of that stage (render: analyze done → project done). Ingest includes the download. Refine steps run in parallel with analyze, so stages do not add up to the total. Step rows (`refine`, `analyze`) re-ran only that step on the base project's transcript; their `total` is that step plus the re-render of its clips (refine re-renders clips whose words changed; analyze renders the clips it picked).",
    "",
    "## Profiles",
    "",
    "| profile | overrides |",
    "|---|---|",
    ...profiles.map((p) => `| ${p.name} | ${Object.entries(p.env).map(([k, v]) => `\`${k}=${v}\``).join(" ") || "(none)"} |`),
    "",
    "## Timings",
    "",
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
    "## LLM calls by stage",
    "",
    "| profile | run | stage | calls | total |",
    "|---|---|---|---|---|",
    ...results.flatMap((r) => Object.entries(r.llm.byStage).map(([s, v]) => `| ${r.profile} | ${r.run} | ${s} | ${v.calls} | ${secs(v.totalSec)} |`)),
    "",
    "## Clips picked",
    "",
  ];
  for (const r of results) {
    out.push(`### ${r.profile} · ${r.step ?? "full"} #${r.run} (${r.status}${r.error ? `: ${r.error}` : ""})`, "");
    if (!r.clips.length) out.push("(no clips)", "");
    else {
      out.push("| # | range | len | score | layout | status | title | hook |", "|---|---|---|---|---|---|---|---|");
      for (const c of r.clips) out.push(`| ${c.index} | ${fmtTs(c.startSec)}–${fmtTs(c.endSec)} | ${(c.endSec - c.startSec).toFixed(0)}s | ${Math.round(c.score)} | ${c.layout ?? ""} | ${c.status} | ${esc(c.title)} | ${esc(c.hook)} |`);
      out.push("");
    }
  }
  return out.join("\n");
}
const esc = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();
const fmtTs = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Compact the raw LLM lines of a project into the per-run summary shape. */
function llmSummary(lines: LlmLine[]): RunResult["llm"] {
  const ms = lines.map((l) => l.ms).sort((a, b) => a - b);
  const byStage: RunResult["llm"]["byStage"] = {};
  for (const l of lines) {
    const k = l.stage ?? l.call?.split(".")[0] ?? "other";
    byStage[k] ??= { calls: 0, totalSec: 0 };
    byStage[k]!.calls++;
    byStage[k]!.totalSec = round(byStage[k]!.totalSec + l.ms / 1000);
  }
  return {
    calls: lines.length,
    failed: lines.filter((l) => l.failed).length,
    totalSec: round(ms.reduce((a, b) => a + b, 0) / 1000),
    p50Ms: percentile(ms, 50),
    inputTokens: lines.reduce((a, l) => a + (l.usage?.input ?? 0), 0),
    outputTokens: lines.reduce((a, l) => a + (l.usage?.output ?? 0), 0),
    byStage,
  };
}

/** `--rescan <results dir>`: re-read LLM calls from the bench stack's logs for every run JSON there and rewrite the summary. */
async function rescan(dir: string) {
  const summaryFile = path.join(dir, "summary.json");
  const summary = JSON.parse(await fs.readFile(summaryFile, "utf8")) as { source: string; maxClips?: number; profiles: Profile[]; results: RunResult[] };
  // the trace log lives in the app container: refuse to rewrite the files with zero calls when it is not running
  await compose([], "exec", "-T", "app", "sh", "-c", "ls /data/logs >/dev/null").catch(() => {
    throw new Error(`the ${COMPOSE_PROJECT} app container is not running; start it (docker compose -p ${COMPOSE_PROJECT} ... start app) and rescan again`);
  });
  const pool = new pg.Pool({ connectionString: DB_URL });
  for (const r of summary.results) {
    r.step ??= "full";
    r.llm = llmSummary(await llmLines(r.projectId, r.since ? new Date(r.since) : undefined, new Date(r.finishedAt)));
    const since = r.since ? new Date(r.since) : undefined;
    const timing = await stageSeconds(pool, r.projectId, since, new Date(r.startedAt), new Date(r.finishedAt)).catch(() => undefined);
    if (timing) Object.assign(r, timing);
    await fs.rm(path.join(dir, `${r.profile}-${r.run}.json`), { force: true }); // pre-step file name
    await fs.writeFile(path.join(dir, `${r.profile}-${r.step}-${r.run}.json`), JSON.stringify(r, null, 2));
    console.log(`${r.profile} ${r.step} #${r.run}: ${r.llm.calls} llm calls, ${secs(r.llm.totalSec)}`);
  }
  await pool.end();
  await fs.writeFile(summaryFile, JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(dir, "summary.md"), markdown(summary.results, summary.source, summary.profiles, summary.maxClips));
  console.log(`rewritten: ${path.relative(process.cwd(), path.join(dir, "summary.md"))}`);
}

async function main() {
  if (flagValue("rescan")) return rescan(path.resolve(flagValue("rescan")!));
  const source = flagValue("source");
  if (!source) throw new Error("--source <video url> is required");
  const profiles = parseProfiles({ matrix: flagValue("matrix"), profiles: flagValue("profiles"), set: argv.flatMap((a, i) => (a === "--set" && argv[i + 1] ? [argv[i + 1]!] : [])) });
  if (!profiles.length) profiles.push({ name: "default", env: {} });
  const repeat = Number(flagValue("repeat") ?? 1);
  const maxClips = flagValue("max-clips") ? Number(flagValue("max-clips")) : undefined;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const outDir = path.resolve(flagValue("out") ?? path.join(repoRoot, "eval", "bench", "results", `e2e-${stamp}`));
  await fs.mkdir(outDir, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "reelsaw-bench-"));

  const steps = (flagValue("steps") ?? "").split(",").map((s) => s.trim()).filter((s): s is "refine" | "analyze" => s === "refine" || s === "analyze");
  if (flagValue("steps") && !steps.length) throw new Error(`--steps takes refine and/or analyze, got "${flagValue("steps")}"`);
  const baseName = flagValue("base-profile") ?? profiles[0]!.name;
  const base = profiles.find((p) => p.name === baseName);
  if (steps.length && !base) throw new Error(`--base-profile ${baseName} is not among the selected profiles`);

  console.log(`bench stack ${COMPOSE_PROJECT} at ${BASE}${has("gpu") ? " (--gpu: NVENC for the bench app)" : ""}; ${profiles.length} profile(s) × ${repeat} run(s)${steps.length ? `; steps ${steps.join("+")} on a base project from ${baseName}` : ""}; results → ${path.relative(process.cwd(), outDir)}`);
  const pool = new pg.Pool({ connectionString: DB_URL });
  const results: RunResult[] = [];
  const record = async (r: RunResult) => {
    results.push(r);
    await fs.writeFile(path.join(outDir, `${r.profile}-${r.step}-${r.run}.json`), JSON.stringify(r, null, 2));
    console.log(`  ${r.step} ${secs(r.totalSec)} · ${STAGES.map((s) => `${s} ${secs(r.stages[s]) || "-"}`).join(" · ")} · clips ${r.clips.filter((c) => c.status === "done").length}/${r.clips.length} · llm ${r.llm.calls} calls ${secs(r.llm.totalSec)}`);
  };
  const describe = (p: Profile) => `\n━━ ${p.name}: ${Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join(" ") || "(no overrides)"}`;
  try {
    // one throwaway user for the whole run: sessions live in the DB, so the cookie survives container recreation
    let cookie: string | undefined;
    let baseProject: string | undefined;
    let prevStt: string | undefined;
    if (steps.length) {
      console.log(describe(base!));
      const { env } = await startProfile(base!, scratch);
      prevStt = sttOf(base!);
      cookie = await signUp();
      const r = await runOnce(pool, cookie, base!, env, 1, source, maxClips);
      await record(r);
      if (r.status !== "done") throw new Error(`base project ${r.projectId} ended ${r.status}; cannot re-run steps on it`);
      baseProject = r.projectId;
    }
    for (const profile of profiles) {
      if (steps.length && profile.name === baseName && repeat === 1) continue; // the base run already measured this profile end to end
      console.log(describe(profile));
      let started: Awaited<ReturnType<typeof startProfile>>;
      try {
        started = await startProfile(profile, scratch, prevStt);
        prevStt = sttOf(profile);
        cookie ??= await signUp();
      } catch (err) {
        console.log(`  ✗ ${(err as Error).message}`);
        continue;
      }
      for (let run = 1; run <= repeat; run++) {
        try {
          if (steps.length) for (const step of steps) await record(await runStep(pool, cookie, profile, started.env, run, step, baseProject!));
          else await record(await runOnce(pool, cookie, profile, started.env, run, source, maxClips, started.sttCached && run === 1 ? true : run > 1));
        } catch (err) {
          console.log(`  ✗ run ${run}: ${(err as Error).message}`);
        }
      }
    }
  } finally {
    await pool.end();
  }
  if (results.length) {
    console.log("\n━━ summary");
    const { head, rows } = summaryTable(results);
    printTable(head, rows);
    await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({ at: new Date().toISOString(), source, maxClips, profiles, results }, null, 2));
    await fs.writeFile(path.join(outDir, "summary.md"), markdown(results, source, profiles, maxClips));
    console.log(`\nwritten: ${path.relative(process.cwd(), path.join(outDir, "summary.md"))}`);
  }
  if (!has("keep")) {
    // leave the stack up but stop the app so it stops polling/rendering; `--keep` leaves it running
    await compose([], "stop", "app").catch(() => {});
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
