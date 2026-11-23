/**
 * A project's ranges (docs/specs/range-clipping.md) as every surface shows them: get_project, the project page, the
 * CLI, and the range a clip and its webhooks name.
 */
import { asc, eq, inArray } from "drizzle-orm";
import { msg } from "@lingui/core/runtime-macro";
import type { MessageDescriptor } from "@lingui/core";
import { formatTime, rangeCoverage, spansSec, transcriptSpans, type RangeCoverage, type RangeProblem } from "@reelsaw/shared";
import { AppError, t } from "../i18n.js";
import { type Db, schema } from "../db/index.js";
import type { ProjectRange } from "../db/schema.js";

/** A project's ranges in source order. */
export function projectRangesOf(db: Db, projectId: string): Promise<ProjectRange[]> {
  return db.select().from(schema.projectRanges).where(eq(schema.projectRanges.projectId, projectId)).orderBy(asc(schema.projectRanges.startSec));
}

/**
 * How much of its video each of these projects processes, for list rows (Projects page, ⌘K, list_projects): one query
 * over the page's ids. A project missing from the map processes all of its video (`rangeCoverage`).
 */
export async function coverageOf(db: Db, projects: ReadonlyArray<{ id: string; durationSec: number | null }>): Promise<Map<string, RangeCoverage>> {
  const ids = projects.filter((p) => p.durationSec).map((p) => p.id);
  if (!ids.length) return new Map();
  const R = schema.projectRanges;
  const rows = await db.select({ projectId: R.projectId, startSec: R.startSec, endSec: R.endSec, origin: R.origin }).from(R).where(inArray(R.projectId, ids));
  const byProject = new Map<string, typeof rows>();
  for (const r of rows) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
  const out = new Map<string, RangeCoverage>();
  for (const p of projects) {
    const c = rangeCoverage(byProject.get(p.id) ?? [], p.durationSec);
    if (c) out.set(p.id, c);
  }
  return out;
}

/**
 * Seconds of source each project actually transcribes and analyzes: its ranges with their context padding, or the
 * whole length when it has no ranges. What the stage time estimates scale by (pipeline/estimates.ts), so a project of
 * three short ranges of a long video is neither expected to take as long as the video nor teaches the estimates that
 * stages are that fast per second of video.
 */
export async function processedSecOf(db: Db, projects: ReadonlyArray<{ id: string; durationSec: number | null }>): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = projects.filter((p) => p.durationSec).map((p) => p.id);
  if (!ids.length) return out;
  const R = schema.projectRanges;
  const rows = await db.select({ projectId: R.projectId, startSec: R.startSec, endSec: R.endSec, origin: R.origin }).from(R).where(inArray(R.projectId, ids));
  for (const p of projects) {
    if (!p.durationSec) continue;
    const mine = rows.filter((r) => r.projectId === p.id);
    out.set(p.id, mine.length ? Math.min(p.durationSec, spansSec(transcriptSpans(mine, p.durationSec))) : p.durationSec);
  }
  return out;
}

/**
 * A project's ranges as get_project returns them, in source order. `number` is the range's number on every surface (1,
 * 2, … in the order they were added, then by time), so a range added later never renumbers the ones before it;
 * null for a `whole` part.
 */
export function publicRanges(rows: readonly ProjectRange[]) {
  const numbered = rows.filter((r) => r.origin !== "whole").sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.startSec - b.startSec);
  const number = new Map(numbered.map((r, i) => [r.id, i + 1]));
  return rows.map((r) => publicRange(r, number.get(r.id) ?? null));
}

/** One range as get_project returns it. `picked`: moments were picked in it (or its exact clip made). */
function publicRange(r: ProjectRange, number: number | null) {
  return {
    id: r.id,
    number,
    startSec: r.startSec,
    endSec: r.endSec,
    mode: r.mode,
    origin: r.origin,
    label: r.label,
    ref: r.ref,
    billedSec: r.billedSec,
    picked: r.pickedAt !== null,
  };
}

/** What a clip's events and webhooks say about the range it came from: its id and the caller's `ref`, when it has them. */
export async function rangeTag(db: Db, rangeId: string | null): Promise<{ rangeId?: string; ref?: string }> {
  if (!rangeId) return {};
  const [r] = await db.select({ ref: schema.projectRanges.ref }).from(schema.projectRanges).where(eq(schema.projectRanges.id, rangeId));
  return { rangeId, ...(r?.ref ? { ref: r.ref } : {}) };
}

/** What is wrong with a requested range, as a catalogue message (the planner says which, `planRanges`). */
function rangeProblem(p: RangeProblem): MessageDescriptor {
  switch (p.kind) {
    case "none":
      return msg({ id: "ranges.none", message: "Give at least one range." });
    case "too_many": {
      const { count, max } = p;
      return msg({ id: "ranges.too_many", message: msg`${{ count }} ranges were given; at most ${{ max }} fit one request.` });
    }
    case "end_before_start": {
      const n = p.input + 1;
      return msg({ id: "ranges.end_before_start", message: msg`Range ${{ n }} ends before it starts.` });
    }
    case "past_end": {
      const n = p.input + 1;
      const end = formatTime(p.durationSec);
      return msg({ id: "ranges.past_end", message: msg`Range ${{ n }} starts after the video ends (${{ end }}).` });
    }
    case "too_short": {
      const n = p.input + 1;
      const min = p.minSec;
      return msg({ id: "ranges.too_short", message: msg`Range ${{ n }} is shorter than ${{ min }} seconds.` });
    }
  }
}

/** Every problem, a sentence each, in the reader's locale (check_source's `problems`, a failed ingest's reason). */
export function rangeProblemsText(problems: readonly RangeProblem[]): string[] {
  return problems.map((p) => t(rangeProblem(p)));
}

/** The refusal of a request whose ranges cannot be ranges: the first problem's code, every problem's sentence. */
export function rangesRefused(problems: readonly RangeProblem[]): AppError {
  const [first] = problems;
  if (problems.length === 1 && first) return new AppError("BAD_REQUEST", rangeProblem(first));
  const sentences = rangeProblemsText(problems).join(" ");
  return new AppError("BAD_REQUEST", msg({ id: "ranges.refused", message: msg`${{ sentences }}` }));
}
