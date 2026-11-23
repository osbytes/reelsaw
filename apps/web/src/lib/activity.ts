import { formatNumber, formatTime, languageLabel, type ProjectEvent } from "@reelsaw/shared";
import { plural, t } from "@lingui/core/macro";
import { summarizeError } from "./errors";

/** Stage, step and run-reason names in the active locale (read when a line is written, never at module load). */
const stageName = (stage: unknown): string => {
  const names: Record<string, string> = {
    prepare: t`Clip preparation`,
    ingest: t`Preparing source`,
    transcribe: t`Transcription`,
    refine: t`Refine`,
    analyze: t`Finding moments`,
    render: t`Rendering`,
    review: t`Applying fixes`,
  };
  return names[String(stage)] ?? String(stage);
};
const stepName = (step: string): string => {
  const names: Record<string, string> = { entities: t`names`, disfluency: t`disfluencies`, scenes: t`scene changes`, overlays: t`on-screen text` };
  return names[step] ?? step;
};
export type Tone = "ok" | "run" | "warn" | "err";

export const reasonLabel = (r: unknown) => {
  if (typeof r !== "string") return null;
  const names: Record<string, string> = {
    created: t`new project`,
    retry: t`retry`,
    rerender: t`re-render`,
    refine: t`refine`,
    reanalyze: t`re-analyze`,
    clip_added: t`clip added`,
    extend: t`clipping more of the video`,
  };
  return names[r] ?? r;
};
const sec = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export type DescribeOpts = {
  expectedSec?: (stage: string) => number | null;
  /** Admins see env-key / ops hints in failure lines; everyone else gets user-safe copy. */
  admin?: boolean;
};

/** Event log in plain sentences. Raw payloads stay in the CLI (`reelsaw events`). */
/** `expectedSec` (per stage) adds "(expected ~4:00)" to a finished stage. */
export function describeEvent(e: ProjectEvent, opts?: DescribeOpts | ((stage: string) => number | null)): { text: string; tone: Tone } | null {
  // older callers passed `expectedSec` as the second arg; keep that working
  const o: DescribeOpts = typeof opts === "function" ? { expectedSec: opts } : (opts ?? {});
  const errText = (v: unknown) => (typeof v === "string" && v.trim() ? summarizeError(v, { admin: o.admin }).summary : t`Something went wrong`);
  const p = e.payload as Record<string, unknown>;
  const n = typeof p["index"] === "number" ? p["index"] + 1 : null;
  const clip = n !== null ? t`Clip ${n}` : t`A clip`;
  const title = typeof p["title"] === "string" ? p["title"] : "";
  const reason = String(p["reason"] ?? "");
  const stage = stageName(p["stage"]);
  switch (e.type) {
    case "project.created":
      return { text: title ? t`Project created: “${title}”` : t`Project created`, tone: "ok" };
    case "source.partial": {
      const until = sec(p["untilSec"]);
      const total = sec(p["durationSec"]);
      if (until === null || total === null) return null;
      const why = p["reason"] === "first_video" ? t`your first video's free minutes` : t`the minutes left on your plan`;
      const untilMin = Math.round(until / 60);
      const totalMin = Math.round(total / 60);
      return { text: t`Clipping the first ${untilMin} of ${totalMin} minutes (${why}). Clip the rest any time.`, tone: "warn" };
    }
    case "project.extended": {
      const from = sec(p["fromSec"]);
      const until = sec(p["untilSec"]);
      if (from === null || until === null) return null;
      const fromMin = Math.round(from / 60);
      const untilMin = Math.round(until / 60);
      return {
        text: p["automatic"]
          ? t`Your plan changed: clipping minutes ${fromMin}–${untilMin}, keeping the clips you have`
          : t`Clipping minutes ${fromMin}–${untilMin}, keeping the clips you have`,
        tone: "run",
      };
    }
    case "stage.started": {
      // one-shot event: the fix is saved when it's emitted; only the re-renders are still running
      if (p["stage"] === "review")
        return p["rerendered"]
          ? {
              text: plural(Number(p["rerendered"]), { one: "Transcript updated, re-rendering # clip", other: "Transcript updated, re-rendering # clips" }),
              tone: "run",
            }
          : {
              text: p["changed"]
                ? plural(Number(p["changed"]), { one: "Transcript updated (# fix)", other: "Transcript updated (# fixes)" })
                : t`Transcript updated`,
              tone: "ok",
            };
      if (p["stage"] === "refine" && Array.isArray(p["steps"])) {
        const steps = (p["steps"] as string[]).map(stepName).join(", ");
        return { text: t`Refining: ${steps}`, tone: "run" };
      }
      if (p["stage"] === "analyze" && p["repick"] && typeof p["kept"] === "number" && p["kept"] > 0)
        return {
          text: plural(Number(p["kept"]), {
            one: "Finding new moments. Kept # clip you made or edited",
            other: "Finding new moments. Kept # clips you made or edited",
          }),
          tone: "run",
        };
      return { text: p["retried"] ? t`${stage} restarted` : t`${stage} started`, tone: "run" };
    }
    case "run.started": {
      const why = reasonLabel(p["reason"]);
      return p["reason"] === "created" || !why ? null : { text: t`Started: ${why}`, tone: "run" };
    }
    case "stage.completed": {
      const d = sec(p["durationSec"]);
      const exp = d !== null && o.expectedSec ? o.expectedSec(String(p["stage"])) : null;
      const took = d !== null ? formatTime(d) : "";
      const expected = exp ? formatTime(exp) : "";
      const done = d === null ? t`${stage} finished` : exp ? t`${stage} finished in ${took} (expected ~${expected})` : t`${stage} finished in ${took}`;
      if (p["stage"] === "transcribe" && typeof p["loops"] === "number" && p["loops"] > 0) {
        return {
          text: plural(Number(p["loops"]), {
            one: `${done}. Collapsed # looping stretch — review them on the transcript`,
            other: `${done}. Collapsed # looping stretches — review them on the transcript`,
          }),
          tone: "warn",
        };
      }
      return { text: done, tone: "ok" };
    }
    case "stage.failed": {
      const why = errText(p["error"]);
      // a refine step that gave up: optional work, the project went on without it
      if (p["final"] === true && typeof p["step"] === "string") {
        const step = p["step"];
        return { text: t`${stage} step "${step}" gave up, continuing without it: ${why}`, tone: "warn" };
      }
      const attempt = String(p["attempt"]);
      const max = String(p["max"]);
      return { text: t`${stage} failed (attempt ${attempt} of ${max}): ${why}`, tone: "err" };
    }
    case "project.failed": {
      const why = errText(p["error"]);
      return { text: t`Stopped: ${why}`, tone: "err" };
    }
    case "project.done": {
      const took = sec(p["runSec"]);
      const why = p["runReason"] === "created" ? null : reasonLabel(p["runReason"]);
      const tail = [p["failed"] ? t`, ${String(p["failed"])} failed` : "", took !== null ? t` in ${formatTime(took)}` : "", why ? ` · ${why}` : ""].join("");
      return { text: plural(Number(p["clips"]), { one: `All done: # clip ready${tail}`, other: `All done: # clips ready${tail}` }), tone: "ok" };
    }
    case "clip.created":
      return { text: t`Found a moment: “${title}”`, tone: "ok" };
    case "clip.rendering":
      return { text: t`Rendering a clip`, tone: "run" };
    case "clip.done":
      return { text: t`${clip} is ready`, tone: "ok" };
    case "clip.failed": {
      const why = errText(p["error"]);
      return { text: t`A clip failed to render: ${why}`, tone: "err" };
    }
    case "clip.retrying": {
      const step = String(p["step"]);
      const attempt = String(p["attempt"]);
      const max = String(p["max"]);
      return { text: t`Retrying ${step} (attempt ${attempt} of ${max}) after: ${reason}`, tone: "warn" };
    }
    case "clip.capacity_wait":
      return {
        text:
          p["bound"] === "reserve"
            ? t`${clip} is waiting for render capacity: the servers are busy with paid plans, it starts within a few minutes`
            : t`${clip} is waiting for render capacity: it starts when your other renders finish`,
        tone: "run",
      };
    case "clip.bumper_skipped":
      return {
        text: p["slot"] === "both" ? t`Intro and outro skipped: ${reason}` : p["slot"] === "outro" ? t`Outro skipped: ${reason}` : t`Intro skipped: ${reason}`,
        tone: "warn",
      };
    case "clip.overlay_skipped":
      return { text: t`Overlay skipped: ${reason}`, tone: "warn" };
    case "clip.cut_unverified": {
      const at = formatTime(Number(p["at"]));
      return { text: t`Applied your cut at ${at} without a seam check: the audio around it couldn't be matched`, tone: "warn" };
    }
    case "source.section_fetched": {
      const span = `${formatTime(Number(p["start"]))}–${formatTime(Number(p["end"]))}`;
      const height = String(p["height"]);
      const clips = typeof p["clips"] === "number" && p["clips"] > 1 ? p["clips"] : null;
      const newSec = formatNumber(Number(p["downloadedSec"] ?? 0), { maximumFractionDigits: 0 });
      const fetched = clips !== null ? t`Fetched ${span} of the source at ${height}p for ${clips} clips` : t`Fetched ${span} of the source at ${height}p`;
      return { text: p["stitched"] ? t`${fetched}, joining ${newSec} s of new video to what was already fetched` : fetched, tone: "ok" };
    }
    case "language.degraded": {
      const language = languageLabel(String(p["language"]));
      return { text: t`${language}: ${reason}`, tone: "warn" };
    }
    case "clip.preview_source": {
      const height = String(p["height"]);
      return { text: t`The full-quality video couldn't be fetched, so a clip rendered from the ${height}p preview: ${reason}`, tone: "warn" };
    }
    case "project.deleted": {
      const days = Number(p["days"]);
      return { text: plural(days, { one: "Project deleted (restorable for # day)", other: "Project deleted (restorable for # days)" }), tone: "warn" };
    }
    case "project.restored":
      return { text: t`Project restored`, tone: "ok" };
    case "clip.restored":
      return { text: title ? t`${clip} restored: “${title}”` : t`${clip} restored`, tone: "ok" };
    case "clip.deleted": {
      const days = Number(p["days"]);
      return {
        text: title
          ? plural(days, { one: `${clip} deleted: “${title}” (restorable for # day)`, other: `${clip} deleted: “${title}” (restorable for # days)` })
          : plural(days, { one: `${clip} deleted (restorable for # day)`, other: `${clip} deleted (restorable for # days)` }),
        tone: "warn",
      };
    }
    case "project.updated": {
      const changed = Array.isArray(p["changed"]) ? p["changed"].join(", ") : t`settings`;
      return { text: t`Project updated: ${changed}`, tone: "ok" };
    }
    case "transcript.imported": {
      const format = String(p["format"]).toUpperCase();
      const cues = String(p["cues"]);
      const words = String(p["words"]);
      const base = t`Transcript imported from a ${format} file (${cues} cues, ${words} words)`;
      return {
        text: Number(p["warnings"]) ? plural(Number(p["warnings"]), { one: `${base}, # warning`, other: `${base}, # warnings` }) : base,
        tone: "ok",
      };
    }
    case "job.stalled": {
      const hint = typeof p["hint"] === "string" ? p["hint"] : "";
      const idle = String(p["idleMinutes"]);
      return {
        text: typeof p["message"] === "string" ? `${p["message"]} ${hint}`.trim() : `${t`No progress for ${idle} min.`} ${hint}`.trim(),
        tone: "warn",
      };
    }
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
/** project.done for a run that rendered fewer clips than the project has: "Re-rendered 1 clip in 0:25 · 3 ready". */
function runDoneText(p: Record<string, unknown>, renderedThisRun: number, fallback: string): string {
  const total = Number(p["clips"]);
  if (p["runReason"] === "created" || !renderedThisRun || renderedThisRun >= total) return fallback;
  const took = sec(p["runSec"]);
  const why = reasonLabel(p["runReason"]);
  const tail = [
    took !== null ? t` in ${formatTime(took)}` : "",
    t` · ${total} ready`,
    p["failed"] ? t`, ${String(p["failed"])} failed` : "",
    why && p["runReason"] !== "rerender" ? ` · ${why}` : "",
  ].join("");
  return p["runReason"] === "rerender"
    ? plural(renderedThisRun, { one: `Re-rendered # clip${tail}`, other: `Re-rendered # clips${tail}` })
    : plural(renderedThisRun, { one: `Rendered # clip${tail}`, other: `Rendered # clips${tail}` });
}

export function groupByRun(log: ProjectEvent[], describe: (e: ProjectEvent) => Entry["d"] | null, olderExist = false): RunGroup[] {
  const explicit = log.some((e) => e.type === "run.started");
  const groups: RunGroup[] = [];
  let cur: RunGroup | null = null;
  const fresh = (seq: number, reason: string | null, startedAt: number): RunGroup => ({
    seq,
    reason,
    startedAt,
    outcome: "running",
    runSec: null,
    continued: false,
    entries: [],
  });
  for (const e of log) {
    if (e.type === "stage.progress") continue;
    const at = new Date(e.createdAt).getTime();
    const p = e.payload as Record<string, unknown>;
    const reason = typeof p["reason"] === "string" ? p["reason"] : null;
    if (e.type === "run.started") {
      if (cur?.entries.every((x) => x.e.type === "project.created")) {
        cur.seq = Number(p["seq"]) || cur.seq;
        cur.reason = reason;
      } else groups.push((cur = fresh(Number(p["seq"]) || groups.length + 1, reason, at)));
    } else if (!cur) {
      // a late event of a finished run (a stray clip event) stays with that run; otherwise this is an older log whose runs we can't see
      if (explicit && groups.length) {
        const d = describe(e);
        if (d) groups[groups.length - 1]!.entries.unshift({ e, d });
        continue;
      }
      groups.push((cur = fresh(groups.length + 1, e.type === "project.created" ? "created" : null, at)));
      // the loaded log begins inside a run whose start is on an older page
      if (olderExist && groups.length === 1 && e.type !== "project.created") cur.continued = true;
    }
    let d = describe(e);
    // a run that rendered only some clips (one re-render, a clip added) says how many it did: "3 clips ready in 0:25"
    // read as if all three took that long
    if (d && e.type === "project.done") d = { ...d, text: runDoneText(p, cur!.entries.filter((x) => x.e.type === "clip.done").length, d.text) };
    if (d) cur!.entries.unshift({ e, d });
    if (e.type === "project.done" || e.type === "project.failed") {
      cur!.outcome = e.type === "project.done" ? "done" : "failed";
      cur!.runSec = sec(p["runSec"]);
      cur = null;
    }
  }
  // a run cut off by the page boundary has no run.started to name it: number it from the run after it
  const first = groups[0];
  if (first?.continued) first.seq = groups[1] && groups[1].seq > 1 ? groups[1].seq - 1 : 0;
  return groups.reverse();
}
