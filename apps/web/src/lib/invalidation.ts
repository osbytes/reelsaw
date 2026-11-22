/**
 * Which cached query a project event makes stale. One table, so an event never refetches more than
 * it changed: a clip finishing re-reads the clips, never the transcript (megabytes on a long source).
 * Pure, so it can be read and tested without React.
 *
 *   project    projects.get       the project, its clips, estimates and bumpers
 *   transcript transcripts.get    words, segments, flags, overlays
 *   list       projects.list and projects.stats (the Projects page and its header counts), and the
 *              command palette's project rows (searchIndex, search), which show the same status and counts
 */
import type { ProjectEventType } from "@reelsaw/shared";

export type Scope = "project" | "transcript" | "list";
type Payload = Record<string, unknown>;
type Rule = Scope[] | ((p: Payload) => Scope[]);

/** Stages whose completion changes the transcript (it appears, or refine merges its flags). */
const TRANSCRIPT_STAGES = new Set(["transcribe", "refine"]);

export const INVALIDATION: Record<ProjectEventType, Rule> = {
  "project.created": ["project", "list"],
  "run.started": ["project", "list"],
  // "review" is a saved transcript edit (its re-renders show up as clips)
  "stage.started": (p) => (p["stage"] === "review" ? (p["rerendered"] ? ["transcript", "project", "list"] : ["transcript"]) : ["project", "list"]),
  // progress is live state only
  "stage.progress": [],
  "stage.completed": (p) => (TRANSCRIPT_STAGES.has(String(p["stage"])) ? ["project", "list", "transcript"] : ["project", "list"]),
  "stage.failed": ["project", "list"],
  "clip.created": ["project", "list"],
  "clip.rendering": ["project"],
  "clip.done": ["project", "list"],
  "clip.failed": ["project", "list"],
  "clip.retrying": ["project"],
  "clip.capacity_wait": [],
  "clip.bumper_skipped": ["project"],
  "clip.overlay_skipped": ["project"],
  "clip.cut_unverified": ["project"],
  "source.section_fetched": [],
  "clip.preview_source": ["project"],
  "language.degraded": [],
  "job.stalled": [],
  "source.expired": ["project"],
  "source.partial": ["project", "list"],
  "project.extended": ["project", "list"],
  "clips.expired": ["project", "list"],
  "project.deleted": ["project", "list"],
  "project.restored": ["project", "list"],
  "clip.restored": ["project", "list"],
  "clip.deleted": ["project", "list"],
  "project.updated": ["project", "list"],
  "transcript.imported": ["project", "list", "transcript"],
  "project.done": ["project", "list"],
  "project.failed": ["project", "list"],
};

export function scopesFor(e: { type: ProjectEventType; payload: Payload }): Scope[] {
  const rule = INVALIDATION[e.type];
  return typeof rule === "function" ? rule(e.payload) : rule;
}

/**
 * True for every query that lists projects with their status and clip counts: projects.list and
 * projects.stats, and the palette's searchIndex and search (tRPC keys start with the procedure path).
 * A list view of projects that is left out here shows a stale status until its own cache expires.
 */
export function isListKey(key: readonly unknown[]): boolean {
  const path = key[0];
  if (!Array.isArray(path)) return false;
  if (path[0] === "searchIndex" || path[0] === "search") return true;
  return path[0] === "projects" && (path[1] === "list" || path[1] === "stats");
}
