/**
 * Helpers for driving the intro/outro ("bumper") library from outside the web app (MCP tools, CLI).
 *
 * The state changes themselves are NOT re-implemented here: callers go through the `bumpers.*`,
 * `projects.setBumpers` and `clips.setBumpersMany` tRPC procedures (one path per transition). This file holds
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
import { bumperSecondsSchema } from "@reelsaw/shared";
import type { Services } from "../services.js";
import type { appRouter } from "../trpc/router.js";
import { userDefaults } from "../pipeline/settings.js";
import { schema } from "../db/index.js";
import { keys } from "../storage/index.js";
import { BUMPER_MAX_BYTES, BUMPER_VIDEO_EXTS, BUMPER_IMAGE_EXTS, BUMPER_IMAGE_SEC, resolveClipBumpers } from "../pipeline/bumpers.js";

export const FETCH_MAX_BYTES = BUMPER_MAX_BYTES;
export const FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

const assetId = z.string().min(1).max(100);

/** Project slot choice: the user's current default, nothing, or a library asset id. */
export const projectChoiceSchema = z.union([z.enum(["default", "none"]), assetId]).describe('"default" = your current default intro/outro, "none" = no bumper, or a library asset id (see list_bumpers)');
/** Clip slot choice: follow the project, nothing, or a library asset id. */
export const clipChoiceSchema = z.union([z.enum(["inherit", "default", "none"]), assetId]).describe('"inherit" (alias "default") = follow the project, "none" = no bumper on this clip, or a library asset id');

export const setProjectBumpersInput = {
  projectId: z.string(),
  intro: projectChoiceSchema.optional(),
  outro: projectChoiceSchema.optional(),
  introSec: bumperSecondsSchema.optional().describe("Seconds to show an intro image (1-10); videos keep their own length"),
  outroSec: bumperSecondsSchema.optional(),
  rerender: z.boolean().describe("true = re-render the project's finished clips now; false = apply on their next render"),
};
export const setClipBumpersInput = {
  projectId: z.string(),
  clipIds: z.array(z.string()).min(1).max(200),
  intro: clipChoiceSchema.optional(),
  outro: clipChoiceSchema.optional(),
  introSec: bumperSecondsSchema.optional(),
  outroSec: bumperSecondsSchema.optional(),
  rerender: z.boolean().describe("true = re-render only these clips now"),
};
export const addBumperInput = {
  url: z.url().optional().describe("http(s) link to an MP4/MOV/WebM (max 10 s) or PNG/JPG; the server downloads it (max 50 MB, 60 s)"),
  uploadId: z.string().min(1).max(100).optional().describe("An existing upload id (from POST /api/upload) instead of a url"),
  name: z.string().min(1).max(120).optional(),
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

export function requireOneSource(i: { url?: string; uploadId?: string }) {
  if (!!i.url === !!i.uploadId) throw new Error("Give exactly one of url or uploadId");
}

// ── bounded download ───────────────────────────────────────────────────────

const TYPE_EXT: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "image/png": ".png", "image/jpeg": ".jpg" };
const ALLOWED_EXTS: readonly string[] = [...BUMPER_VIDEO_EXTS, ...BUMPER_IMAGE_EXTS];

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
export async function downloadAsUpload(svc: Services, userId: string, url: string, deps: FetchDeps & { name?: string } = {}): Promise<{ uploadId: string; filename: string; sizeBytes: number }> {
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
  const ext = ALLOWED_EXTS.includes(urlExt) ? urlExt : TYPE_EXT[type];
  if (!ext) throw new Error("Use an MP4, MOV or WebM video, or a PNG or JPG image.");
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
    return { uploadId: id, filename, sizeBytes: size };
  } finally {
    await fs.rm(dest, { force: true }).catch(() => {});
  }
}

// ── read side ──────────────────────────────────────────────────────────────

export interface AssetRef {
  id: string;
  name: string;
  kind: "video" | "image";
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
    usedBy: a.usedBy,
    thumbnailUrl: abs(a.thumbnailUrl),
  });
  return { assets: lib.assets.map(row), removed: lib.deleted.map(row) };
}
