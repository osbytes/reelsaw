/**
 * The Deleted page: restorable projects, clips of live projects, library items and templates, with when
 * each auto-removes and whether the owner can purge now. tRPC `deleted.list` / `restore` / `purge`,
 * MCP `list_deleted` (restore/purge loop the per-kind tools) and `reelsaw deleted <email>` all call these.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { DeletedKind } from "@reelsaw/shared";
import { schema } from "./db/index.js";
import type { Services } from "./services.js";
import { bumperUsageCounts, purgeOwnedAsset, restoreOwnedAsset } from "./library/service.js";
import { listLayerTemplates, purgeLayerTemplate, restoreLayerTemplate, TEMPLATE_RESTORE_DAYS } from "./library/templates.js";
import { ASSET_RESTORE_DAYS } from "./storage/sweep.js";
import { purgeOwnedClip, purgeOwnedProject, restoreClip, restoreProject, type Actor } from "./projects/service.js";

const LIST_CAP = 200;
const BULK_CAP = 200;

export const deletedItemRefSchema = z.object({
  kind: z.enum(["project", "clip", "asset", "template"]),
  id: z.string().min(1).max(100),
});

function until(from: Date, days: number): string | null {
  if (days <= 0) return null;
  return new Date(from.getTime() + days * 86_400_000).toISOString();
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

async function counted(n: Promise<Array<{ n: number }>>): Promise<number> {
  return (await n)[0]?.n ?? 0;
}

/**
 * A per-item reason for the caller. A TRPCError's message is written for people (and a QuotaError
 * carries the upgrade/free-space actions); anything else is an internal failure whose text (SQL,
 * storage paths) stays in the log.
 */
function failMessage(svc: Services, e: unknown, item: { kind: DeletedKind; id: string }, action: "restore" | "purge"): string {
  if (e instanceof TRPCError) return e.message;
  svc.log.child({ module: "deleted" }).error({ err: e, ...item, action }, "deleted item action failed");
  return "Something went wrong. Try again in a moment.";
}

/** When every item failed, the first item's own error, so its code (CONFLICT, NOT_FOUND) and quota actions reach the caller. */
function allFailed(first: unknown): never {
  if (first instanceof TRPCError) throw first;
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Something went wrong. Try again in a moment." });
}

function uniqueRefs(items: Array<{ kind: DeletedKind; id: string }>) {
  const seen = new Set<string>();
  const out: Array<{ kind: DeletedKind; id: string }> = [];
  for (const it of items) {
    const k = `${it.kind}:${it.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
    if (out.length >= BULK_CAP) break;
  }
  return out;
}

export type DeletedItem = {
  kind: DeletedKind;
  id: string;
  title: string;
  deletedAt: string;
  purgeAt: string | null;
  storedBytes: number;
  canPurge: boolean;
  projectId?: string;
  projectTitle?: string;
  status?: string;
  assetKind?: string;
  usedBy?: number;
  usedByClips?: number;
  usedByTemplates?: number;
  layerCount?: number;
  /** projects: deleted with "forget what Reelsaw learned from it", so its decisions go when it is purged */
  forgetDecisions?: boolean;
};

/**
 * The caller's restorable deletes, newest first, capped at 200 (`truncated` when more exist).
 * `keepDays` is DELETED_RETENTION_DAYS (projects and clips); library items and templates use 30 days.
 */
export async function listDeleted(svc: Services, userId: string) {
  const db = svc.database.db;
  const keepDays = svc.settings.get().DELETED_RETENTION_DAYS;
  const assetCutoff = new Date(Date.now() - ASSET_RESTORE_DAYS * 86_400_000);
  const P = schema.projects;
  const C = schema.clips;
  const A = schema.assets;

  const [projectRows, projectTotal, clipRows, clipTotal, assetRows, assetTotal, templates] = await Promise.all([
    db
      .select({
        id: P.id,
        title: P.title,
        status: P.status,
        deletedAt: P.deletedAt,
        forgetDecisions: P.forgetDecisionsOnPurge,
        storedBytes: sql<number>`coalesce(${P.sourceBytes}, 0) + coalesce((select sum(c.output_bytes) from clips c where c.project_id = ${P.id} and c.output_key is not null), 0)`,
      })
      .from(P)
      .where(and(eq(P.userId, userId), isNotNull(P.deletedAt)))
      .orderBy(desc(P.deletedAt), desc(P.id))
      .limit(LIST_CAP),
    counted(db.select({ n: sql<number>`count(*)::int` }).from(P).where(and(eq(P.userId, userId), isNotNull(P.deletedAt)))),
    db
      .select({
        id: C.id,
        title: C.title,
        projectId: C.projectId,
        projectTitle: P.title,
        deletedAt: C.deletedAt,
        storedBytes: sql<number>`case when ${C.outputKey} is not null then coalesce(${C.outputBytes}, 0) else 0 end`,
      })
      .from(C)
      .innerJoin(P, eq(P.id, C.projectId))
      .where(and(eq(P.userId, userId), isNull(P.deletedAt), isNotNull(C.deletedAt)))
      .orderBy(desc(C.deletedAt), desc(C.id))
      .limit(LIST_CAP),
    counted(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(C)
        .innerJoin(P, eq(P.id, C.projectId))
        .where(and(eq(P.userId, userId), isNull(P.deletedAt), isNotNull(C.deletedAt))),
    ),
    db
      .select({
        id: A.id,
        name: A.name,
        kind: A.kind,
        sizeBytes: A.sizeBytes,
        deletedAt: A.deletedAt,
      })
      .from(A)
      .where(and(eq(A.userId, userId), isNotNull(A.deletedAt), gt(A.deletedAt, assetCutoff)))
      .orderBy(desc(A.deletedAt), desc(A.id))
      .limit(LIST_CAP),
    counted(
      db
        .select({ n: sql<number>`count(*)::int` })
        .from(A)
        .where(and(eq(A.userId, userId), isNotNull(A.deletedAt), gt(A.deletedAt, assetCutoff))),
    ),
    listLayerTemplates(db, userId),
  ]);

  const assetIds = assetRows.map((r) => r.id);
  const referenced = new Set<string>();
  if (assetIds.length) {
    const refs = await db.select({ id: schema.assetRefs.assetId }).from(schema.assetRefs).where(inArray(schema.assetRefs.assetId, assetIds));
    for (const r of refs) referenced.add(r.id);
  }
  const usage = assetIds.length ? await bumperUsageCounts(db, userId) : new Map();

  const items: DeletedItem[] = [
    ...projectRows.map((r) => ({
      kind: "project" as const,
      id: r.id,
      title: r.title,
      status: r.status,
      deletedAt: iso(r.deletedAt)!,
      purgeAt: until(r.deletedAt!, keepDays),
      storedBytes: Number(r.storedBytes) || 0,
      canPurge: true,
      forgetDecisions: r.forgetDecisions,
    })),
    ...clipRows.map((r) => ({
      kind: "clip" as const,
      id: r.id,
      title: r.title,
      projectId: r.projectId,
      projectTitle: r.projectTitle,
      deletedAt: iso(r.deletedAt)!,
      purgeAt: until(r.deletedAt!, keepDays),
      storedBytes: Number(r.storedBytes) || 0,
      canPurge: true,
    })),
    ...assetRows.map((r) => {
      const u = usage.get(r.id);
      const named = referenced.has(r.id) || (u?.templates ?? 0) > 0;
      return {
        kind: "asset" as const,
        id: r.id,
        title: r.name,
        assetKind: r.kind,
        deletedAt: iso(r.deletedAt)!,
        purgeAt: until(r.deletedAt!, ASSET_RESTORE_DAYS),
        storedBytes: r.sizeBytes,
        usedBy: u?.projects ?? 0,
        usedByClips: u?.clips ?? 0,
        usedByTemplates: u?.templates ?? 0,
        canPurge: !named,
      };
    }),
    ...templates.deleted.map((t) => ({
      kind: "template" as const,
      id: t.id,
      title: t.name,
      layerCount: t.layerCount,
      deletedAt: t.deletedAt!,
      purgeAt: until(new Date(t.deletedAt!), TEMPLATE_RESTORE_DAYS),
      storedBytes: 0,
      canPurge: true,
    })),
  ];
  items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const total = projectTotal + clipTotal + assetTotal + templates.deleted.length;
  const page = items.slice(0, LIST_CAP);
  return {
    keepDays,
    libraryDays: ASSET_RESTORE_DAYS,
    templateDays: TEMPLATE_RESTORE_DAYS,
    items: page,
    total,
    truncated: total > page.length,
  };
}

async function restoreOne(svc: Services, actor: Actor & { id: string }, item: { kind: DeletedKind; id: string }) {
  if (item.kind === "project") return restoreProject(svc, actor, item.id);
  if (item.kind === "clip") return restoreClip(svc, actor, item.id);
  if (item.kind === "asset") return restoreOwnedAsset(svc, actor.id, item.id);
  return restoreLayerTemplate(svc, actor.id, item.id);
}

async function purgeOne(svc: Services, actor: Actor & { id: string }, item: { kind: DeletedKind; id: string }, o: { forgetDecisions?: boolean }) {
  if (item.kind === "project") return purgeOwnedProject(svc, actor, item.id, o);
  if (item.kind === "clip") return purgeOwnedClip(svc, actor, item.id);
  if (item.kind === "asset") return purgeOwnedAsset(svc, actor.id, item.id);
  return purgeLayerTemplate(svc, actor.id, item.id);
}

function storedOf(r: unknown): number {
  if (r && typeof r === "object" && "storedBytes" in r && typeof r.storedBytes === "number") return r.storedBytes;
  return 0;
}

/**
 * Restore several Deleted rows (the selection bar). Each kind uses its existing service (own transaction);
 * one failure does not roll the others back. tRPC `deleted.restore`; MCP loops the per-kind tools.
 */
export async function restoreDeleted(svc: Services, actor: Actor & { id: string }, items: Array<{ kind: DeletedKind; id: string }>) {
  const refs = uniqueRefs(items);
  if (!refs.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one item" });
  const results: Array<{ kind: DeletedKind; id: string; ok: boolean; error?: string }> = [];
  let firstError: unknown;
  for (const it of refs) {
    try {
      await restoreOne(svc, actor, it);
      results.push({ kind: it.kind, id: it.id, ok: true });
    } catch (e) {
      firstError ??= e;
      results.push({ kind: it.kind, id: it.id, ok: false, error: failMessage(svc, e, it, "restore") });
    }
  }
  const restored = results.filter((r) => r.ok).length;
  const failed = results.length - restored;
  if (!restored) allFailed(firstError);
  return { ok: true as const, restored, failed, results };
}

/**
 * Remove several already-deleted rows for good (the selection bar). Each kind uses its existing service;
 * a referenced library item is refused and the rest continue. tRPC `deleted.purge`; MCP loops the per-kind tools.
 */
export async function purgeDeleted(svc: Services, actor: Actor & { id: string }, items: Array<{ kind: DeletedKind; id: string }>, o: { forgetDecisions?: boolean } = {}) {
  const refs = uniqueRefs(items);
  if (!refs.length) throw new TRPCError({ code: "BAD_REQUEST", message: "Pick at least one item" });
  const results: Array<{ kind: DeletedKind; id: string; ok: boolean; storedBytes: number; error?: string }> = [];
  let firstError: unknown;
  for (const it of refs) {
    try {
      const r = await purgeOne(svc, actor, it, o);
      results.push({ kind: it.kind, id: it.id, ok: true, storedBytes: storedOf(r) });
    } catch (e) {
      firstError ??= e;
      results.push({ kind: it.kind, id: it.id, ok: false, storedBytes: 0, error: failMessage(svc, e, it, "purge") });
    }
  }
  const purged = results.filter((r) => r.ok).length;
  const failed = results.length - purged;
  const storedBytes = results.reduce((n, r) => n + r.storedBytes, 0);
  if (!purged) allFailed(firstError);
  return { ok: true as const, purged, failed, storedBytes, results };
}
