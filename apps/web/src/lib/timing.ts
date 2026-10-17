/**
 * Live clock for the stage that is running now ("elapsed / expected" in the header). Finished
 * durations are never computed here: the server writes them into event payloads (`durationSec`,
 * `runSec`). Only the running stage needs timestamps, and they are explicit: `run.started` opens a
 * run and `stage.started` a stage.
 */
import { useEffect, useState } from "react";
import type { ProjectEvent } from "@reelsaw/shared";

export interface StageTime {
  startedAt: number;
}

/** Start time of each stage in the latest run; render has no events of its own and starts when analyze finishes (or with the run). */
export function stageTimes(log: ProjectEvent[]): Record<string, StageTime> {
  let out: Record<string, StageTime> = {};
  let runStart: number | undefined;
  let analyzed: number | undefined;
  for (const e of log) {
    const t = new Date(e.createdAt).getTime();
    const stage = (e.payload as { stage?: unknown }).stage;
    if (e.type === "run.started" || (e.type === "project.created" && runStart === undefined)) {
      out = {};
      analyzed = undefined;
      runStart = t;
    } else if (e.type === "stage.started" && typeof stage === "string" && stage !== "review") out[stage] = { startedAt: t };
    else if (e.type === "stage.completed" && stage === "analyze") analyzed = t;
  }
  if (!out.render && (analyzed ?? runStart) !== undefined) out.render = { startedAt: (analyzed ?? runStart)! };
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
