import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import type { UnitOfWork } from "../uow.js";
import { chunk, deadlineIn, keysetLoop, mapLimit } from "../lib/batch.js";

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

/** An upload nobody turned into a project within this long was abandoned (the browser closed, the API client gave up). */
export const UPLOAD_ABANDON_MS = 24 * 60 * 60_000;
const UPLOAD_BATCH = 200;
const UPLOAD_BUDGET_MS = 30_000;

/** The id an uploads-directory file belongs to: `<id><ext>`, or `<id><ext>.part`. */
const fileUploadId = (name: string) => name.split(".")[0]!;

/** Files in the uploads directory that are old enough to be leftovers and have no `uploads` row. Pure. */
export function orphanUploadFiles(files: Array<{ name: string; mtimeMs: number }>, knownIds: ReadonlySet<string>, now: number): string[] {
  return files.filter((f) => now - f.mtimeMs >= UPLOAD_ABANDON_MS && !knownIds.has(fileUploadId(f.name))).map((f) => f.name);
}

const uploadRow = z.object({ id: z.string(), at: z.string() });

/**
 * Reclaims uploads nothing came of: rows older than 24 h that no project names as its input (the library copies
 * an upload and a transcript import consumes it, so a project is the only holder), with their store objects, and
 * files in the uploads directory with no row. Rows go first, objects after commit.
 */
export async function sweepAbandonedUploads(svc: Services, opts: { now?: number } = {}): Promise<{ rows: number; files: number }> {
  const now = opts.now ?? Date.now();
  const log = svc.log.child({ module: "uploads" });
  const cutoff = new Date(now - UPLOAD_ABANDON_MS);
  const named = sql`select source_meta->>'uploadId' from projects where source_meta->>'uploadId' is not null`;
  let rows = 0;
  type Cur = { at: string; id: string };
  await keysetLoop<{ id: string; at: string }, Cur>({
    size: UPLOAD_BATCH,
    deadline: deadlineIn(UPLOAD_BUDGET_MS),
    start: null,
    fetch: async (cur, size) => {
      const res = await svc.database.db.execute(sql`
        select u.id as id, u.created_at::text as at from uploads u
        where u.created_at < ${cutoff.toISOString()}::timestamptz and u.id not in (${named})
          ${cur ? sql`and (u.created_at, u.id) > (${cur.at}::timestamptz, ${cur.id})` : sql``}
        order by u.created_at, u.id limit ${size}`);
      return res.rows.map((r) => uploadRow.parse(r));
    },
    cursorOf: (r) => ({ at: r.at, id: r.id }),
    handle: async (batch) => {
      for (const { id } of batch) {
        await svc.tx(async (u) => {
          // re-checked in the deleting statement: a project created from it a moment ago keeps it
          const gone = await u.db.execute(sql`delete from uploads where id = ${id} and id not in (${named}) returning storage_key as "storageKey"`);
          const storageKey = gone.rows[0]?.storageKey;
          if (typeof storageKey !== "string") return;
          rows++;
          u.afterCommit(async () => {
            await svc.storage.delete(storageKey).catch((err) => log.warn({ err, uploadId: id }, "could not delete an abandoned upload object"));
            await fs.rm(path.join(svc.paths.uploads, `${id}${path.extname(storageKey)}`), { force: true }).catch(() => {});
          });
        });
      }
    },
  });
  // files in the uploads directory with no row: a crash between the write and the insert
  let files = 0;
  const entries = (await fs.readdir(svc.paths.uploads, { withFileTypes: true }).catch(() => [])).filter((e) => e.isFile());
  const stats = await mapLimit(entries, 16, async (e) => {
    const st = await fs.stat(path.join(svc.paths.uploads, e.name)).catch(() => null);
    return st ? { name: e.name, mtimeMs: st.mtimeMs } : null;
  });
  const old = stats.filter((s): s is { name: string; mtimeMs: number } => s !== null && now - s.mtimeMs >= UPLOAD_ABANDON_MS);
  for (const batch of chunk(old, 1000)) {
    const known = await svc.database.pool.query<{ id: string }>(`select id from uploads where id = any($1::text[])`, [batch.map((s) => fileUploadId(s.name))]);
    for (const name of orphanUploadFiles(batch, new Set(known.rows.map((r) => r.id)), now)) {
      await fs.rm(path.join(svc.paths.uploads, name), { force: true }).then(() => files++, () => {});
    }
  }
  if (rows || files) log.info({ rows, files }, "removed abandoned uploads");
  return { rows, files };
}
