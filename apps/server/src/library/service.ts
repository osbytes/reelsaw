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
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { assetCategorySchema, assetTagsSchema, bumperSecondsSchema, clipLayers, type AssetCategory } from "@reelsaw/shared";
import type { Services } from "../services.js";
import type { appRouter } from "../trpc/router.js";
import { userDefaults } from "../pipeline/settings.js";
import { schema } from "../db/index.js";
import { keys } from "../storage/index.js";
import { ASSET_MIME, BUMPER_MAX_BYTES, BUMPER_IMAGE_SEC, resolveClipBumpers } from "../pipeline/bumpers.js";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { Db } from "../db/index.js";
import { bumperCoverage, type BumperCoverage, type SlotCoverage } from "./summary.js";

export const FETCH_MAX_BYTES = BUMPER_MAX_BYTES;
export const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

const assetId = z.string().min(1).max(100);

/** Project slot choice: the user's current default, nothing, or a library asset id. */
export const projectChoiceSchema = z.union([z.enum(["default", "none"]), assetId]).describe('"default" = your current default intro/outro, "none" = no bumper, or a library asset id (see list_bumpers)');
/** Clip slot choice: follow the project, nothing, or a library asset id. */
export const clipChoiceSchema = z.union([z.enum(["inherit", "default", "none"]), assetId]).describe('"inherit" (alias "default") = follow the project, "none" = no bumper on this clip, or a library asset id');

export const setProjectBumpersInput = {
  projectId: z.string().describe("Project id (list_projects or create_project)"),
  intro: projectChoiceSchema.optional(),
  outro: projectChoiceSchema.optional(),
  introSec: bumperSecondsSchema.optional().describe("Seconds an intro image shows in this project (1-10); videos keep their own length. Saved with the project"),
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
/** add_asset: add_bumper plus a category and tags; the url takes every format the library stores. */
export const addAssetInput = {
  url: z.url().optional().describe("http(s) link to a video (MP4/MOV/WebM), image (PNG/JPG/WebP/GIF/SVG) or sound (MP3/M4A/AAC/WAV/OGG/FLAC); the server downloads it (max 50 MB, 60 s)"),
  uploadId: z.string().min(1).max(100).optional().describe("An existing upload id (from POST /api/upload) instead of a url"),
  name: z.string().min(1).max(120).optional().describe("Library name (url only; default: the file name). update_asset changes it later"),
  category: assetCategorySchema.optional().describe("What it is for: intro, outro, logo, sticker, icon, broll, music or sfx (default: sfx / music by length for audio)"),
  tags: assetTagsSchema.optional().describe("Search tags (lowercase words; max 20)"),
  imageSeconds: z.number().min(BUMPER_IMAGE_SEC.min).max(BUMPER_IMAGE_SEC.max).optional().describe("How long a still image shows as an intro/outro (1-10 s)"),
  setDefault: z.enum(["intro", "outro"]).optional().describe("Also make it your default intro or outro for new projects"),
};
export const addBumperInput = {
  url: z.url().optional().describe("http(s) link to an MP4/MOV/WebM (max 10 s) or PNG/JPG; the server downloads it (max 50 MB, 60 s)"),
  uploadId: z.string().min(1).max(100).optional().describe("An existing upload id (from POST /api/upload) instead of a url"),
  name: z.string().min(1).max(120).optional().describe("Library name (url only; default: the file name). rename_bumper changes it later"),
  imageSeconds: z.number().min(BUMPER_IMAGE_SEC.min).max(BUMPER_IMAGE_SEC.max).optional().describe("How long an image shows (1-10 s)"),
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
export async function updateBumperAsset(svc: Services, userId: string, id: string, patch: { name?: string; imageSeconds?: number; category?: AssetCategory | null; tags?: string[] }) {
  if (patch.name === undefined && patch.imageSeconds === undefined && patch.category === undefined && patch.tags === undefined) throw new TRPCError({ code: "BAD_REQUEST", message: "Give a name, imageSeconds, category or tags" });
  return svc.tx(async (u) => {
    const [a] = await u.db.select().from(schema.libraryAssets).where(and(eq(schema.libraryAssets.id, id), eq(schema.libraryAssets.userId, userId))).for("update");
    if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "That item is not in your library" });
    if (patch.imageSeconds !== undefined && a.kind !== "image") throw new TRPCError({ code: "BAD_REQUEST", message: "Videos keep their own length" });
    const name = patch.name?.trim();
    // tags are lowercase words, each once; the same list is stored and returned
    const tags = patch.tags === undefined ? undefined : [...new Set(patch.tags.map((x) => x.trim().toLowerCase()).filter(Boolean))];
    await u.db
      .update(schema.libraryAssets)
      .set({ ...(name ? { name } : {}), ...(patch.imageSeconds !== undefined ? { durationSec: patch.imageSeconds } : {}), ...(patch.category !== undefined ? { category: patch.category } : {}), ...(tags !== undefined ? { tags } : {}) })
      .where(eq(schema.libraryAssets.id, a.id));
    return { ok: true, id: a.id, name: name ?? a.name, durationSec: patch.imageSeconds ?? a.durationSec, category: patch.category !== undefined ? patch.category : a.category, tags: tags ?? a.tags, previousName: a.name };
  });
}

export function requireOneSource(i: { url?: string; uploadId?: string }) {
  if (!!i.url === !!i.uploadId) throw new Error("Give exactly one of url or uploadId");
}

// ── bounded download ───────────────────────────────────────────────────────

/** Every format the library stores (ASSET_MIME); `bumpers.create` then probes the file and refuses what it cannot use. */
const ALLOWED_EXTS: readonly string[] = Object.keys(ASSET_MIME);
const TYPE_EXT: Record<string, string> = Object.fromEntries(Object.entries(ASSET_MIME).reverse().map(([ext, mime]) => [mime, ext]));

export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80");
}

export interface FetchDeps {
  fetch?: typeof fetch;
  lookup?: (host: string) => Promise<string[]>;
}

/** http(s) only, and never an address on a private network (the server must not become a proxy into its own). */
async function assertPublicUrl(raw: string, lookup: NonNullable<FetchDeps["lookup"]>): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http(s) links can be downloaded");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : await lookup(host);
  if (!addrs.length || addrs.some(isPrivateAddress)) throw new Error("That address is not reachable from the server (private or unresolvable)");
  return u;
}

/**
 * Download `url` into the uploads table exactly as POST /api/upload would (same storage key, same row), so
 * `bumpers.create` takes it from there with its own type, size and ffprobe checks. Max 50 MB, 60 s, 3 redirects.
 */
export async function downloadAsUpload(svc: Services, userId: string, url: string, deps: FetchDeps & { name?: string; ext?: string } = {}): Promise<{ uploadId: string; filename: string; sizeBytes: number }> {
  const doFetch = deps.fetch ?? fetch;
  const lookup = deps.lookup ?? (async (h: string) => (await dnsLookup(h, { all: true })).map((a) => a.address));
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let target = await assertPublicUrl(url, lookup);
  let res: Response;
  for (let hop = 0; ; hop++) {
    res = await doFetch(target, { redirect: "manual", signal });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop >= MAX_REDIRECTS) throw new Error("Too many redirects");
      target = await assertPublicUrl(new URL(res.headers.get("location")!, target).toString(), lookup);
      continue;
    }
    break;
  }
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
    const capped = Readable.fromWeb(res.body as never).map((chunk: Buffer) => {
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
    await svc.database.db.insert(schema.uploads).values({ id, userId, filename, storageKey, sizeBytes: size });
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
  await svc.database.db.insert(schema.uploads).values({ id, userId, filename, storageKey, sizeBytes: st.size });
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
  project: { introAssetId?: string | null; outroAssetId?: string | null; introSec?: number; outroSec?: number },
  clip: { bumpers?: { intro?: string | null; outro?: string | null; introSec?: number; outroSec?: number } | null },
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
export async function libraryView(svc: Services, api: Api, userId: string, abs: (p: string) => string = (p) => p) {
  const [lib, defaults] = await Promise.all([api.bumpers.list(), userDefaults(svc.database.db, userId)]);
  const row = (a: (typeof lib.assets)[number]) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    durationSec: a.durationSec,
    width: a.width,
    height: a.height,
    isDefaultIntro: defaults.introAssetId === a.id,
    isDefaultOutro: defaults.outroAssetId === a.id,
    mime: a.mime,
    category: a.category,
    tags: a.tags,
    provenance: a.provenance,
    system: a.system,
    usedBy: a.usedBy,
    usedByClips: a.usedByClips,
    thumbnailUrl: abs(a.thumbnailUrl),
    /** the file itself (play the music, view the image or video); same auth as this server */
    url: abs(`/media/bumpers/${a.id}`),
  });
  return { assets: lib.assets.map(row), removed: lib.deleted.map(row) };
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
  projects: { id: string; settings: { introAssetId?: string | null; outroAssetId?: string | null } | null; clips: { bumpers?: { intro?: string | null; outro?: string | null } | null }[] }[],
): Promise<Map<string, ProjectBumperSummary>> {
  const coverage = new Map<string, BumperCoverage>(projects.map((p) => [p.id, bumperCoverage(p, p.clips)]));
  const ids = new Set<string>();
  for (const c of coverage.values()) for (const s of [c.intro, c.outro]) if (s) for (const a of s.assets) ids.add(a.assetId);
  const assets = ids.size
    ? await db.select({ id: schema.libraryAssets.id, name: schema.libraryAssets.name, kind: schema.libraryAssets.kind }).from(schema.libraryAssets).where(and(eq(schema.libraryAssets.userId, userId), inArray(schema.libraryAssets.id, [...ids])))
    : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const slot = (s: SlotCoverage | null): SlotSummary | null => {
    const a = s && byId.get(s.assetId);
    if (!s || !a) return null;
    const assets = s.assets.flatMap((x) => {
      const r = byId.get(x.assetId);
      return r ? [{ assetId: r.id, name: r.name, kind: r.kind, thumbnailUrl: `/media/bumpers/${r.id}/thumb.jpg`, withCount: x.count }] : [];
    });
    return { assets, assetId: s.assetId, name: a.name, kind: a.kind, thumbnailUrl: `/media/bumpers/${a.id}/thumb.jpg`, withCount: s.withCount, total: s.total, otherCount: s.others.reduce((n, o) => n + o.count, 0), noneCount: s.noneCount };
  };
  return new Map([...coverage].map(([id, c]) => [id, { intro: slot(c.intro), outro: slot(c.outro) }]));
}

/**
 * Per asset id, the projects and clips that use it: one grouped query over `asset_refs` (docs/specs/library.md #4).
 * A project counts once however many of its rows name the asset; a clip counts when it names the asset itself
 * (its own intro / outro or a layer; a clip that merely inherits the project's intro is counted through the project).
 * Deleted projects and clips a re-analyze replaced are left out.
 */
export async function bumperUsageCounts(db: Db, userId: string): Promise<Map<string, { projects: number; clips: number }>> {
  const res = await db.execute(sql`
    select r.asset_id as asset_id, count(distinct r.project_id)::int as projects, count(distinct r.clip_id)::int as clips
    from asset_refs r
    join projects p on p.id = r.project_id and p.user_id = ${userId} and p.deleted_at is null
    left join clips c on c.id = r.clip_id
    where r.clip_id is null or c.deleted_at is null
    group by r.asset_id`);
  return new Map((res.rows as Array<{ asset_id: string; projects: number; clips: number }>).map((r) => [r.asset_id, { projects: r.projects, clips: r.clips }]));
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
export async function bumperAssetUsage(db: Db, userId: string, assetId: string): Promise<{ projects: AssetUsageProject[] }> {
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
  if (!projects.size) return { projects: [] };
  const cols = { id: schema.clips.id, projectId: schema.clips.projectId, index: schema.clips.index, title: schema.clips.title, bumpers: schema.clips.bumpers, layers: schema.clips.layers, overlays: schema.clips.overlays, audio: schema.clips.audio };
  const where = [clipIds.size ? inArray(schema.clips.id, [...clipIds]) : undefined, projectLevel.size ? inArray(schema.clips.projectId, [...projectLevel]) : undefined].filter((x) => x !== undefined);
  const clipRows = await db.select(cols).from(schema.clips).where(and(isNull(schema.clips.deletedAt), sql`(${sql.join(where, sql` or `)})`)).orderBy(schema.clips.index).limit(5000);
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
    const roles: AssetUsageClip["slots"] = [...slots.filter((s) => mine.includes(s) || inherited.includes(s)), ...(overlays ? (["overlay"] as const) : []), ...(music ? (["music"] as const) : [])];
    p.clips.push({ id: c.id, index: c.index, title: c.title, slots: roles, via: mine.length || overlays || music ? "clip" : "project", overlays, music });
  }
  // a project whose settings name the asset only counts when a clip really resolves to it (or it has no clips yet)
  for (const [id, p] of out) if (!p.clips.length && hasClips.has(id)) out.delete(id);
  return { projects: [...out.values()] };
}
