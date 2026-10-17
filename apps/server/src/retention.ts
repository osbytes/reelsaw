/**
 * Retention: delete stored sources / rendered clips older than SOURCE_RETENTION_DAYS /
 * CLIP_RETENTION_DAYS (0 = off). Rows stay, with a timestamp and an event, so the project still
 * reads as history and "Retry" / "Re-render" bring the files back. Runs from the reconciler.
 */
import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { schema } from "./db/index.js";
import type { Services } from "./services.js";
import { removeScratchSource } from "./storage/sweep.js";

export async function sweepRetention(svc: Services): Promise<{ sources: number; clips: number }> {
  const { config } = svc;
  const log = svc.log.child({ module: "retention" });
  let sources = 0;
  let clips = 0;
  if (config.SOURCE_RETENTION_DAYS > 0) {
    const cutoff = new Date(Date.now() - config.SOURCE_RETENTION_DAYS * 86_400_000);
    const rows = await svc.database.db.query.projects.findMany({
      where: and(isNotNull(schema.projects.sourceKey), isNull(schema.projects.sourceExpiredAt), lt(schema.projects.updatedAt, cutoff), sql`${schema.projects.status} in ('done', 'failed')`),
      columns: { id: true, sourceKey: true },
      limit: 200,
    });
    for (const p of rows) {
      await svc.tx(async (u) => {
        const [cur] = await u.db.update(schema.projects).set({ sourceExpiredAt: new Date(), sourceBytes: null }).where(and(eq(schema.projects.id, p.id), isNull(schema.projects.sourceExpiredAt))).returning({ id: schema.projects.id });
        if (!cur) return;
        await u.emit(p.id, "source.expired", { days: config.SOURCE_RETENTION_DAYS });
        u.afterCommit(async () => {
          await svc.storage.delete(p.sourceKey!).catch((err) => log.warn({ err, projectId: p.id }, "source delete failed"));
          await removeScratchSource(svc, p.id); // the local store hardlinks it: without this no disk is freed
        });
        sources++;
      });
    }
  }
  if (config.CLIP_RETENTION_DAYS > 0) {
    const cutoff = new Date(Date.now() - config.CLIP_RETENTION_DAYS * 86_400_000);
    const rows = await svc.database.db
      .select({ id: schema.clips.id, projectId: schema.clips.projectId, outputKey: schema.clips.outputKey })
      .from(schema.clips)
      .where(and(isNotNull(schema.clips.outputKey), eq(schema.clips.status, "done"), lt(schema.clips.updatedAt, cutoff)))
      .limit(500);
    const byProject = new Map<string, typeof rows>();
    for (const r of rows) byProject.set(r.projectId, [...(byProject.get(r.projectId) ?? []), r]);
    for (const [projectId, list] of byProject) {
      await svc.tx(async (u) => {
        for (const c of list) {
          const [cur] = await u.db.update(schema.clips).set({ outputKey: null, updatedAt: new Date() }).where(and(eq(schema.clips.id, c.id), eq(schema.clips.outputKey, c.outputKey!))).returning({ id: schema.clips.id });
          if (!cur) continue;
          u.afterCommit(() => svc.storage.delete(c.outputKey!).catch((err) => log.warn({ err, clipId: c.id }, "clip delete failed")));
          clips++;
        }
        await u.emit(projectId, "clips.expired", { clips: list.length, days: config.CLIP_RETENTION_DAYS });
      });
    }
  }
  if (sources || clips) log.info({ sources, clips }, "retention sweep removed files");
  return { sources, clips };
}
