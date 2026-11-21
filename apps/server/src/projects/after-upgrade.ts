/**
 * What follows a plan or limits change for the account's own projects, besides resuming plan refusals
 * (ops/failures.ts `retryRefusedWork`). Only the project the upgrade started from (an offer on its page or at its
 * Download, recorded by `recordUpgradeProject` when checkout begins) is handled by itself: the rest of its video is
 * processed (`finishPartialWork`) and its watermarked clips render again without the watermark
 * (`rerenderWithoutWatermark`). Every other project waits for its owner's pick (`upgradeWork` lists them,
 * `startUpgradeWork` starts the picked ones: the welcome dialog after checkout and the Billing page), so a plan change
 * never spends the new minutes or the hour's re-renders on projects nobody asked for.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, count, countDistinct, desc, eq, gt, isNotNull, isNull, ne } from "drizzle-orm";
import { plural, processedEndSec } from "@reelsaw/shared";
import { schema, type Db } from "../db/index.js";
import type { Services } from "../services.js";
import type { EventHandler, ReadDb } from "../event-handlers.js";
import type { AccountEventType } from "../event-types.js";
import { minutesRoomSec, QuotaError, watermarkFor } from "../quota.js";
import { eachItem, uniqueBy } from "../lib/each.js";
import { extendProject, findProject, rerenderProjectClips, WORKING, type Actor } from "./service.js";
import { projectIdsInput } from "./bulk.js";

type PlanChange = Extract<AccountEventType, "user.limits_changed" | "billing.subscribed" | "billing.changed" | "billing.complimentary">;

const userOf = (payload: unknown): string => {
  const id = payload && typeof payload === "object" && "userId" in payload ? payload.userId : null;
  if (typeof id !== "string") throw new Error("a plan change event without a userId");
  return id;
};

/** How long after checkout began the plan change still counts as that project's upgrade. */
const UPGRADE_PROJECT_TTL_MS = 24 * 3600_000;

/**
 * Remember the project an upgrade starts from (billing checkout with `fromProjectId`). Someone else's or a deleted
 * project is ignored, not refused: checkout goes on, and nothing runs by itself afterwards.
 */
export async function recordUpgradeProject(db: Db, userId: string, projectId: string): Promise<boolean> {
  const [p] = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)));
  if (!p) return false;
  const now = new Date();
  await db
    .insert(schema.userSettings)
    .values({ userId, upgradeProjectId: p.id, upgradeProjectAt: now })
    .onConflictDoUpdate({ target: schema.userSettings.userId, set: { upgradeProjectId: p.id, upgradeProjectAt: now, updatedAt: now } });
  return true;
}

/** The live project this account's latest upgrade started from, within a day of checkout; null when none. */
async function upgradeProjectOf(db: ReadDb, userId: string): Promise<string | null> {
  const [r] = await db
    .select({ id: schema.projects.id })
    .from(schema.userSettings)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.userSettings.upgradeProjectId))
    .where(
      and(
        eq(schema.userSettings.userId, userId),
        eq(schema.projects.userId, userId),
        isNull(schema.projects.deletedAt),
        gt(schema.userSettings.upgradeProjectAt, new Date(Date.now() - UPGRADE_PROJECT_TTL_MS)),
      ),
    );
  return r?.id ?? null;
}

/** Limits whose change can let more of a video through; another override changing (storage, projects) cannot. */
const MINUTE_LIMITS: readonly string[] = ["MAX_SOURCE_MINUTES_PER_DAY", "MAX_SOURCE_MINUTES_PER_MONTH"];

/** After a plan or minutes change: process the rest of the upgrade's own project when only its start was processed. */
export function finishPartialWork<T extends PlanChange>(): EventHandler<T> {
  return {
    key: async ({ event, db }: { event: { payload: unknown }; db: ReadDb }) => {
      const userId = userOf(event.payload);
      const changed = event.payload && typeof event.payload === "object" && "changed" in event.payload ? event.payload.changed : undefined;
      if (Array.isArray(changed) && !changed.some((k) => MINUTE_LIMITS.includes(String(k)))) return null;
      const id = await upgradeProjectOf(db, userId);
      if (!id) return null;
      const [hit] = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(and(eq(schema.projects.id, id), isNotNull(schema.projects.sourceLimitSec)));
      return hit ? `partial-finish:${userId}` : null;
    },
    coalesce: true,
    oneAtATime: true,
    handle: async ({ event, svc }) => {
      const userId = userOf(event.payload);
      const id = await upgradeProjectOf(svc.database.db, userId);
      if (!id) return;
      try {
        await extendProject(svc, null, id, { automatic: true });
        svc.log.child({ module: "projects", userId }).info({ projectId: id }, "processing the rest of the upgrade's project");
      } catch (err) {
        // still out of minutes, gone, already whole or extending: its own "Clip the rest" stays
        if (err instanceof QuotaError || (err instanceof TRPCError && ["NOT_FOUND", "BAD_REQUEST", "CONFLICT"].includes(err.code))) return;
        throw err;
      }
    },
  };
}

/** Whether this account's renders carry the watermark now (re-rendering a clip would keep it); null = no such account. */
async function watermarkOn(svc: Services, userId: string): Promise<boolean | null> {
  const user = await svc.database.db.query.user.findFirst({ where: eq(schema.user.id, userId), columns: { id: true, role: true, banned: true } });
  if (!user || user.banned) return null;
  return (await watermarkFor(svc.database.db, svc.settings.get(), { id: user.id, role: user.role ?? "user" }, svc.entitlements)).on;
}

/** Render one project's finished watermarked clips again, once the account's renders no longer carry the watermark. */
async function rerenderWatermarkedOf(svc: Services, actor: Actor, projectId: string): Promise<{ queued: number; skipped: number }> {
  return svc.tx(async (u) => {
    const p = await findProject(u.db, actor, projectId, { deleted: false });
    if ((await watermarkOn(svc, p.userId)) !== false)
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This account's renders still carry the watermark, so a re-render would keep it." });
    return rerenderProjectClips(svc, u, p.id, (c) => c.status === "done" && c.watermark);
  });
}

/** After a plan change: the upgrade's own project, its watermarked clips rendered again without it. */
export function rerenderWithoutWatermark<T extends PlanChange>(): EventHandler<T> {
  return {
    key: async ({ event, db }: { event: { payload: unknown }; db: ReadDb }) => {
      const userId = userOf(event.payload);
      const id = await upgradeProjectOf(db, userId);
      if (!id) return null;
      const [hit] = await db
        .select({ id: schema.clips.id })
        .from(schema.clips)
        .where(and(eq(schema.clips.projectId, id), isNull(schema.clips.deletedAt), eq(schema.clips.watermark, true)))
        .limit(1);
      return hit ? `watermark-off:${userId}` : null;
    },
    coalesce: true,
    oneAtATime: true,
    handle: async ({ event, svc }) => {
      const userId = userOf(event.payload);
      const id = await upgradeProjectOf(svc.database.db, userId);
      if (!id || (await watermarkOn(svc, userId)) !== false) return;
      try {
        const r = await rerenderWatermarkedOf(svc, null, id);
        svc.log.child({ module: "projects", userId }).info({ projectId: id, clips: r.queued }, "re-rendering the upgrade's project without the watermark");
      } catch (err) {
        if (err instanceof TRPCError && ["NOT_FOUND", "PRECONDITION_FAILED"].includes(err.code)) return;
        throw err;
      }
    },
  };
}

/** Most projects each list of `upgradeWork` shows, newest first; `total` says how many there are in all. */
const WORK_PAGE = 50;

export interface UpgradeWork {
  /** the account's renders still carry the watermark: nothing to re-render yet (`rerender` is empty) */
  watermarkOn: boolean;
  /** the project the latest upgrade started from (handled by itself, so left out of the lists) */
  upgradeProject: { id: string; title: string } | null;
  /** projects with finished clips that carry the watermark */
  rerender: { total: number; projects: Array<{ id: string; title: string; clips: number }> };
  /** projects only the start of whose video was processed; `busy` = it is working (an extension may be running) */
  finish: { total: number; projects: Array<{ id: string; title: string; durationSec: number; remainingSec: number; busy: boolean }> };
  /** seconds of video the account's minutes cover now (null = no cap) */
  minutesRoomSec: number | null;
}

/**
 * What a plan change could do for the account's other projects: the ones whose clips carry the watermark and the
 * ones only partly processed, newest first. The welcome dialog after checkout, the Billing page, MCP
 * list_upgrade_work and `reelsaw upgrade-work` read this.
 */
export async function upgradeWork(svc: Services, userId: string): Promise<UpgradeWork> {
  const db = svc.database.db;
  const [wm, upgradeId, room] = await Promise.all([
    watermarkOn(svc, userId),
    upgradeProjectOf(db, userId),
    minutesRoomSec(db, svc.settings.get(), userId, { extension: true, ent: svc.entitlements }),
  ]);
  const live = and(eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt), upgradeId ? ne(schema.projects.id, upgradeId) : undefined);
  const marked = and(live, isNull(schema.clips.deletedAt), eq(schema.clips.watermark, true), eq(schema.clips.status, "done"));
  const partial = and(live, isNotNull(schema.projects.sourceLimitSec), isNotNull(schema.projects.durationSec));
  const clean = wm === false;
  const [rerenderRows, rerenderTotal, finishRows, finishTotal, up] = await Promise.all([
    clean
      ? db
          .select({ id: schema.projects.id, title: schema.projects.title, clips: count(schema.clips.id) })
          .from(schema.projects)
          .innerJoin(schema.clips, eq(schema.clips.projectId, schema.projects.id))
          .where(marked)
          .groupBy(schema.projects.id)
          .orderBy(desc(schema.projects.updatedAt), desc(schema.projects.id))
          .limit(WORK_PAGE)
      : [],
    clean
      ? db
          .select({ n: countDistinct(schema.projects.id) })
          .from(schema.projects)
          .innerJoin(schema.clips, eq(schema.clips.projectId, schema.projects.id))
          .where(marked)
      : [{ n: 0 }],
    db
      .select({
        id: schema.projects.id,
        title: schema.projects.title,
        durationSec: schema.projects.durationSec,
        sourceLimitSec: schema.projects.sourceLimitSec,
        status: schema.projects.status,
      })
      .from(schema.projects)
      .where(partial)
      .orderBy(desc(schema.projects.updatedAt), desc(schema.projects.id))
      .limit(WORK_PAGE),
    db.select({ n: count() }).from(schema.projects).where(partial),
    upgradeId ? db.select({ id: schema.projects.id, title: schema.projects.title }).from(schema.projects).where(eq(schema.projects.id, upgradeId)) : [],
  ]);
  return {
    watermarkOn: !clean,
    upgradeProject: up[0] ?? null,
    rerender: { total: Number(rerenderTotal[0]?.n ?? 0), projects: rerenderRows.map((r) => ({ ...r, clips: Number(r.clips) })) },
    finish: {
      total: Number(finishTotal[0]?.n ?? 0),
      projects: finishRows.map((r) => {
        const durationSec = r.durationSec ?? 0;
        const processed = processedEndSec(r) ?? durationSec;
        return {
          id: r.id,
          title: r.title,
          durationSec,
          remainingSec: Math.max(0, Math.round((durationSec - processed) * 10) / 10),
          busy: (WORKING as readonly string[]).includes(r.status),
        };
      }),
    },
    minutesRoomSec: room.sec,
  };
}

export const startUpgradeWorkInput = {
  rerender: projectIdsInput.optional().describe("Projects whose watermarked clips render again without the watermark (from list_upgrade_work)"),
  finish: projectIdsInput.optional().describe("Partly processed projects to clip the rest of, as far as the minutes go (from list_upgrade_work)"),
};
const startUpgradeWorkSchema = z.object(startUpgradeWorkInput);
export type StartUpgradeWorkInput = z.infer<typeof startUpgradeWorkSchema>;

/**
 * Start what the owner picked after a plan change: re-render the watermarked clips of `rerender` and process the rest
 * of `finish`, each project in its own transaction through the same services as its own buttons (the clip re-render,
 * extend_project), so one refusal (out of minutes, the hour's re-renders) never undoes the others. Videos go first:
 * they spend minutes, which a re-render does not. tRPC `projects.startUpgradeWork`, MCP start_upgrade_work and
 * `reelsaw start-upgrade-work` call this.
 */
export async function startUpgradeWork(svc: Services, actor: Actor, input: StartUpgradeWorkInput) {
  const items = uniqueBy(
    [...(input.finish ?? []).map((id) => ({ id, action: "finish" as const })), ...(input.rerender ?? []).map((id) => ({ id, action: "rerender" as const }))],
    (x) => `${x.action}:${x.id}`,
  );
  const out = await eachItem(svc, { module: "projects", action: "upgrade-work", empty: "Pick at least one project" }, items, async (x) =>
    x.action === "finish"
      ? { kind: "finish" as const, ...(await extendProject(svc, actor, x.id)) }
      : { kind: "rerender" as const, ...(await rerenderWatermarkedOf(svc, actor, x.id)) },
  );
  const results = out.map((r) => {
    if (!r.ok) return { id: r.item.id, action: r.item.action, ok: false as const, error: r.error };
    const v = r.value;
    return v.kind === "finish"
      ? { id: r.item.id, action: r.item.action, ok: true as const, untilSec: v.untilSec, whole: v.whole }
      : { id: r.item.id, action: r.item.action, ok: true as const, queued: v.queued };
  });
  const ok = out.flatMap((r) => (r.ok ? [r.value] : []));
  const clips = ok.reduce((n, v) => n + (v.kind === "rerender" ? v.queued : 0), 0);
  const extended = ok.filter((v) => v.kind === "finish").length;
  const parts = [extended ? `clipping more of ${plural(extended, "video")}` : "", clips ? `re-rendering ${plural(clips, "clip")} without the watermark` : ""];
  return {
    ok: true as const,
    rerenderedClips: clips,
    extendedProjects: extended,
    failed: out.length - ok.length,
    /** "clipping more of 2 videos and re-rendering 14 clips without the watermark"; empty when nothing started */
    sentence: parts.filter(Boolean).join(" and "),
    results,
  };
}
