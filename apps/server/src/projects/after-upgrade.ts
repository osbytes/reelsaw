/**
 * What follows a plan or limits change for the account's own projects, besides resuming plan refusals
 * (ops/failures.ts `retryRefusedWork`): the partly processed videos get their rest processed (`finishPartialProjects`),
 * and clips rendered with the watermark are rendered again without it once the account's renders no longer carry it
 * (`rerenderWatermarked`). Both are keyed by the account, coalesced and one at a time, and skipped at emit when there
 * is nothing to do. The download offer's promise ("Upgrade and Reelsaw renders your clips again without it") is this handler.
 */
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import type { EventHandler, ReadDb } from "../event-handlers.js";
import type { AccountEventType } from "../event-types.js";
import { watermarkFor } from "../quota.js";
import { finishPartialProjects, rerenderProjectClips } from "./service.js";

type PlanChange = Extract<AccountEventType, "user.limits_changed" | "billing.subscribed" | "billing.changed" | "billing.complimentary">;

const userOf = (payload: unknown): string => {
  const id = payload && typeof payload === "object" && "userId" in payload ? payload.userId : null;
  if (typeof id !== "string") throw new Error("a plan change event without a userId");
  return id;
};

/** Limits whose change can let more of a video through; another override changing (storage, projects) cannot. */
const MINUTE_LIMITS: readonly string[] = ["MAX_SOURCE_MINUTES_PER_DAY", "MAX_SOURCE_MINUTES_PER_MONTH"];

/** After a plan or minutes change: process more of the account's partly processed videos (projects/service.ts). */
export function finishPartialWork<T extends PlanChange>(): EventHandler<T> {
  return {
    key: async ({ event, db }: { event: { payload: unknown }; db: ReadDb }) => {
      const userId = userOf(event.payload);
      const changed = event.payload && typeof event.payload === "object" && "changed" in event.payload ? event.payload.changed : undefined;
      if (Array.isArray(changed) && !changed.some((k) => MINUTE_LIMITS.includes(String(k)))) return null;
      const [hit] = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt), isNotNull(schema.projects.sourceLimitSec)))
        .limit(1);
      return hit ? `partial-finish:${userId}` : null;
    },
    coalesce: true,
    oneAtATime: true,
    handle: async ({ event, svc }) => void (await finishPartialProjects(svc, userOf(event.payload))),
  };
}

/** How many projects one plan change re-renders without the watermark, newest first; older ones keep their Re-render button. */
const WATERMARK_PAGE = 20;

/**
 * Render the account's finished watermarked clips again once its renders no longer carry the watermark (a paid plan,
 * an admin's grant). Newest projects first, a page of them; nothing when the watermark is still on.
 */
export async function rerenderWatermarked(svc: Services, userId: string): Promise<{ projects: number; clips: number }> {
  const db = svc.database.db;
  const user = await db.query.user.findFirst({ where: eq(schema.user.id, userId), columns: { id: true, role: true, banned: true } });
  if (!user || user.banned) return { projects: 0, clips: 0 };
  const wm = await watermarkFor(db, svc.settings.get(), { id: user.id, role: user.role ?? "user" }, svc.entitlements);
  if (wm.on) return { projects: 0, clips: 0 };
  const rows = await db
    .selectDistinct({ id: schema.projects.id, updatedAt: schema.projects.updatedAt })
    .from(schema.projects)
    .innerJoin(schema.clips, eq(schema.clips.projectId, schema.projects.id))
    .where(
      and(
        eq(schema.projects.userId, userId),
        isNull(schema.projects.deletedAt),
        isNull(schema.clips.deletedAt),
        eq(schema.clips.watermark, true),
        inArray(schema.clips.status, ["done"]),
      ),
    )
    .orderBy(desc(schema.projects.updatedAt))
    .limit(WATERMARK_PAGE);
  let clips = 0;
  for (const r of rows) {
    const out = await svc.tx((u) => rerenderProjectClips(svc, u, r.id, (c) => c.status === "done" && c.watermark));
    clips += out.queued;
  }
  if (rows.length)
    svc.log
      .child({ module: "projects", userId })
      .info({ projects: rows.length, clips, page: WATERMARK_PAGE }, "re-rendering watermarked clips after the watermark came off");
  return { projects: rows.length, clips };
}

/** After a plan change: the watermarked clips, rendered again without it (`rerenderWatermarked`). */
export function rerenderWithoutWatermark<T extends PlanChange>(): EventHandler<T> {
  return {
    key: async ({ event, db }: { event: { payload: unknown }; db: ReadDb }) => {
      const userId = userOf(event.payload);
      const [hit] = await db
        .select({ id: schema.clips.id })
        .from(schema.clips)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.clips.projectId))
        .where(and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt), isNull(schema.clips.deletedAt), eq(schema.clips.watermark, true)))
        .limit(1);
      return hit ? `watermark-off:${userId}` : null;
    },
    coalesce: true,
    oneAtATime: true,
    handle: async ({ event, svc }) => void (await rerenderWatermarked(svc, userOf(event.payload))),
  };
}
