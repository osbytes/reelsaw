import { inArray } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import { QUEUES, type QueueName } from "./boss.js";
import { finalizeProjectIfDone } from "../pipeline/render.js";
import { REFINE_QUEUE, finishIfComplete } from "../pipeline/refine.js";
import { REFINE_STEPS } from "@reelsaw/shared";
import type { ProjectStatus } from "@reelsaw/shared";

const statusQueue: Partial<Record<ProjectStatus, QueueName>> = {
  queued: QUEUES.ingest,
  ingesting: QUEUES.ingest,
  transcribing: QUEUES.transcribe,
  analyzing: QUEUES.analyze,
};

/**
 * Re-enqueue any project whose pipeline stage has no live job. Covers jobs lost to crashes
 * between "mark stage done" and "enqueue next stage", retries exhausted by a transient outage,
 * or manual DB edits. Every stage is idempotent, so double-runs are safe.
 */
export async function reconcile(svc: Services): Promise<{ requeued: number }> {
  const db = svc.database.db;
  let requeued = 0;
  const active = await db.query.projects.findMany({
    where: inArray(schema.projects.status, ["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"]),
  });
  for (const p of active) {
    if (p.status === "rendering") {
      const clips = await db.query.clips.findMany({ where: (t, { eq }) => eq(t.projectId, p.id) });
      for (const c of clips) {
        if (c.status === "done" || c.status === "failed") continue;
        if (c.status === "preparing") {
          if (await svc.queue.hasLiveJob(QUEUES.prepare, c.id)) continue;
          await svc.queue.enqueue(QUEUES.prepare, { projectId: p.id, clipId: c.id, mode: c.origin === "manual-ai" ? "ai" : "exact" });
          requeued++;
          continue;
        }
        if (await svc.queue.hasLiveJob(QUEUES.render, c.id)) continue;
        await svc.queue.enqueue(QUEUES.render, { projectId: p.id, clipId: c.id });
        requeued++;
      }
      await finalizeProjectIfDone(svc, p.id);
      continue;
    }
    if (p.status === "refining") {
      const t = await db.query.transcripts.findFirst({ where: (x, { eq }) => eq(x.projectId, p.id), columns: { refine: true } });
      if (!t) continue;
      for (const step of REFINE_STEPS) {
        const st = t.refine[step];
        if (st === "done" || st === "failed") continue;
        if (await svc.queue.hasLiveJob(REFINE_QUEUE[step], p.id)) continue;
        await svc.queue.enqueue(REFINE_QUEUE[step], { projectId: p.id });
        requeued++;
      }
      await finishIfComplete(svc, p.id);
      continue;
    }
    const queue = statusQueue[p.status];
    if (!queue || (await svc.queue.hasLiveJob(queue, p.id))) continue;
    await svc.queue.enqueue(queue, { projectId: p.id });
    requeued++;
  }
  if (requeued) svc.log.info({ module: "reconcile", requeued }, "re-enqueued orphaned jobs");
  return { requeued };
}

export function startReconciler(svc: Services, intervalMs = 5 * 60_000) {
  const tick = () => reconcile(svc).catch((err) => svc.log.error({ module: "reconcile", err }, "reconcile failed"));
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
