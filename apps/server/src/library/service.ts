/**
 * Helpers for driving the intro/outro ("bumper") library from outside the web app (MCP tools, CLI).
 *
 * Most state changes are not re-implemented here: callers go through the `bumpers.*`, `projects.setBumpers` and
 * `clips.setBumpersMany` tRPC procedures (one path per transition). `updateBumperAsset` (rename, image length) is the
 * service function behind `bumpers.update`, the rename_bumper tool and `reelsaw bumpers rename`. This file also holds
 * what those procedures do not: mapping agent-friendly input onto them, the bounded URL download that
 * stands in for the browser upload, and the read-side view of which intro/outro a clip really gets.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { bodyChunks, fetchPublic, isPrivateAddress, UnsafeUrlError } from "../lib/safe-url.js";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { assetTagsSchema, bumperSecondsSchema, clipLayers, formatBytes, type AssetProvenance } from "@reelsaw/shared";
import type { Services } from "../services.js";
import type { appRouter } from "../trpc/router.js";
import { userDefaults } from "../pipeline/settings.js";
import { schema } from "../db/index.js";
import { keys } from "../storage/index.js";
import {
  ASSET_MIME,
  BUMPER_MAX_BYTES,
  BUMPER_IMAGE_SEC,
  resolveClipBumpers,
  bumperKind,
  assetKind,
  assetMime,
  bumperProblem,
  ensureBumperThumb,
  sha256File,
} from "../pipeline/bumpers.js";
import { svgSize, svgHasExternalRefs } from "../pipeline/raster.js";
import { takeTxLock, txLock } from "../locks.js";
import { assertStorageRoom } from "../quota.js";
import { assetVisibleTo } from "./visible.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { dropAssetStorage } from "../storage/sweep.js";
import { assetRefsReady } from "./refs.js";
import { templateAssetUses } from "./template-assets.js";
import { TRPCError } from "@trpc/server";
import type { Db } from "../db/index.js";
import { bumperCoverage, type BumperCoverage, type SlotCoverage } from "./summary.js";

export const FETCH_MAX_BYTES = BUMPER_MAX_BYTES;
export const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

const assetId = z.string().min(1).max(100);

/** Project slot choice: the user's current default, nothing, or a library asset id. */
export const projectChoiceSchema = z
  .union([z.enum(["default", "none"]), assetId])
  .describe('"default" = your current default intro/outro, "none" = no bumper, or a library asset id (see list_bumpers)');
/** Clip slot choice: follow the project, nothing, or a library asset id. */
export const clipChoiceSchema = z
  .union([z.enum(["inherit", "default", "none"]), assetId])
  .describe('"inherit" (alias "default") = follow the project, "none" = no bumper on this clip, or a library asset id');

export const setProjectBumpersInput = {
  projectId: z.string().describe("Project id (list_projects or create_project)"),
  intro: projectChoiceSchema.optional(),
  outro: projectChoiceSchema.optional(),
  introSec: bumperSecondsSchema
    .optional()
    .describe("Seconds an intro image shows in this project (1-10); videos keep their own length. Saved with the project"),
  outroSec: bumperSecondsSchema.optional().describe("Seconds an outro image shows in this project (1-10). Saved with the project"),
  rerender: z.boolean().describe("true = re-render the project's finished clips now; false = apply on their next render"),
};
export const setClipBumpersInput = {
  projectId: z.string().describe("Project the clips belong to (list_projects)"),
  clipIds: z.array(z.string()).min(1).max(200).describe("Clip ids of that project (get_project), 1-200 per call"),
  intro: clipChoiceSchema.optional(),
  outro: clipChoiceSchema.optional(),
  introSec: bumperSecondsSchema.optional().describe("Seconds an intro image shows on these clips (1-10)"),
  outroSec: bumperSecondsSchema.optional().describe("Seconds an outro image shows on these clips (1-10)"),
  rerender: z.boolean().describe("true = re-render only these clips now; false = apply on their next render"),
};
/** add_asset: exactly one of uploadId, url or provider + externalId (`library.add`); the url takes every format the library stores. */
export const addAssetInput = {
  url: z
    .url()
    .optional()
    .describe(
      "http(s) link to a video (MP4/MOV/WebM), image (PNG/JPG/WebP/GIF/SVG) or sound (MP3/M4A/AAC/WAV/OGG/FLAC); the server downloads it into your library (max 50 MB, 60 s)",
    ),
  uploadId: z.string().min(1).max(100).optional().describe("An existing upload id (from POST /api/upload) instead of a url"),
  provider: z
    .string()
    .min(1)
    .max(40)
    .optional()
    .describe(
      "A search_assets hit's provider (catalog or an enabled provider), together with externalId; materializes the instance-shared file instead of adding an upload",
    ),
  externalId: z.string().min(1).max(200).optional().describe("A search_assets hit's externalId, together with provider"),
  color: z.string().max(9).optional().describe("iconify hits only: icon color as hex, e.g. #ffffff (default white)"),
  name: z.string().min(1).max(120).optional().describe("Library name (url or uploadId; default: the file name). update_asset changes it later"),
  tags: assetTagsSchema.optional().describe("Search tags (lowercase words; max 20)"),
  imageSeconds: z.number().min(BUMPER_IMAGE_SEC.min).max(BUMPER_IMAGE_SEC.max).optional().describe("How long a still image shows as an intro/outro (1-10 s)"),
  setDefault: z.enum(["intro", "outro"]).optional().describe("Also make it your default intro or outro for new projects"),
};

/** The input of `projects.setBumpers` for a tool call. */
export function projectBumpersCall(i: z.infer<z.ZodObject<typeof setProjectBumpersInput>>) {
  const { projectId, ...rest } = i;
  return { id: projectId, ...rest };
}
/** The input of `clips.setBumpersMany`; "default" on a clip is the same thing as "inherit". */
export function clipBumpersCall(i: z.infer<z.ZodObject<typeof setClipBumpersInput>>) {
  const fix = (v: string | undefined) => (v === "default" ? "inherit" : v);
  return { ...i, intro: fix(i.intro), outro: fix(i.outro) };
}

/** A library item's display name. */
export const bumperNameSchema = z.string().trim().min(1).max(120);

/**
 * Rename a library item and/or change how long an image lasts (one of the user's own, removed ones included).
 * Assets are otherwise immutable; the normalised file is named by its seconds, so projects pick up a new length on
 * their next render. A name is only a label: nothing re-renders.
 */
export async function updateBumperAsset(
  svc: Services,
  userId: string,
  id: string,
  patch: { name?: string | undefined; imageSeconds?: number | undefined; tags?: string[] | undefined },
) {
  if (patch.name === undefined && patch.imageSeconds === undefined && patch.tags === undefined)
    throw new TRPCError({ code: "BAD_REQUEST", message: "Give a name, imageSeconds or tags" });
  return svc.tx(async (u) => {
    const [a] = await u.db
      .select()
      .from(schema.assets)
      .where(and(eq(schema.assets.id, id), assetVisibleTo(userId)))
      .for("update");
    if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "That item is not in your library" });
    if (!a.userId) throw new TRPCError({ code: "FORBIDDEN", message: "Shared items keep the name they came with." });
    if (patch.imageSeconds !== undefined && a.kind !== "image") throw new TRPCError({ code: "BAD_REQUEST", message: "Videos keep their own length" });
    const name = patch.name?.trim();
    // tags are lowercase words, each once; the same list is stored and returned
    const tags = patch.tags === undefined ? undefined : [...new Set(patch.tags.map((x) => x.trim().toLowerCase()).filter(Boolean))];
    await u.db
      .update(schema.assets)
      .set({
        ...(name ? { name } : {}),
        ...(patch.imageSeconds !== undefined ? { durationSec: patch.imageSeconds } : {}),
        ...(tags !== undefined ? { tags } : {}),
      })
      .where(eq(schema.assets.id, a.id));
    return { ok: true, id: a.id, name: name ?? a.name, durationSec: patch.imageSeconds ?? a.durationSec, tags: tags ?? a.tags, previousName: a.name };
  });
}

/** Set (or clear) the user's default intro/outro: one atomic JSON merge, visibility and liveness checked in the same unit of work. */
export async function setBumperDefault(db: Db, userId: string, slot: "intro" | "outro", assetId: string | null) {
  const key = slot === "intro" ? "introAssetId" : "outroAssetId";
  if (!assetId) {
    await db.execute(sql`update user_settings set project_defaults = project_defaults - ${key}::text, updated_at = now() where user_id = ${userId}`);
    return;
  }
  const [asset] = await db
    .select({ id: schema.assets.id })
    .from(schema.assets)
    .where(and(eq(schema.assets.id, assetId), assetVisibleTo(userId), isNull(schema.assets.deletedAt)));
  if (!asset) throw new TRPCError({ code: "NOT_FOUND", message: "Intro or outro not found" });
  const patch = { [key]: assetId };
  await db
    .insert(schema.userSettings)
    .values({ userId, projectDefaults: patch })
    .onConflictDoUpdate({
      target: schema.userSettings.userId,
      set: { projectDefaults: sql`${schema.userSettings.projectDefaults} || ${JSON.stringify(patch)}::jsonb`, updatedAt: new Date() },
    });
}

export interface CreateAssetInput {
  /** the owner of the new row; null = an instance-shared row, only the catalog / provider import passes it (never the web or MCP) */
  userId: string | null;
  /** the account whose upload holds the bytes (and who is importing, for a shared row) */
  actorId: string;
  uploadId: string;
  imageSeconds?: number | undefined;
  setDefault?: "intro" | "outro" | undefined;
  name?: string | undefined;
  tags?: string[] | undefined;
  provenance?: AssetProvenance;
  system?: boolean;
}
export interface CreatedAsset {
  id: string;
  name: string;
  kind: string;
  mime: string | null;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
  duplicate: boolean;
  restored: boolean;
}

/** The key of a shared row: one per (provider, externalId, variant) on the whole instance. */
export function sharedSourceKey(p: Pick<AssetProvenance, "provider" | "externalId" | "variant"> | null | undefined) {
  return p?.provider && p.externalId ? { provider: p.provider, externalId: p.externalId, variant: p.variant ?? "" } : null;
}
export const sharedSourceWhere = (k: { provider: string; externalId: string; variant: string }) =>
  sql`${schema.assets.userId} is null and ${schema.assets.deletedAt} is null and ${schema.assets.provenance}->>'provider' = ${k.provider} and ${schema.assets.provenance}->>'externalId' = ${k.externalId} and coalesce(${schema.assets.provenance}->>'variant', '') = ${k.variant}`;

/**
 * Validate an uploaded file with ffprobe and add it to the library: the one path behind `bumpers.create` (an account's
 * own row) and the catalog / provider import (an instance-shared row, `userId: null`). The content-hash dedupe is
 * scoped to the same owner (null = shared); a shared row is also unique per source item (the lock and the partial
 * unique index), so two accounts importing the same item at once converge on one row.
 */
export async function createAsset(svc: Services, input: CreateAssetInput): Promise<CreatedAsset> {
  const { userId, actorId } = input;
  const shared = userId === null;
  const sourceKey = shared ? sharedSourceKey(input.provenance) : null;
  if (shared && !sourceKey) throw new TRPCError({ code: "BAD_REQUEST", message: "A shared item needs its source" });
  const up = await svc.database.db.query.uploads.findFirst({ where: and(eq(schema.uploads.id, input.uploadId), eq(schema.uploads.userId, actorId)) });
  if (!up) throw new TRPCError({ code: "NOT_FOUND", message: "Upload not found" });
  const ext = path.extname(up.filename).toLowerCase();
  // the extension's guess; a GIF or WebP is re-decided from the probe below (animated = video)
  let kind = bumperKind(ext) ?? "video";
  const id = randomUUID();
  const local = path.join(svc.paths.tmp, `bumper-${id}${ext}`);
  const ownerIs = (col: typeof schema.assets.userId) => (userId === null ? isNull(col) : eq(col, userId));
  try {
    // cheap checks first so a huge file is not pulled out of storage just to be refused
    const early = bumperProblem(input.setDefault, { ext, sizeBytes: up.sizeBytes }, { durationSec: 1, width: 1000, height: 1000 });
    if (early) throw new TRPCError({ code: "BAD_REQUEST", message: early });
    await fs.mkdir(svc.paths.tmp, { recursive: true });
    await svc.storage.ensureLocal(up.storageKey, local);
    // ffprobe cannot size an SVG reliably (and not every ffmpeg build reads one): resvg gives its size
    const svgText = ext === ".svg" ? await fs.readFile(local) : null;
    if (svgText && svgHasExternalRefs(svgText))
      throw new TRPCError({ code: "BAD_REQUEST", message: "This SVG links to other files. Embed its images, or export it as a PNG." });
    const svgDims = svgText ? svgSize(svgText) : null;
    const probe =
      ext === ".svg"
        ? svgDims
          ? { durationSec: 0, width: svgDims.width, height: svgDims.height, hasAudio: false }
          : null
        : await svc.media.ffprobe(local).catch(() => null);
    if (!probe)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `This file could not be read as ${kind === "image" ? "an image" : kind === "audio" ? "audio" : "a video"}.`,
      });
    kind = assetKind(ext, probe) ?? kind;
    const problem = bumperProblem(input.setDefault, { ext, sizeBytes: up.sizeBytes }, probe);
    if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
    const storageKey = keys.asset(id, ext);
    const contentHash = await sha256File(local);
    // the object goes in first (as in the upload route): a row must never point at a missing file, and a failed
    // transaction or a duplicate leaves an unreferenced object that is removed below
    await svc.storage.putFile(storageKey, local);
    // the picker thumbnail (none for audio); if this fails the media route makes it on first request
    const thumbKey =
      kind === "audio"
        ? null
        : await ensureBumperThumb(
            { ffmpeg: (a) => svc.media.ffmpeg(a), storage: svc.storage, dir: svc.paths.tmp },
            { id, kind, durationSec: probe.durationSec, sourceKey: storageKey, mime: assetMime(ext) },
            local,
          ).catch(() => null);
    let stored = false;
    const row = await svc
      .tx(async (u) => {
        const keep = async (asset: typeof schema.assets.$inferSelect, restored: boolean) => {
          if (input.setDefault) await setBumperDefault(u.db, actorId, input.setDefault, asset.id);
          return { asset, duplicate: true as const, restored };
        };
        if (sourceKey) {
          await takeTxLock(u.db, txLock.sharedAsset(sourceKey.provider, sourceKey.externalId, sourceKey.variant));
          const [existing] = await u.db.select().from(schema.assets).where(sharedSourceWhere(sourceKey)).limit(1);
          if (existing) return keep(existing, false);
        }
        // one upload of a given file at a time per owner (all shared rows count as one owner), so two racing copies cannot both insert
        await takeTxLock(u.db, txLock.asset(userId ?? "shared", contentHash));
        const [same] = await u.db
          .select()
          .from(schema.assets)
          .where(and(ownerIs(schema.assets.userId), eq(schema.assets.contentHash, contentHash)))
          .orderBy(sql`(${schema.assets.deletedAt} is not null)`)
          .limit(1);
        if (same) {
          const wasRemoved = !!same.deletedAt;
          if (wasRemoved) await u.db.update(schema.assets).set({ deletedAt: null }).where(eq(schema.assets.id, same.id));
          return keep(same, wasRemoved);
        }
        // ownership is re-checked in the unit of work that writes
        const [still] = await u.db
          .select({ id: schema.uploads.id })
          .from(schema.uploads)
          .where(and(eq(schema.uploads.id, up.id), eq(schema.uploads.userId, actorId)));
        if (!still) throw new TRPCError({ code: "NOT_FOUND", message: "Upload not found" });
        const [asset] = await u.db
          .insert(schema.assets)
          .values({
            id,
            userId,
            kind,
            mime: assetMime(ext),
            tags: input.tags ?? [],
            ...(input.provenance
              ? { provenance: { ...input.provenance, ...(sourceKey ? { variant: sourceKey.variant } : {}), importedAt: new Date().toISOString() } }
              : {}),
            system: input.system ?? false,
            name: input.name?.trim() || up.filename.replace(/\.[^.]+$/, "").slice(0, 120) || "Untitled",
            durationSec: kind === "image" ? (input.imageSeconds ?? BUMPER_IMAGE_SEC.default) : probe.durationSec,
            // audio has no picture: bumperProblem already refused images/videos without dimensions
            width: probe.width ?? 0,
            height: probe.height ?? 0,
            hasAudio: kind === "audio" || (kind === "video" && probe.hasAudio),
            sourceKey: storageKey,
            thumbnailKey: thumbKey,
            sizeBytes: up.sizeBytes,
            contentHash,
          })
          .returning();
        if (input.setDefault) await setBumperDefault(u.db, actorId, input.setDefault, id);
        u.afterCommit(() => {
          stored = true; // set by the commit itself: a retried attempt of this unit never leaves it true
        });
        return { asset: asset!, duplicate: false as const, restored: false };
      })
      .finally(async () => {
        if (!stored)
          await dropAssetStorage(svc, storageKey).catch((err) => svc.log.warn({ err, assetId: id }, "could not remove the unreferenced library object"));
      });
    await fs.rm(local, { force: true }).catch(() => {});
    const a = row.asset;
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      mime: a.mime,
      durationSec: a.durationSec,
      width: a.width,
      height: a.height,
      hasAudio: a.hasAudio,
      duplicate: row.duplicate,
      restored: row.restored,
    };
  } catch (err) {
    await fs.rm(local, { force: true }).catch(() => {});
    throw err;
  }
}

/** `library.add` takes exactly one source: an upload, a link, or a catalog / provider result (provider + externalId together). */
export function requireOneSource(i: {
  url?: string | undefined;
  uploadId?: string | undefined;
  provider?: string | undefined;
  externalId?: string | undefined;
}) {
  if (!!i.provider !== !!i.externalId) throw new Error("provider and externalId go together");
  if ([i.url, i.uploadId, i.provider].filter(Boolean).length !== 1) throw new Error("Give exactly one of uploadId, url or provider + externalId");
}

// ── bounded download ───────────────────────────────────────────────────────

/** Every format the library stores (ASSET_MIME); `bumpers.create` then probes the file and refuses what it cannot use. */
const ALLOWED_EXTS: readonly string[] = Object.keys(ASSET_MIME);
const TYPE_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_MIME)
    .reverse()
    .map(([ext, mime]) => [mime, ext]),
);

/** One SSRF check for the whole server (lib/safe-url.ts): it knows hex-mapped IPv6, internal names and metadata hosts. */
export { isPrivateAddress };

export interface FetchDeps {
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
}

/**
 * The uploads row for an object already in storage, inserted only when the account has room (MAX_STORAGE_MB, checked under
 * its quota lock in the same transaction). Without room the object is removed again and the storage refusal is thrown.
 */
export async function insertUploadWithinQuota(svc: Services, row: typeof schema.uploads.$inferInsert): Promise<void> {
  try {
    await svc.tx(async (u) => {
      await assertStorageRoom(svc, u, row.userId, row.sizeBytes);
      await u.db.insert(schema.uploads).values(row);
    });
  } catch (err) {
    await svc.storage
      .delete(row.storageKey)
      .catch((e) => svc.log.warn({ err: e, storageKey: row.storageKey }, "could not remove an upload object that was refused"));
    throw err;
  }
}

/**
 * Download `url` into the uploads table exactly as POST /api/upload would (same storage key, same row), so
 * `bumpers.create` takes it from there with its own type, size and ffprobe checks. Max 50 MB, 60 s, 3 redirects.
 */
export async function downloadAsUpload(
  svc: Services,
  userId: string,
  url: string,
  deps: FetchDeps & { name?: string | undefined; ext?: string } = {},
): Promise<{ uploadId: string; filename: string; sizeBytes: number }> {
  const lookup = deps.lookup ?? (async (h: string) => (await dnsLookup(h, { all: true })).map((a) => a.address));
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  // resolved once, checked, and connected to at that address, hop by hop (lib/safe-url.ts): a name cannot rebind to a private address in between
  const fetched = await fetchPublic(url, {
    lookup: async (h) => (await lookup(h)).map((address) => ({ address })),
    maxRedirects: MAX_REDIRECTS,
    signal,
    fetch: deps.fetch ? (u, init) => deps.fetch!(u, init) : undefined,
  }).catch((err) => {
    // the shared message points at ALLOW_PRIVATE_SOURCE_URLS, which governs project sources, not the library
    if (err instanceof UnsafeUrlError && !/http|username|valid link/.test(err.message))
      throw new Error("That address is not reachable from the server (private or unresolvable)");
    throw err;
  });
  const { res, url: target } = fetched;
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > FETCH_MAX_BYTES) throw new Error(`The file is ${Math.ceil(declared / 1024 / 1024)} MB; the limit is ${FETCH_MAX_BYTES / 1024 / 1024} MB`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const urlExt = path.extname(target.pathname).toLowerCase();
  // an import that knows what it is fetching (a provider's resolve) can force the extension
  const forced = deps.ext ? (deps.ext.startsWith(".") ? deps.ext : `.${deps.ext}`).toLowerCase() : undefined;
  const ext = forced ?? (ALLOWED_EXTS.includes(urlExt) ? urlExt : TYPE_EXT[type]);
  if (!ext) throw new Error("Use a video (MP4, MOV, WebM), an image (PNG, JPG, WebP, GIF, SVG) or a sound (MP3, M4A, AAC, WAV, OGG, FLAC).");
  const id = randomUUID();
  const dest = path.join(svc.paths.uploads, `${id}${ext}`);
  try {
    await fs.mkdir(svc.paths.uploads, { recursive: true });
    let seen = 0;
    const capped = Readable.from(bodyChunks(res)).map((chunk: Buffer) => {
      seen += chunk.length;
      if (seen > FETCH_MAX_BYTES) throw new Error(`The file is larger than ${FETCH_MAX_BYTES / 1024 / 1024} MB`);
      return chunk;
    });
    await pipeline(capped, createWriteStream(dest), { signal });
    const size = (await fs.stat(dest)).size;
    if (size === 0) throw new Error("The download was empty");
    // `bumpers.create` names the asset after the upload's filename, so a requested name goes there
    const base = deps.name ? `${deps.name.replace(/[\\/]/g, "_")}${ext}` : decodeURIComponent(path.basename(target.pathname)).replace(/[\\/]/g, "_");
    const filename = (base && path.extname(base).toLowerCase() === ext ? base : `${base || "bumper"}${ext}`).slice(0, 200);
    const storageKey = keys.upload(id, ext);
    await svc.storage.putFile(storageKey, dest);
    await insertUploadWithinQuota(svc, { id, userId, filename, storageKey, sizeBytes: size });
    svc.log.child({ module: "bumpers", userId }).info({ uploadId: id, host: target.host, bytes: size }, "bumper downloaded from a link");
    return { uploadId: id, filename, sizeBytes: size };
  } finally {
    await fs.rm(dest, { force: true }).catch(() => {});
  }
}

/** A file on this machine as an uploads row (what POST /api/upload makes), for `reelsaw library add <file>`. */
export async function uploadLocalFile(svc: Services, userId: string, file: string): Promise<{ uploadId: string; filename: string; sizeBytes: number }> {
  const st = await fs.stat(file).catch(() => null);
  if (!st?.isFile()) throw new Error(`${file} is not a file`);
  if (st.size === 0) throw new Error("The file is empty");
  if (st.size > FETCH_MAX_BYTES) throw new Error(`The file is ${Math.ceil(st.size / 1024 / 1024)} MB; the limit is ${FETCH_MAX_BYTES / 1024 / 1024} MB`);
  const ext = path.extname(file).toLowerCase();
  if (!ALLOWED_EXTS.includes(ext)) throw new Error(`${ext || "That file type"} is not a library format (video, image or sound)`);
  const id = randomUUID();
  const filename = path.basename(file).slice(0, 200);
  const storageKey = keys.upload(id, ext);
  await svc.storage.putFile(storageKey, file);
  await insertUploadWithinQuota(svc, { id, userId, filename, storageKey, sizeBytes: st.size });
  return { uploadId: id, filename, sizeBytes: st.size };
}

// ── read side ──────────────────────────────────────────────────────────────

export interface AssetRef {
  id: string;
  name: string;
  kind: "video" | "image" | "audio";
  durationSec: number;
}
type Slot = "intro" | "outro";
export interface EffectiveSlot {
  assetId: string | null;
  name: string | null;
  seconds: number | null;
  source: "clip" | "project" | "none";
}

/**
 * The intro and outro a clip gets when it renders, and who decided: the clip itself, or the project's
 * settings (a snapshot of the user's default at creation unless changed since). Seconds fall back to the asset's own length.
 */
export function effectiveBumpers(
  project: { introAssetId?: string | null | undefined; outroAssetId?: string | null | undefined; introSec?: number | undefined; outroSec?: number | undefined },
  clip: {
    bumpers?: { intro?: string | null | undefined; outro?: string | null | undefined; introSec?: number | undefined; outroSec?: number | undefined } | null;
  },
  assets: Map<string, AssetRef>,
): Record<Slot, EffectiveSlot> {
  const r = resolveClipBumpers(project, clip);
  const slot = (s: Slot): EffectiveSlot => {
    const id = s === "intro" ? r.introId : r.outroId;
    if (!id) return { assetId: null, name: null, seconds: null, source: "none" };
    const a = assets.get(id);
    const secs = s === "intro" ? r.introSec : r.outroSec;
    return { assetId: id, name: a?.name ?? null, seconds: secs ?? a?.durationSec ?? null, source: r.fromClip.includes(s) ? "clip" : "project" };
  };
  return { intro: slot("intro"), outro: slot("outro") };
}

export const assetMap = (list: AssetRef[]) => new Map(list.map((a) => [a.id, a]));

type Api = ReturnType<typeof appRouter.createCaller>;

/** The library as an agent or operator wants to read it: `bumpers.list` plus which asset is the user's default intro and outro. */
export async function libraryView(
  svc: Services,
  api: Api,
  userId: string,
  abs: (p: string) => string = (p) => p,
  page: { limit?: number; cursor?: string } = {},
) {
  const [lib, defaults] = await Promise.all([api.library.list({ limit: page.limit ?? 500, cursor: page.cursor }), userDefaults(svc.database.db, userId)]);
  const row = (a: (typeof lib.items)[number]) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    durationSec: a.durationSec,
    width: a.width,
    height: a.height,
    isDefaultIntro: defaults.introAssetId === a.id,
    isDefaultOutro: defaults.outroAssetId === a.id,
    mime: a.mime,
    owner: a.owner,
    tags: a.tags,
    provenance: a.provenance,
    system: a.system,
    usedBy: a.usedBy,
    usedByClips: a.usedByClips,
    usedByTemplates: a.usedByTemplates,
    thumbnailUrl: abs(a.thumbnailUrl),
    /** the file itself (play the music, view the image or video); same auth as this server */
    url: abs(`/media/assets/${a.id}`),
  });
  return { assets: lib.items.map(row), nextCursor: lib.nextCursor, total: lib.total, deleted: lib.deleted.map(row) };
}

// ---------- project coverage summaries (Projects list, projects.get, reelsaw status) ----------

export interface SlotSummary {
  assetId: string;
  name: string;
  kind: "video" | "image" | "audio";
  thumbnailUrl: string;
  withCount: number;
  total: number;
  /** clips using a different asset in this slot */
  otherCount: number;
  /** clips with nothing in this slot */
  noneCount: number;
  /** every distinct asset used in this slot (soft-deleted ones included), most used first */
  assets: { assetId: string; name: string; kind: "video" | "image" | "audio"; thumbnailUrl: string; withCount: number }[];
}
export interface ProjectBumperSummary {
  intro: SlotSummary | null;
  outro: SlotSummary | null;
}
export async function projectBumperSummaries(
  db: Db,
  userId: string,
  projects: {
    id: string;
    settings: { introAssetId?: string | null | undefined; outroAssetId?: string | null | undefined } | null;
    clips: { bumpers?: { intro?: string | null | undefined; outro?: string | null | undefined } | null }[];
  }[],
): Promise<Map<string, ProjectBumperSummary>> {
  const coverage = new Map<string, BumperCoverage>(projects.map((p) => [p.id, bumperCoverage(p, p.clips)]));
  const ids = new Set<string>();
  for (const c of coverage.values()) for (const s of [c.intro, c.outro]) if (s) for (const a of s.assets) ids.add(a.assetId);
  const assets = ids.size
    ? await db
        .select({ id: schema.assets.id, name: schema.assets.name, kind: schema.assets.kind })
        .from(schema.assets)
        .where(and(assetVisibleTo(userId), inArray(schema.assets.id, [...ids])))
    : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const slot = (s: SlotCoverage | null): SlotSummary | null => {
    const a = s && byId.get(s.assetId);
    if (!s || !a) return null;
    const assets = s.assets.flatMap((x) => {
      const r = byId.get(x.assetId);
      return r ? [{ assetId: r.id, name: r.name, kind: r.kind, thumbnailUrl: `/media/assets/${r.id}/thumb.jpg`, withCount: x.count }] : [];
    });
    return {
      assets,
      assetId: s.assetId,
      name: a.name,
      kind: a.kind,
      thumbnailUrl: `/media/assets/${a.id}/thumb.jpg`,
      withCount: s.withCount,
      total: s.total,
      otherCount: s.others.reduce((n, o) => n + o.count, 0),
      noneCount: s.noneCount,
    };
  };
  return new Map([...coverage].map(([id, c]) => [id, { intro: slot(c.intro), outro: slot(c.outro) }]));
}

/**
 * Per asset id, the projects and clips that use it: one grouped query over `asset_refs` (docs/specs/library.md #4).
 * A project counts once however many of its rows name the asset; a clip counts when it names the asset itself
 * (its own intro / outro or a layer; a clip that merely inherits the project's intro is counted through the project).
 * Deleted projects and clips a re-analyze replaced are left out.
 */
export async function bumperUsageCounts(
  db: Db,
  userId: string,
): Promise<Map<string, { projects: number; clips: number; templates: number; roles: Array<"intro" | "outro" | "layer" | "template"> }>> {
  const res = await db.execute(sql`
    select r.asset_id as asset_id, count(distinct r.project_id)::int as projects, count(distinct r.clip_id)::int as clips, array_agg(distinct r.role) as roles
    from asset_refs r
    join projects p on p.id = r.project_id and p.user_id = ${userId} and p.deleted_at is null
    left join clips c on c.id = r.clip_id
    where r.clip_id is null or c.deleted_at is null
    group by r.asset_id`);
  const out = new Map(
    (res.rows as Array<{ asset_id: string; projects: number; clips: number; roles: Array<"intro" | "outro" | "layer"> }>).map((r) => [
      r.asset_id,
      { projects: r.projects, clips: r.clips, templates: 0, roles: [...(r.roles ?? [])] as Array<"intro" | "outro" | "layer" | "template"> },
    ]),
  );
  // the user's live layer templates name assets in their layers and intro / outro (templateAssetUses)
  const tpl = await db.execute<{ asset_id: string; templates: number }>(sql`
    select tu.asset_id, count(distinct tu.template_id)::int as templates
    from (${templateAssetUses}) tu
    where tu.user_id = ${userId} and tu.deleted_at is null
    group by tu.asset_id`);
  for (const r of tpl.rows) {
    const cur = out.get(r.asset_id) ?? { projects: 0, clips: 0, templates: 0, roles: [] };
    cur.templates = r.templates;
    cur.roles.push("template");
    out.set(r.asset_id, cur);
  }
  return out;
}

/** A live layer template that names the asset; `layers` = how many of its layers do, `slots` = as its intro / outro. */
export type AssetUsageTemplate = { id: string; name: string; layers: number; slots: Array<"intro" | "outro"> };

/** The user's live layer templates that name an asset, with how many layers do and whether it is their intro / outro. */
export async function templateAssetUsage(db: Db, userId: string, assetId: string): Promise<AssetUsageTemplate[]> {
  const res = await db.execute<AssetUsageTemplate>(sql`
    select tu.template_id as id, tu.name as name,
      (count(*) filter (where tu.role = 'layer'))::int as layers,
      coalesce(array_agg(tu.role order by tu.role) filter (where tu.role <> 'layer'), '{}') as slots
    from (${templateAssetUses}) tu
    where tu.user_id = ${userId} and tu.deleted_at is null and tu.asset_id = ${assetId}
    group by tu.template_id, tu.name, tu.updated_at
    order by tu.updated_at desc
    limit 200`);
  return res.rows;
}

export interface AssetUsageClip {
  id: string;
  index: number;
  title: string;
  slots: Array<"intro" | "outro" | "overlay" | "music">;
  via: "clip" | "project";
  overlays: number;
  music: number;
}
export interface AssetUsageProject {
  id: string;
  title: string;
  slots: Array<"intro" | "outro">;
  via: "project";
  clips: AssetUsageClip[];
}

/**
 * Every project and clip that uses an asset, and why: the project's default or override, or the clip's own choice
 * or layer. Reads `asset_refs` for the asset, then only the clips those rows name (plus the clips of projects whose
 * settings name it, to see who inherits). Clips a re-analyze replaced are skipped (they render nowhere; their rows
 * still keep the asset from being purged until the clip itself is purged). A layer counts as `overlays` for image /
 * video / text layers and as `music` for audio layers.
 */
export async function bumperAssetUsage(db: Db, userId: string, assetId: string): Promise<{ projects: AssetUsageProject[]; templates: AssetUsageTemplate[] }> {
  const templates = await templateAssetUsage(db, userId, assetId);
  const slots = ["intro", "outro"] as const;
  const key = { intro: "introAssetId", outro: "outroAssetId" } as const;
  const refs = await db
    .select({ projectId: schema.assetRefs.projectId, clipId: schema.assetRefs.clipId, title: schema.projects.title, settings: schema.projects.settings })
    .from(schema.assetRefs)
    .innerJoin(schema.projects, eq(schema.assetRefs.projectId, schema.projects.id))
    .where(and(eq(schema.assetRefs.assetId, assetId), eq(schema.projects.userId, userId), isNull(schema.projects.deletedAt)))
    .limit(5000);
  const projects = new Map<string, { title: string; settings: (typeof refs)[number]["settings"] }>();
  const clipIds = new Set<string>();
  const projectLevel = new Set<string>();
  for (const r of refs) {
    projects.set(r.projectId, { title: r.title, settings: r.settings });
    if (r.clipId) clipIds.add(r.clipId);
    else projectLevel.add(r.projectId);
  }
  if (!projects.size) return { projects: [], templates };
  const cols = {
    id: schema.clips.id,
    projectId: schema.clips.projectId,
    index: schema.clips.index,
    title: schema.clips.title,
    bumpers: schema.clips.bumpers,
    layers: schema.clips.layers,
    overlays: schema.clips.overlays,
    audio: schema.clips.audio,
  };
  const where = [
    clipIds.size ? inArray(schema.clips.id, [...clipIds]) : undefined,
    projectLevel.size ? inArray(schema.clips.projectId, [...projectLevel]) : undefined,
  ].filter((x) => x !== undefined);
  const clipRows = await db
    .select(cols)
    .from(schema.clips)
    .where(and(isNull(schema.clips.deletedAt), sql`(${sql.join(where, sql` or `)})`))
    .orderBy(schema.clips.index)
    .limit(5000);
  const out = new Map<string, AssetUsageProject>();
  for (const [id, p] of projects) out.set(id, { id, title: p.title, via: "project", slots: slots.filter((s) => p.settings[key[s]] === assetId), clips: [] });
  const hasClips = new Set<string>();
  for (const c of clipRows) {
    hasClips.add(c.projectId);
    const p = out.get(c.projectId);
    if (!p) continue;
    const settings = projects.get(c.projectId)!.settings;
    const own = c.bumpers ?? {};
    const mine = slots.filter((s) => own[s] === assetId);
    // a slot the clip leaves alone follows the project
    const inherited = slots.filter((s) => own[s] === undefined && settings[key[s]] === assetId);
    const layers = clipLayers(c);
    const overlays = layers.filter((l) => l.kind !== "audio" && l.kind !== "text" && l.assetId === assetId).length;
    const music = layers.filter((l) => l.kind === "audio" && l.assetId === assetId).length;
    if (!mine.length && !inherited.length && !overlays && !music) continue;
    const roles: AssetUsageClip["slots"] = [
      ...slots.filter((s) => mine.includes(s) || inherited.includes(s)),
      ...(overlays ? (["overlay"] as const) : []),
      ...(music ? (["music"] as const) : []),
    ];
    p.clips.push({ id: c.id, index: c.index, title: c.title, slots: roles, via: mine.length || overlays || music ? "clip" : "project", overlays, music });
  }
  // a project whose settings name the asset only counts when a clip really resolves to it (or it has no clips yet)
  for (const [id, p] of out) if (!p.clips.length && hasClips.has(id)) out.delete(id);
  return { projects: [...out.values()], templates };
}

/** Undo a removal of one of your uploads. tRPC `library.restore`, MCP `restore_asset` and Deleted all call this. */
export async function restoreOwnedAsset(svc: Services, userId: string, assetId: string) {
  return svc.tx(async (u) => {
    const r = await u.db
      .update(schema.assets)
      .set({ deletedAt: null })
      .where(and(eq(schema.assets.id, assetId), eq(schema.assets.userId, userId)))
      .returning({ id: schema.assets.id });
    if (!r.length) throw new TRPCError({ code: "NOT_FOUND", message: "That item is not in your library" });
    return { ok: true as const };
  });
}

/**
 * Remove one of your already-deleted library uploads for good. Refused while a project, clip or live template still
 * names it (those keep rendering with the file). Storage is freed after commit.
 */
export async function purgeOwnedAsset(svc: Services, userId: string, assetId: string) {
  return svc.tx(async (u) => {
    const [a] = await u.db
      .select({
        id: schema.assets.id,
        name: schema.assets.name,
        deletedAt: schema.assets.deletedAt,
        sourceKey: schema.assets.sourceKey,
        sizeBytes: schema.assets.sizeBytes,
      })
      .from(schema.assets)
      .where(and(eq(schema.assets.id, assetId), eq(schema.assets.userId, userId)))
      .for("update");
    if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "That item is not in your library" });
    if (!a.deletedAt) throw new TRPCError({ code: "BAD_REQUEST", message: "Remove it first. Only library items already in Deleted can be deleted forever." });
    // "still named" is read from asset_refs, which may miss old projects until its backfill is done (the sweep waits too)
    if (!(await assetRefsReady(u.db)))
      throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The library is still indexing which projects use what. Try again in a few minutes." });
    const ref = await u.db.execute(sql`select exists (select 1 from asset_refs where asset_id = ${assetId}) as used`);
    const used = !!(ref.rows[0] as { used: boolean } | undefined)?.used;
    const tpl = await u.db.execute(
      sql`select exists (select 1 from (${templateAssetUses}) tu where tu.deleted_at is null and tu.asset_id = ${assetId}) as used`,
    );
    const inTemplate = !!(tpl.rows[0] as { used: boolean } | undefined)?.used;
    if (used || inTemplate) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: used
          ? "A project or clip still names this item. Restore or purge those first; the file stays so they keep rendering."
          : "A layer template still names this item. Remove it from the template first.",
      });
    }
    await u.db.delete(schema.assets).where(eq(schema.assets.id, assetId));
    u.afterCommit(async () => {
      try {
        await dropAssetStorage(svc, a.sourceKey);
      } catch (err) {
        svc.log.child({ module: "library", assetId }).warn({ err }, "removed a library item but could not delete its files");
      }
    });
    return {
      ok: true as const,
      storedBytes: a.sizeBytes,
      message: a.sizeBytes ? `Deleted forever. ${formatBytes(a.sizeBytes)} is free now.` : "Deleted forever.",
    };
  });
}
