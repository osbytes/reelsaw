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
