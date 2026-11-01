/**
 * Runs: the one reader of a project's history. A run is the stretch of work from `run.started`
 * (written by `startRun`, see lifecycle.ts) to the next `project.done` / `project.failed`. This
 * module groups the event log into runs and reads their durations, and is the only place that
 * falls back to event timestamps: events written before durations became payload facts
 * (`stage.completed.durationSec`, `project.done.runSec`) and projects from before `run.started`
 * existed still yield sensible runs. The expected-time model, the admin Processing times page,
 * `reelsaw status` and the bench all read through here.
 */
import { and, asc, inArray } from "drizzle-orm";
import { PIPELINE_STAGES, type PipelineStage, type RunReason } from "@reelsaw/shared";
import { schema, type Db } from "../db/index.js";

export interface LogEvent {
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date | string;
}

export interface Run {
  seq: number;
  /** null for runs reconstructed from an old log that never recorded why */
  reason: RunReason | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: "running" | "done" | "failed";
  /** total seconds, from the project.done / project.failed payload, else from event timestamps */
  runSec: number | null;
  /** seconds per stage of this run; a stage that did not complete in it is absent */
  stages: Partial<Record<PipelineStage, number>>;
  clips: { done: number; failed: number };
  error?: string;
}

/** Event types runsOf reads; load only these. */
export const RUN_EVENT_TYPES = [
  "project.created",
  "run.started",
  "stage.started",
  "stage.completed",
  "project.done",
  "project.failed",
  "clip.created",
  "clip.rendering",
  "clip.retrying",
  "clip.done",
  "clip.failed",
] as const;

/** Events that, in a log from before `run.started`, show work beginning on an idle project. */
const LEGACY_STARTERS = new Set(["stage.started", "clip.rendering", "clip.retrying", "clip.created"]);

const ms = (v: Date | string) => new Date(v).getTime();
const r1 = (n: number) => Math.round(n * 10) / 10;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isStage = (v: unknown): v is PipelineStage => (PIPELINE_STAGES as readonly string[]).includes(v as string);

interface Open {
  run: Run;
  startMs: number;
  /** created from project.created alone; a run.started right after takes it over */
  implicit: boolean;
  empty: boolean;
  stageStart: Partial<Record<PipelineStage, number>>;
  /** when the stage before render finished, for old logs without renderSec */
  renderFrom?: number;
  renderFromRefine?: number;
  clipsDone: number;
  clipsFailed: number;
}

/** Group a project's events (in id order) into runs, oldest first. */
export function runsOf(log: LogEvent[]): Run[] {
  const explicit = log.some((e) => e.type === "run.started");
  const runs: Run[] = [];
  let cur: Open | null = null;

  const open = (seq: number, reason: RunReason | null, t: number, implicit: boolean): Open => {
    const run: Run = {
      seq,
      reason,
      startedAt: new Date(t).toISOString(),
      finishedAt: null,
      outcome: "running",
      runSec: null,
      stages: {},
      clips: { done: 0, failed: 0 },
    };
    runs.push(run);
    return { run, startMs: t, implicit, empty: true, stageStart: {}, clipsDone: 0, clipsFailed: 0 };
  };

  for (const e of log) {
    const t = ms(e.createdAt);
    const p = e.payload ?? {};
    if (e.type === "project.created") {
      cur = open(runs.length + 1, "created", t, true);
      continue;
    }
    if (e.type === "run.started") {
      const seq = num(p.seq) ?? runs.length + 1;
      const reason = (typeof p.reason === "string" ? p.reason : null) as RunReason | null;
      if (cur && cur.implicit && cur.empty) {
        cur.run.seq = seq;
        cur.run.reason = reason;
        cur.implicit = false;
      } else cur = open(seq, reason, t, false);
      continue;
    }
    if (!cur && !explicit && LEGACY_STARTERS.has(e.type)) cur = open(runs.length + 1, null, t, true);
    if (!cur) continue; // stray event of a run that is not in this log (e.g. a window that starts mid-run)
    cur.empty = false;
    const stage = p.stage;
    if (e.type === "stage.started" && isStage(stage)) {
      cur.stageStart[stage] ??= t;
    } else if (e.type === "stage.completed" && isStage(stage)) {
      if (cur.run.stages[stage] === undefined) {
        // the payload's clock is the precise one, but a stage cannot outlast the events around it: before
        // the fix in ingest, its payload carried the video's length as durationSec, and the wall clock is
        // the only thing that keeps those projects out of the time estimates
        const wall = cur.stageStart[stage] !== undefined ? (t - cur.stageStart[stage]!) / 1000 : undefined;
        const reported = num(p.durationSec);
        const sec = reported !== undefined && wall !== undefined ? Math.min(reported, wall) : (reported ?? wall);
        if (sec !== undefined) cur.run.stages[stage] = r1(sec);
      }
      if (stage === "analyze") cur.renderFrom = t;
      if (stage === "refine") cur.renderFromRefine = t;
    } else if (e.type === "clip.done") cur.clipsDone++;
    else if (e.type === "clip.failed") cur.clipsFailed++;
    else if (e.type === "project.done" || e.type === "project.failed") {
      const run = cur.run;
      run.finishedAt = new Date(t).toISOString();
      run.outcome = e.type === "project.done" ? "done" : "failed";
      run.runSec = r1(num(p.runSec) ?? (t - cur.startMs) / 1000);
      run.clips = { done: num(p.clips) ?? cur.clipsDone, failed: num(p.failed) ?? cur.clipsFailed };
      if (typeof p.error === "string") run.error = p.error;
      if (run.outcome === "done" && run.stages.render === undefined) {
        // render has no stage.completed: it runs per clip and ends with project.done
        const from = cur.renderFrom ?? cur.renderFromRefine;
        const sec = num(p.renderSec) ?? (from !== undefined && t > from ? (t - from) / 1000 : undefined);
        if (sec !== undefined && sec > 0) run.stages.render = r1(sec);
      }
      cur = null;
    }
  }
  return runs;
}

/** Events of these projects that runsOf reads, grouped by project, in id order. */
export async function loadRunLogs(db: Db, projectIds: string[]): Promise<Map<string, LogEvent[]>> {
  const out = new Map<string, LogEvent[]>(projectIds.map((id) => [id, []]));
  if (!projectIds.length) return out;
  const rows = await db
    .select({
      projectId: schema.projectEvents.projectId,
      type: schema.projectEvents.type,
      payload: schema.projectEvents.payload,
      createdAt: schema.projectEvents.createdAt,
    })
    .from(schema.projectEvents)
    .where(and(inArray(schema.projectEvents.projectId, projectIds), inArray(schema.projectEvents.type, [...RUN_EVENT_TYPES])))
    .orderBy(asc(schema.projectEvents.id));
  for (const r of rows) out.get(r.projectId)?.push(r);
  return out;
}

/** The runs of one project. */
export async function runsOfProject(db: Db, projectId: string): Promise<Run[]> {
  return runsOf((await loadRunLogs(db, [projectId])).get(projectId) ?? []);
}

/** Seconds per stage for a project's history: each stage from the first run that completed it. */
export function firstStageSeconds(runs: Run[]): Partial<Record<PipelineStage, number>> {
  const out: Partial<Record<PipelineStage, number>> = {};
  for (const run of runs) for (const stage of PIPELINE_STAGES) if (out[stage] === undefined && run.stages[stage] !== undefined) out[stage] = run.stages[stage];
  return out;
}

const REASON: Record<string, string> = {
  created: "new project",
  retry: "retry",
  rerender: "re-render",
  refine: "refine",
  reanalyze: "re-analyze",
  clip_added: "clip added",
};

/** One line per run, for `reelsaw status`. */
export function describeRun(r: Run): string {
  const mm = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  const stages = PIPELINE_STAGES.filter((s) => r.stages[s] !== undefined)
    .map((s) => `${s} ${mm(r.stages[s]!)}`)
    .join(" ");
  const total = r.runSec !== null ? mm(r.runSec) : "running";
  const clips = r.outcome === "running" ? "" : ` clips ${r.clips.done}${r.clips.failed ? ` (+${r.clips.failed} failed)` : ""}`;
  return `#${r.seq} ${(r.reason ? (REASON[r.reason] ?? r.reason) : "unknown reason").padEnd(11)} ${r.startedAt.slice(0, 19).replace("T", " ")}  ${r.outcome.padEnd(7)} ${total.padStart(7)}${clips}${stages ? `  [${stages}]` : ""}${r.error ? `  ${r.error.slice(0, 80)}` : ""}`;
}
