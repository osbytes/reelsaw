/**
 * A project's ranges (docs/specs/range-clipping.md) as every surface shows them: get_project, the project page, the
 * CLI, and the range a clip and its webhooks name.
 */
import { asc, eq } from "drizzle-orm";
import { msg } from "@lingui/core/runtime-macro";
import type { MessageDescriptor } from "@lingui/core";
import { formatTime, type RangeProblem } from "@reelsaw/shared";
import { AppError, t } from "../i18n.js";
import { type Db, schema } from "../db/index.js";
import type { ProjectRange } from "../db/schema.js";

/** A project's ranges in source order. */
export function projectRangesOf(db: Db, projectId: string): Promise<ProjectRange[]> {
  return db.select().from(schema.projectRanges).where(eq(schema.projectRanges.projectId, projectId)).orderBy(asc(schema.projectRanges.startSec));
}

/** One range as get_project returns it. `picked`: moments were picked in it (or its exact clip made). */
export function publicRange(r: ProjectRange) {
  return {
    id: r.id,
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
