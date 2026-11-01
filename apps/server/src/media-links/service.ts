/**
 * Share links (docs/specs/media-links.md): a URL anyone can fetch, `/m/<token>/<name>.<ext>`, for a clip's current
 * render, thumbnail or captions, or a project's export zip. One stored row per link: the token's sha256 for lookup
 * and the token sealed so the owner can copy it again. Links expire (MEDIA_LINK_TTL_DAYS, or never where
 * MEDIA_LINK_ALLOW_NEVER) and are revoked one at a time, per clip or project, or all at once. The web app, MCP
 * (get_media_links / list_media_links / revoke_media_link), `reelsaw media-links` and webhook bodies call this module.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createSecretBox } from "../ai/crypto.js";
import { schema, type Db } from "../db/index.js";
import { MEDIA_LINK_KINDS, type MediaLinkKind, type MediaLinkRow, type MediaLinkSource } from "../db/schema.js";
import { exportPlan, slugify } from "../export.js";
import { takeTxLock, txLock } from "../locks.js";
import type { Services } from "../services.js";

export { MEDIA_LINK_KINDS };
export type { MediaLinkKind };

/** A link with less life than this is not handed out again: a scheduler queue needs the URL to outlive the post. */
export const REUSE_MIN_REMAINING_MS = 7 * 86_400_000;

/** The life a link needs left to be reused: 7 days, or half the instance's ceiling where links last a week or less. */
export const reuseMinRemainingMs = (ttlDays: number) => Math.min(REUSE_MIN_REMAINING_MS, (ttlDays * 86_400_000) / 2);
export const LINK_LIST_MAX = 100;
/** `use_count` / `last_used_at` move at most this often per link, so a video fetched in Range parts is one write */
const USE_WRITE_EVERY_MS = 60_000;

export const EXT: Record<MediaLinkKind, string> = { clip: "mp4", thumb: "jpg", srt: "srt", vtt: "vtt", export: "zip" };

export type LinkTarget = { kind: Exclude<MediaLinkKind, "export">; clipId: string } | { kind: "export"; projectId: string; clipIds?: string[] | undefined };

export interface LinkOptions {
  source: MediaLinkSource;
  /** days the link lasts (capped at MEDIA_LINK_TTL_DAYS); null = never expires (only where allowed); omitted = the default */
  ttlDays?: number | null | undefined;
  /** a label always makes a separate link, so it can be revoked without breaking the others */
  label?: string | undefined;
}

export interface MediaLinkView {
  id: string;
  kind: MediaLinkKind;
  projectId: string;
  projectTitle: string;
  clipId: string | null;
  clipTitle: string | null;
  clipIds: string[] | null;
  /** the full URL; only for the owner's own surfaces */
  url: string;
  label: string | null;
  source: MediaLinkSource;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  useCount: number;
  createdAt: Date;
  /** active | expired | revoked */
  state: "active" | "expired" | "revoked";
}

const box = (svc: Pick<Services, "config">) => createSecretBox(svc.config.BETTER_AUTH_SECRET, "media-links");
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const newId = () => `lnk_${randomBytes(9).toString("base64url")}`;

/** The cosmetic file name in the URL; the server checks only its extension. */
export function linkFileName(kind: MediaLinkKind, names: { projectTitle: string; clipIndex?: number | null; clipTitle?: string | null }): string {
  if (kind === "export") return `${slugify(names.projectTitle)}.${EXT.export}`;
  const base = `${String((names.clipIndex ?? 0) + 1).padStart(2, "0")}-${slugify(names.clipTitle ?? "clip")}`;
  return `${base}${kind === "thumb" ? "-thumb" : ""}.${EXT[kind]}`;
}

export function linkUrl(appUrl: string, token: string, fileName: string): string {
  return new URL(`/m/${token}/${encodeURIComponent(fileName)}`, appUrl).toString();
}

/** `/m/abcd…wxyz/name.mp4` → `/m/…wxyz/name.mp4`: what lists and logs show. */
export function maskLinkUrl(url: string): string {
  return url.replace(/\/m\/([^/]+)\//, (_m, t: string) => `/m/…${t.slice(-4)}/`);
}

function stateOf(row: Pick<MediaLinkRow, "revokedAt" | "expiresAt">, now = Date.now()): MediaLinkView["state"] {
  if (row.revokedAt) return "revoked";
  if (row.expiresAt && row.expiresAt.getTime() <= now) return "expired";
  return "active";
}

/** The expiry a request gets: the instance ceiling, the caller's shorter choice, or never where the instance allows it. */
export function expiryFor(svc: Pick<Services, "settings">, ttlDays: number | null | undefined, now = Date.now()): Date | null {
  const s = svc.settings.get();
  if (ttlDays === null) {
    if (!s.MEDIA_LINK_ALLOW_NEVER)
      throw new TRPCError({ code: "BAD_REQUEST", message: `Share links on this instance expire after at most ${s.MEDIA_LINK_TTL_DAYS} days.` });
    return null;
  }
  const days = Math.min(ttlDays ?? s.MEDIA_LINK_TTL_DAYS, s.MEDIA_LINK_TTL_DAYS);
  return new Date(now + days * 86_400_000);
}

interface Resolved {
  projectId: string;
  projectTitle: string;
  clipId: string | null;
  clipIndex: number | null;
  clipTitle: string | null;
  clipIds: string[] | null;
}

/** The target, checked to be the owner's and live. NOT_FOUND / CONFLICT carry sentences. */
async function resolveTarget(svc: Services, userId: string, target: LinkTarget): Promise<Resolved> {
  const db = svc.database.db;
  if (target.kind === "export") {
    // the same preconditions as the zip itself (owned, live, a rendered clip, every id this project's)
    const plan = await exportPlan(svc, { id: userId, admin: false }, target.projectId, target.clipIds ?? []);
    const ids = target.clipIds?.length ? [...new Set(target.clipIds)].sort() : null;
    return { projectId: plan.project.id, projectTitle: plan.project.title, clipId: null, clipIndex: null, clipTitle: null, clipIds: ids };
  }
  const [row] = await db
    .select({ clip: schema.clips, projectTitle: schema.projects.title })
    .from(schema.clips)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.clips.projectId))
    .where(and(eq(schema.clips.id, target.clipId), eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt), isNull(schema.clips.deletedAt)))
    .limit(1);
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "No such clip" });
  const c = row.clip;
  const ready = target.kind === "clip" ? !!c.outputKey : target.kind === "thumb" ? !!c.thumbnailKey : !!c.captions;
  if (!ready)
    throw new TRPCError({
      code: "CONFLICT",
      message:
        target.kind === "srt" || target.kind === "vtt"
          ? "This clip has no caption file yet: it needs a render first."
          : "This clip is not rendered yet. Wait for it to finish, then share it.",
    });
  return { projectId: c.projectId, projectTitle: row.projectTitle, clipId: c.id, clipIndex: c.index, clipTitle: c.title, clipIds: null };
}

function view(
  svc: Pick<Services, "config">,
  row: MediaLinkRow,
  names: { projectTitle: string; clipIndex: number | null; clipTitle: string | null },
): MediaLinkView {
  const token = box(svc).decrypt(row.tokenSealed);
  return {
    id: row.id,
    kind: row.kind,
    projectId: row.projectId,
    projectTitle: names.projectTitle,
    clipId: row.clipId,
    clipTitle: names.clipTitle,
    clipIds: row.clipIds,
    url: linkUrl(svc.config.APP_URL, token, linkFileName(row.kind, names)),
    label: row.label,
    source: row.source,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    useCount: row.useCount,
    createdAt: row.createdAt,
    state: stateOf(row),
  };
}

const sameIds = (a: string[] | null, b: string[] | null) => (a ?? []).join(",") === (b ?? []).join(",");

/**
 * The owner's active link for a target, or a new one. Reused when the caller asked for nothing specific (no label,
 * no expiry) and an unlabelled link from the same family (webhook, or the owner's own surfaces) has at least 7 days
 * left (reuseMinRemainingMs), so copying twice, an agent asking in a loop or a webhook per re-render all hand out one
 * stable URL. The lookup and the insert run under the account's lock, so two at once still agree on one link.
 */
export async function getOrCreateLink(svc: Services, userId: string, target: LinkTarget, opts: LinkOptions): Promise<MediaLinkView> {
  const t = await resolveTarget(svc, userId, target);
  const names = { projectTitle: t.projectTitle, clipIndex: t.clipIndex, clipTitle: t.clipTitle };
  const label = opts.label?.trim() || null;
  const reuse = !label && opts.ttlDays === undefined;
  const expiresAt = expiryFor(svc, opts.ttlDays);
  const row = await svc.tx(async (u) => {
    if (!reuse) return insertLink(svc, u.db, userId, t, target.kind, opts.source, label, expiresAt);
    await takeTxLock(u.db, txLock.mediaLinks(userId));
    const family: MediaLinkSource[] = opts.source === "webhook" ? ["webhook"] : ["ui", "mcp", "cli"];
    const minLeft = reuseMinRemainingMs(svc.settings.get().MEDIA_LINK_TTL_DAYS);
    const candidates = await u.db.query.mediaLinks.findMany({
      where: and(
        eq(schema.mediaLinks.userId, userId),
        eq(schema.mediaLinks.kind, target.kind),
        t.clipId ? eq(schema.mediaLinks.clipId, t.clipId) : eq(schema.mediaLinks.projectId, t.projectId),
        isNull(schema.mediaLinks.revokedAt),
        isNull(schema.mediaLinks.label),
        inArray(schema.mediaLinks.source, family),
        or(isNull(schema.mediaLinks.expiresAt), sql`${schema.mediaLinks.expiresAt} > now() + ${`${Math.floor(minLeft / 1000)} seconds`}::interval`),
      ),
      orderBy: desc(schema.mediaLinks.createdAt),
      limit: 20,
    });
    return (
      candidates.find((r) => target.kind !== "export" || sameIds(r.clipIds, t.clipIds)) ??
      insertLink(svc, u.db, userId, t, target.kind, opts.source, label, expiresAt)
    );
  });
  return view(svc, row, names);
}

async function insertLink(
  svc: Services,
  db: Db,
  userId: string,
  t: Resolved,
  kind: MediaLinkKind,
  source: MediaLinkSource,
  label: string | null,
  expiresAt: Date | null,
): Promise<MediaLinkRow> {
  const token = newToken();
  const [row] = await db
    .insert(schema.mediaLinks)
    .values({
      id: newId(),
      userId,
      projectId: t.projectId,
      clipId: t.clipId,
      kind,
      clipIds: t.clipIds,
      tokenHash: hashToken(token),
      tokenSealed: box(svc).encrypt(token),
      source,
      label,
      expiresAt,
    })
    .returning();
  svc.log.child({ module: "media-links" }).info({ linkId: row!.id, userId, projectId: t.projectId, clipId: t.clipId, kind, source }, "media link created");
  return row!;
}

export interface ListLinksInput {
  projectId?: string | undefined;
  clipId?: string | undefined;
  /** only links that still work */
  active?: boolean | undefined;
  /** keyset: the last id of the previous page */
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** A page of the owner's links, newest first, with the titles of what they point at. */
export async function listLinks(svc: Services, userId: string, input: ListLinksInput = {}) {
  const db = svc.database.db;
  const limit = Math.min(input.limit ?? 50, LINK_LIST_MAX);
  const filters: SQL[] = [eq(schema.mediaLinks.userId, userId)];
  if (input.projectId) filters.push(eq(schema.mediaLinks.projectId, input.projectId));
  if (input.clipId) filters.push(eq(schema.mediaLinks.clipId, input.clipId));
  if (input.active) filters.push(isNull(schema.mediaLinks.revokedAt), or(isNull(schema.mediaLinks.expiresAt), sql`${schema.mediaLinks.expiresAt} > now()`)!);
  const where = and(...filters);
  const [rows, [{ total } = { total: 0 }]] = await Promise.all([
    db
      .select({ link: schema.mediaLinks, projectTitle: schema.projects.title, clipIndex: schema.clips.index, clipTitle: schema.clips.title })
      .from(schema.mediaLinks)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.mediaLinks.projectId))
      .leftJoin(schema.clips, eq(schema.clips.id, schema.mediaLinks.clipId))
      .where(
        input.cursor
          ? and(where, sql`(${schema.mediaLinks.createdAt}, ${schema.mediaLinks.id}) < (select created_at, id from media_links where id = ${input.cursor})`)
          : where,
      )
      .orderBy(desc(schema.mediaLinks.createdAt), desc(schema.mediaLinks.id))
      .limit(limit + 1),
    db.select({ total: count() }).from(schema.mediaLinks).where(where),
  ]);
  const page = rows.slice(0, limit);
  return {
    items: page.map((r) => view(svc, r.link, { projectTitle: r.projectTitle, clipIndex: r.clipIndex, clipTitle: r.clipTitle })),
    nextCursor: rows.length > limit ? (page.at(-1)?.link.id ?? null) : null,
    total: Number(total),
  };
}

export type RevokeScope = { linkId: string } | { projectId: string } | { clipId: string } | { all: true };

/** Revoke links; returns how many stopped working. Scoped by the owner inside the statement. */
export async function revokeLinks(svc: Services, userId: string, scope: RevokeScope): Promise<number> {
  const db = svc.database.db;
  const m = schema.mediaLinks;
  const which =
    "linkId" in scope
      ? eq(m.id, scope.linkId)
      : "projectId" in scope
        ? eq(m.projectId, scope.projectId)
        : "clipId" in scope
          ? eq(m.clipId, scope.clipId)
          : undefined;
  const rows = await db
    .update(m)
    .set({ revokedAt: new Date() })
    .where(and(eq(m.userId, userId), isNull(m.revokedAt), which))
    .returning({ id: m.id });
  if ("linkId" in scope && !rows.length) {
    const exists = await db.query.mediaLinks.findFirst({ where: and(eq(m.id, scope.linkId), eq(m.userId, userId)), columns: { id: true } });
    if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "No such share link" });
  }
  svc.log.child({ module: "media-links" }).info({ userId, scope: Object.keys(scope)[0], revoked: rows.length }, "media link revoked");
  return rows.length;
}

export const revokeMessage = (n: number) =>
  n ? `Revoked ${n} share link${n === 1 ? "" : "s"}; ${n === 1 ? "it stops" : "they stop"} working now.` : "No active share links to revoke.";

/** What a share-link request resolves to: a file to send, or the status and sentence to answer with. */
export type LinkHit =
  | { ok: true; link: MediaLinkRow; kind: MediaLinkKind; ownerId: string; key: string | null; fileName: string; clip: { id: string } | null }
  | { ok: false; status: 404 | 409 | 410; message: string };

export const LINK_NOT_FOUND = "This link is invalid, expired or was turned off.";

/**
 * Look a token up. Every miss (unknown token, wrong extension, revoked, expired, a deleted project or clip, a banned
 * owner) gets the same 404, so a guess learns nothing. A clip being re-rendered or whose files retention removed says so.
 */
export async function resolveToken(svc: Services, token: string, ext: string, now = Date.now()): Promise<LinkHit> {
  const miss = { ok: false as const, status: 404 as const, message: LINK_NOT_FOUND };
  if (!/^[\w-]{43}$/.test(token)) return miss;
  const db = svc.database.db;
  const [row] = await db
    .select({ link: schema.mediaLinks, project: schema.projects, banned: schema.user.banned, clip: schema.clips })
    .from(schema.mediaLinks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.mediaLinks.projectId))
    .innerJoin(schema.user, eq(schema.user.id, schema.mediaLinks.userId))
    .leftJoin(schema.clips, eq(schema.clips.id, schema.mediaLinks.clipId))
    .where(eq(schema.mediaLinks.tokenHash, hashToken(token)))
    .limit(1);
  if (!row) return miss;
  const { link, project, clip } = row;
  if (EXT[link.kind] !== ext.toLowerCase() || stateOf(link, now) !== "active" || project.deletedAt || row.banned || project.userId !== link.userId) return miss;
  const names = { projectTitle: project.title, clipIndex: clip?.index ?? null, clipTitle: clip?.title ?? null };
  const fileName = linkFileName(link.kind, names);
  if (link.kind === "export") return { ok: true, link, kind: link.kind, ownerId: link.userId, key: null, fileName, clip: null };
  if (!clip || clip.deletedAt) return miss;
  const key = link.kind === "clip" ? clip.outputKey : link.kind === "thumb" ? clip.thumbnailKey : null;
  const has = link.kind === "clip" || link.kind === "thumb" ? !!key : !!clip.captions;
  if (!has) {
    if (clip.status === "done" || clip.status === "failed")
      return {
        ok: false,
        status: 410,
        message: svc.settings.get().CLIP_RETENTION_DAYS
          ? `This clip's files were removed after ${svc.settings.get().CLIP_RETENTION_DAYS} days; re-render it to bring the link back.`
          : "This clip has no rendered file; re-render it to bring the link back.",
      };
    return { ok: false, status: 409, message: "This clip is being rendered; try again in a few minutes." };
  }
  return { ok: true, link, kind: link.kind, ownerId: link.userId, key, fileName, clip: { id: clip.id } };
}

/** Count a use, at most once a minute per link (a video fetched in Range parts is one write). */
export async function recordUse(db: Db, linkId: string): Promise<void> {
  await db
    .update(schema.mediaLinks)
    .set({ useCount: sql`${schema.mediaLinks.useCount} + 1`, lastUsedAt: new Date() })
    .where(
      and(
        eq(schema.mediaLinks.id, linkId),
        or(isNull(schema.mediaLinks.lastUsedAt), sql`${schema.mediaLinks.lastUsedAt} < now() - ${`${USE_WRITE_EVERY_MS / 1000} seconds`}::interval`),
      ),
    );
}

/** `reelsaw media-links` and MCP: one line per link. */
export function linkSummary(v: MediaLinkView, masked: boolean) {
  return {
    id: v.id,
    kind: v.kind,
    projectId: v.projectId,
    clipId: v.clipId,
    title: v.clipTitle ?? v.projectTitle,
    url: masked ? maskLinkUrl(v.url) : v.url,
    label: v.label,
    source: v.source,
    state: v.state,
    expiresAt: v.expiresAt,
    lastUsedAt: v.lastUsedAt,
    useCount: v.useCount,
  };
}
