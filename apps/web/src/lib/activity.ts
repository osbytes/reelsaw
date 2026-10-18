import { formatTime, type ProjectEvent } from "@reelsaw/shared";

const STAGE: Record<string, string> = { prepare: "Clip preparation", ingest: "Download", transcribe: "Transcription", refine: "Refine", analyze: "Finding moments", render: "Rendering", review: "Applying fixes" };
const STEP: Record<string, string> = { entities: "names", disfluency: "disfluencies", scenes: "scene changes", overlays: "on-screen text" };

export type Tone = "ok" | "run" | "warn" | "err";

const REASON: Record<string, string> = { created: "new project", retry: "retry", rerender: "re-render", refine: "refine", reanalyze: "re-analyze", clip_added: "clip added" };
export const reasonLabel = (r: unknown) => (typeof r === "string" ? (REASON[r] ?? r) : null);
const sec = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Event log in plain sentences. Raw payloads stay in the CLI (`reelsaw events`). */
/** `expectedSec` (per stage) adds "(expected ~4:00)" to a finished stage. */
export function describeEvent(e: ProjectEvent, expectedSec?: (stage: string) => number | null): { text: string; tone: Tone } | null {
  const p = e.payload as Record<string, unknown>;
  const clip = typeof p.index === "number" ? `Clip ${p.index + 1}` : "A clip";
  switch (e.type) {
    case "project.created":
      return { text: `Project created${p.title ? `: “${p.title}”` : ""}`, tone: "ok" };
    case "stage.started":
      // one-shot event: the fix is saved when it's emitted; only the re-renders are still running
      if (p.stage === "review")
        return p.rerendered
          ? { text: `Transcript updated, re-rendering ${p.rerendered} clip${p.rerendered === 1 ? "" : "s"}`, tone: "run" }
          : { text: p.changed ? `Transcript updated (${p.changed} fix${p.changed === 1 ? "" : "es"})` : "Transcript updated", tone: "ok" };
      if (p.stage === "refine" && Array.isArray(p.steps)) return { text: `Refining: ${(p.steps as string[]).map((s) => STEP[s] ?? s).join(", ")}`, tone: "run" };
      if (p.stage === "analyze" && p.repick && typeof p.kept === "number" && p.kept > 0) return { text: `Finding new moments. Kept ${p.kept} clip${p.kept === 1 ? "" : "s"} you made or edited`, tone: "run" };
      return { text: `${STAGE[String(p.stage)] ?? p.stage} ${p.retried ? "restarted" : "started"}`, tone: "run" };
    case "run.started": {
      const why = reasonLabel(p.reason);
      return p.reason === "created" || !why ? null : { text: `Started: ${why}`, tone: "run" };
    }
    case "stage.completed": {
      const d = sec(p.durationSec);
      const exp = d !== null && expectedSec ? expectedSec(String(p.stage)) : null;
      return { text: `${STAGE[String(p.stage)] ?? p.stage} finished${d !== null ? ` in ${formatTime(d)}${exp ? ` (expected ~${formatTime(exp)})` : ""}` : ""}`, tone: "ok" };
    }
    case "stage.failed":
      return { text: `${STAGE[String(p.stage)] ?? p.stage} failed (attempt ${p.attempt} of ${p.max}): ${p.error}`, tone: "err" };
    case "project.failed":
      return { text: `Stopped: ${p.error}`, tone: "err" };
    case "project.done": {
      const t = sec(p.runSec);
      const why = p.runReason === "created" ? null : reasonLabel(p.runReason);
      return { text: `All done: ${p.clips} clip${p.clips === 1 ? "" : "s"} ready${p.failed ? `, ${p.failed} failed` : ""}${t !== null ? ` in ${formatTime(t)}` : ""}${why ? ` · ${why}` : ""}`, tone: "ok" };
    }
    case "clip.created":
      return { text: `Found a moment: “${p.title}”`, tone: "ok" };
    case "clip.rendering":
      return { text: `Rendering a clip`, tone: "run" };
    case "clip.done":
      return { text: `${clip} is ready`, tone: "ok" };
    case "clip.failed":
      return { text: `A clip failed to render: ${p.error}`, tone: "err" };
    case "clip.retrying":
      return { text: `Retrying ${p.step} (attempt ${p.attempt} of ${p.max}) after: ${p.reason}`, tone: "warn" };
    case "clip.bumper_skipped":
      return { text: `${p.slot === "outro" ? "Outro" : "Intro"} skipped: ${p.reason}`, tone: "warn" };
    case "clip.cut_unverified":
      return { text: `Applied your cut at ${formatTime(Number(p.at))} without a seam check: the audio around it couldn't be matched`, tone: "warn" };
    case "project.deleted":
      return { text: `Project deleted (restorable for ${p.days} days)`, tone: "warn" };
    case "project.restored":
      return { text: "Project restored", tone: "ok" };
    case "clip.restored":
      return { text: `${clip} restored${p.title ? `: “${p.title}”` : ""}`, tone: "ok" };
    case "job.stalled":
      return { text: `No progress for ${p.idleMinutes} min. ${p.hint ?? ""}`, tone: "warn" };
    default:
      return null;
  }
}

export interface Entry {
  e: ProjectEvent;
  d: { text: string; tone: Tone };
}
export interface RunGroup {
  seq: number;
  reason: string | null;
  startedAt: number;
  outcome: "running" | "done" | "failed";
  /** seconds, from the run's finishing event; null while running or for runs from before durations were recorded */
  runSec: number | null;
  /** the log starts in the middle of this run: its first events are older than what is loaded */
  continued: boolean;
  /** newest first, like the feed */
  entries: Entry[];
}

/** Group the log by run (newest run first, entries newest first). A run starts at `run.started`; older logs start one at `project.created`. */
export function groupByRun(log: ProjectEvent[], describe: (e: ProjectEvent) => Entry["d"] | null, olderExist = false): RunGroup[] {
  const explicit = log.some((e) => e.type === "run.started");
  const groups: RunGroup[] = [];
  let cur: RunGroup | null = null;
  const fresh = (seq: number, reason: string | null, startedAt: number): RunGroup => ({ seq, reason, startedAt, outcome: "running", runSec: null, continued: false, entries: [] });
  for (const e of log) {
    if (e.type === "stage.progress") continue;
    const t = new Date(e.createdAt).getTime();
    const p = e.payload as Record<string, unknown>;
    const reason = typeof p.reason === "string" ? p.reason : null;
    if (e.type === "run.started") {
      if (cur && cur.entries.every((x) => x.e.type === "project.created")) {
        cur.seq = Number(p.seq) || cur.seq;
        cur.reason = reason;
      } else groups.push((cur = fresh(Number(p.seq) || groups.length + 1, reason, t)));
    } else if (!cur) {
      // a late event of a finished run (a stray clip event) stays with that run; otherwise this is an older log whose runs we can't see
      if (explicit && groups.length) {
        const d = describe(e);
        if (d) groups[groups.length - 1]!.entries.unshift({ e, d });
        continue;
      }
      groups.push((cur = fresh(groups.length + 1, e.type === "project.created" ? "created" : null, t)));
      // the loaded log begins inside a run whose start is on an older page
      if (olderExist && groups.length === 1 && e.type !== "project.created") cur.continued = true;
    }
    const d = describe(e);
    if (d) cur!.entries.unshift({ e, d });
    if (e.type === "project.done" || e.type === "project.failed") {
      cur!.outcome = e.type === "project.done" ? "done" : "failed";
      cur!.runSec = sec(p.runSec);
      cur = null;
    }
  }
  // a run cut off by the page boundary has no run.started to name it: number it from the run after it
  const first = groups[0];
  if (first?.continued) first.seq = groups[1] && groups[1].seq > 1 ? groups[1].seq - 1 : 0;
  return groups.reverse();
}
