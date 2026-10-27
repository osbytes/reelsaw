/**
 * Retention: delete stored sources / rendered clips older than SOURCE_RETENTION_DAYS /
 * CLIP_RETENTION_DAYS (0 = off). Rows stay, with a timestamp and an event, so the project still
 * reads as history. Re-rendering a clip brings its file back; an expired source is fetched again by
 * the project's Retry (clips cannot be re-rendered until then). Runs from the reconciler.
 */
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { schema } from "./db/index.js";
import type { Services } from "./services.js";
import { removeScratchClip, removeScratchSource } from "./storage/sweep.js";
import { deadlineIn, keysetLoop } from "./lib/batch.js";

export const RETENTION_BATCH = 200;
export const RETENTION_BUDGET_MS = 30_000; // per kind and tick; the backlog continues next tick (updated_at/id order is stable)
type Cur = { at: string; id: string };

export async function sweepRetention(svc: Services): Promise<{ sources: number; clips: number }> {
  const config = svc.settings.get(); // the days in force now (environment or admin override)
  const log = svc.log.child({ module: "retention" });
  let sources = 0;
  let clips = 0;
  if (config.SOURCE_RETENTION_DAYS > 0) {
    const cutoff = new Date(Date.now() - config.SOURCE_RETENTION_DAYS * 86_400_000);
    // keyset over (updated_at, id), 200 per batch, until a short batch or the time budget; the timestamp travels as text (microseconds)
    await keysetLoop<{ id: string; sourceKey: string; at: string }, Cur>({
      size: RETENTION_BATCH,
      deadline: deadlineIn(RETENTION_BUDGET_MS),
      start: null,
      fetch: async (cur, size) => {
        const res = await svc.database.db.execute(sql`
          select id, source_key as "sourceKey", updated_at::text as at from projects
          where source_key is not null and source_expired_at is null and deleted_at is null and updated_at < ${cutoff.toISOString()}::timestamptz and status in ('done', 'failed')
            ${cur ? sql`and (updated_at, id) > (${cur.at}::timestamptz, ${cur.id})` : sql``}
          order by updated_at, id limit ${size}`);
        return res.rows as Array<{ id: string; sourceKey: string; at: string }>;
      },
      cursorOf: (r) => ({ at: r.at, id: r.id }),
      handle: async (rows) => {
        for (const p of rows) {
          await svc.tx(async (u) => {
            const [cur] = await u.db.update(schema.projects).set({ sourceExpiredAt: new Date(), sourceBytes: null }).where(and(eq(schema.projects.id, p.id), isNull(schema.projects.sourceExpiredAt), isNull(schema.projects.deletedAt), eq(schema.projects.sourceKey, p.sourceKey), inArray(schema.projects.status, ["done", "failed"]), lt(schema.projects.updatedAt, cutoff))).returning({ id: schema.projects.id });
            if (!cur) return;
            await u.emit(p.id, "source.expired", { days: config.SOURCE_RETENTION_DAYS });
            u.afterCommit(async () => {
              await svc.storage.delete(p.sourceKey).catch((err) => log.warn({ err, projectId: p.id }, "source delete failed"));
              await removeScratchSource(svc, p.id); // the local store hardlinks it: without this no disk is freed
            });
            sources++;
          });
        }
      },
    });
  }
  if (config.CLIP_RETENTION_DAYS > 0) {
    const cutoff = new Date(Date.now() - config.CLIP_RETENTION_DAYS * 86_400_000);
    await keysetLoop<{ id: string; projectId: string; outputKey: string; thumbnailKey: string | null; at: string }, Cur>({
      size: RETENTION_BATCH,
      deadline: deadlineIn(RETENTION_BUDGET_MS),
      start: null,
      fetch: async (cur, size) => {
        const res = await svc.database.db.execute(sql`
          select id, project_id as "projectId", output_key as "outputKey", thumbnail_key as "thumbnailKey", updated_at::text as at from clips
          where output_key is not null and status = 'done' and deleted_at is null and updated_at < ${cutoff.toISOString()}::timestamptz
            ${cur ? sql`and (updated_at, id) > (${cur.at}::timestamptz, ${cur.id})` : sql``}
          order by updated_at, id limit ${size}`);
        return res.rows as Array<{ id: string; projectId: string; outputKey: string; thumbnailKey: string | null; at: string }>;
      },
      cursorOf: (r) => ({ at: r.at, id: r.id }),
      handle: async (rows) => {
        const byProject = new Map<string, typeof rows>();
        for (const r of rows) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
        for (const [projectId, list] of byProject) {
          await svc.tx(async (u) => {
            for (const c of list) {
              const [cur] = await u.db.update(schema.clips).set({ outputKey: null, thumbnailKey: null, updatedAt: new Date() }).where(and(eq(schema.clips.id, c.id), eq(schema.clips.outputKey, c.outputKey))).returning({ id: schema.clips.id });
              if (!cur) continue;
              // the store object and the scratch copy: the local store hardlinks them, so both must go to free disk
              u.afterCommit(async () => {
                for (const key of [c.outputKey, c.thumbnailKey]) {
                  if (!key) continue;
                  await svc.storage.delete(key).catch((err) => log.warn({ err, clipId: c.id }, "clip delete failed"));
                  await removeScratchClip(svc, projectId, key);
                }
              });
              clips++;
            }
            await u.emit(projectId, "clips.expired", { clips: list.length, days: config.CLIP_RETENTION_DAYS });
          });
        }
      },
    });
  }
  if (sources || clips) log.info({ sources, clips }, "retention sweep removed files");
  return { sources, clips };
}
