import type { ProjectEvent } from "@reelsaw/shared";

const STAGE: Record<string, string> = { ingest: "Download", transcribe: "Transcription", refine: "Refine", analyze: "Finding moments", render: "Rendering", review: "Applying fixes" };
const STEP: Record<string, string> = { entities: "names", disfluency: "disfluencies", scenes: "scene changes", overlays: "on-screen text" };

export type Tone = "ok" | "run" | "warn" | "err";

/** Event log in plain sentences. Raw payloads stay in the CLI (`reelsaw events`). */
export function describeEvent(e: ProjectEvent): { text: string; tone: Tone } | null {
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
      return { text: `${STAGE[String(p.stage)] ?? p.stage} ${p.retried ? "restarted" : "started"}`, tone: "run" };
    case "stage.completed":
      return { text: `${STAGE[String(p.stage)] ?? p.stage} finished`, tone: "ok" };
    case "stage.failed":
      return { text: `${STAGE[String(p.stage)] ?? p.stage} failed (attempt ${p.attempt} of ${p.max}): ${p.error}`, tone: "err" };
    case "project.failed":
      return { text: `Stopped: ${p.error}`, tone: "err" };
    case "project.done":
      return { text: `All done: ${p.clips} clip${p.clips === 1 ? "" : "s"} ready${p.failed ? `, ${p.failed} failed` : ""}`, tone: "ok" };
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
    case "job.stalled":
      return { text: `No progress for ${p.idleMinutes} min. ${p.hint ?? ""}`, tone: "warn" };
    default:
      return null;
  }
}
