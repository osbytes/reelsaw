/**
 * A project's ranges (docs/specs/range-clipping.md) as every surface shows them: get_project, the project page, the
 * CLI, and the range a clip and its webhooks name.
 */
import { asc, eq } from "drizzle-orm";
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
