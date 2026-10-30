/**
 * Bounds for jsonb that grows with use: the live `deleted_flags` list (overflow goes to
 * stage_artifacts, still restorable), clip render diagnostics, and "write only what changed" for
 * transcript edits.
 *
 * Transcript words/segments are still one jsonb value per row. Chunked transcript storage (read and
 * write only the window a flag touches) is Phase 2 of docs/specs/scale.md; until then edits lock the
 * row and write back just the columns that really changed.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "./db/index.js";
import type { ClipDiagnostics } from "@reelsaw/shared";

export const DELETED_FLAGS_LIVE_CAP = 200;
export const ARCHIVE_KIND = "deleted_flags";

/** Newest `cap` stay live; the older ones are returned as overflow to archive. */
export function splitDeleted<T>(list: T[], cap = DELETED_FLAGS_LIVE_CAP): { keep: T[]; overflow: T[] } {
  return list.length <= cap ? { keep: list, overflow: [] } : { keep: list.slice(-cap), overflow: list.slice(0, list.length - cap) };
}

/** Archive overflowed deleted flags (same transaction as the edit that pushed them out). */
export async function archiveDeletedFlags(db: Db, projectId: string, overflow: unknown[]): Promise<void> {
  if (!overflow.length) return;
  await db.insert(schema.stageArtifacts).values({ projectId, stage: "review", kind: ARCHIVE_KIND, data: overflow, models: {} });
}

/** Find a flag in the archive and remove it from there (it is about to become live again). */
export async function takeArchivedFlag<T extends { id: string }>(db: Db, projectId: string, flagId: string): Promise<T | undefined> {
  const [row] = await db
    .select({ id: schema.stageArtifacts.id, data: schema.stageArtifacts.data })
    .from(schema.stageArtifacts)
    .where(
      and(
        eq(schema.stageArtifacts.projectId, projectId),
        eq(schema.stageArtifacts.kind, ARCHIVE_KIND),
        sql`${schema.stageArtifacts.data} @> ${JSON.stringify([{ id: flagId }])}::jsonb`,
      ),
    )
    .orderBy(desc(schema.stageArtifacts.id))
    .limit(1)
    .for("update");
  if (!row) return undefined;
  const list = row.data as T[];
  const found = list.find((f) => f.id === flagId);
  if (!found) return undefined;
  const rest = list.filter((f) => f !== found);
  if (rest.length) await db.update(schema.stageArtifacts).set({ data: rest }).where(eq(schema.stageArtifacts.id, row.id));
  else await db.delete(schema.stageArtifacts).where(eq(schema.stageArtifacts.id, row.id));
  return found;
}

/** The subset of `next` whose JSON differs from `current`: those are the only columns worth writing. */
export function changedColumns<T extends Record<string, unknown>>(current: Partial<T>, next: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(next) as Array<keyof T>) {
    if (JSON.stringify(current[k]) !== JSON.stringify(next[k])) out[k] = next[k];
  }
  return out;
}

export const DIAGNOSTICS_LIST_CAP = 20;
export const DIAGNOSTICS_ERROR_CHARS = 1500;
const lastN = <T>(a: T[], n = DIAGNOSTICS_LIST_CAP) => (a.length > n ? a.slice(-n) : a);

/** Bound a clip's render diagnostics: skipped lists keep the last 20 entries, error strings 1,500 chars. */
export function capDiagnostics(d: ClipDiagnostics): ClipDiagnostics {
  return {
    ...d,
    cuts: {
      ...d.cuts,
      skipped: lastN(d.cuts.skipped).map((s) => ({ ...s, reason: s.reason.slice(0, DIAGNOSTICS_ERROR_CHARS) })),
    },
    ...(d.bumpers?.skipped ? { bumpers: { ...d.bumpers, skipped: lastN(d.bumpers.skipped).map((s) => s.slice(0, DIAGNOSTICS_ERROR_CHARS)) } } : {}),
  };
}
