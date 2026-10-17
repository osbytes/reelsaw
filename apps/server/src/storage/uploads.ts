import { and, eq, ne, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";

/**
 * Drop an upload (row now, object after commit) once no project still needs it as its input.
 * Any other project that references the upload keeps it, stored source or not (Retry restores an
 * expired source from it). Called when a project is deleted (ingest keeps
 * the upload so an expired source can be restored by Retry). Safe to call when the upload is already gone.
 */
export async function releaseUpload(svc: Services, u: UnitOfWork, projectId: string, uploadId: unknown) {
  if (typeof uploadId !== "string" || !uploadId) return;
  const [stillNeeded] = await u.db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(ne(schema.projects.id, projectId), sql`${schema.projects.sourceMeta}->>'uploadId' = ${uploadId}`))
    .limit(1);
  if (stillNeeded) return;
  const [row] = await u.db.delete(schema.uploads).where(eq(schema.uploads.id, uploadId)).returning({ storageKey: schema.uploads.storageKey });
  if (row) {
    const log = svc.log.child({ module: "uploads", projectId, uploadId });
    u.afterCommit(() => svc.storage.delete(row.storageKey).catch((err) => log.warn({ err }, "could not delete the upload object")));
  }
}
