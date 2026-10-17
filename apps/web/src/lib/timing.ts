/**
 * Stage wall-clock from a project's event log, for "elapsed / expected" lines. Mirrors the server's
 * estimates.ts: a stage runs from its `stage.started` to the last `stage.completed`; render has no
 * events of its own and runs from analyze's completion to `project.done` / `project.failed`.
 */
import { useEffect, useState } from "react";
import type { ProjectEvent } from "@reelsaw/shared";

export interface StageTime {
  startedAt: number;
  completedAt?: number;
}
export type StageTimes = Record<string, StageTime>;

export function stageTimes(log: ProjectEvent[]): StageTimes & { createdAt?: number; finishedAt?: number } {
  const out: StageTimes & { createdAt?: number; finishedAt?: number } = {};
  for (const e of log) {
    const stage = (e.payload as { stage?: unknown }).stage;
    const t = new Date(e.createdAt).getTime();
    if (e.type === "project.created") out.createdAt = t;
    if (e.type === "project.done" || e.type === "project.failed") out.finishedAt = t;
    if (typeof stage !== "string" || stage === "review") continue;
    if (e.type === "stage.started") {
      // a retried stage starts over; keep the latest run
      if (!out[stage] || out[stage]!.completedAt !== undefined) out[stage] = { startedAt: t };
    } else if (e.type === "stage.completed" && out[stage]) out[stage]!.completedAt = t;
  }
  if (out.analyze?.completedAt !== undefined && !out.render) out.render = { startedAt: out.analyze.completedAt, completedAt: out.finishedAt };
  return out;
}

/**
 * Seconds each `stage.completed` / `project.done` / `project.failed` event took, walked in log order so
 * a stage that ran several times (retry, refine or re-analyze later) gets each run's own duration, and
 * "All done" counts from the start of the run that just finished (project creation, or the first stage,
 * re-render or retry after the previous finish), not from the project's creation every time.
 */
/** Events that begin work on an idle project without a `stage.started` of their own (re-render, retry, a clip added by hand). */
const RUN_STARTERS = new Set(["clip.rendering", "clip.retrying", "clip.created"]);

export function eventDurations(log: ProjectEvent[]): Map<ProjectEvent, number> {
  const out = new Map<ProjectEvent, number>();
  const started: Record<string, number> = {};
  let runStart: number | undefined;
  let idle = true;
  for (const e of log) {
    const t = new Date(e.createdAt).getTime();
    const stage = (e.payload as { stage?: unknown }).stage;
    if (e.type === "project.created") {
      runStart = t;
      idle = false;
    } else if (e.type === "stage.started" && typeof stage === "string") {
      if (idle) {
        runStart = t;
        idle = false;
      }
      started[stage] = t;
    } else if (idle && RUN_STARTERS.has(e.type)) {
      // a re-render, retry or new clip after "All done" is a run of its own: the idle hours before it don't count
      runStart = t;
      idle = false;
    } else if (e.type === "stage.completed" && typeof stage === "string" && started[stage] !== undefined) {
      out.set(e, (t - started[stage]!) / 1000);
    } else if (e.type === "project.done" || e.type === "project.failed") {
      if (runStart !== undefined) out.set(e, (t - runStart) / 1000);
      idle = true;
    }
  }
  return out;
}

/** A once-a-second clock while `running`, frozen otherwise, for elapsed counters. */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return now;
}
