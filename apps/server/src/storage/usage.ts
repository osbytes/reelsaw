/**
 * Disk use in terms of what is kept versus what is only wasted: the numbers behind
 * `reelsaw storage`. The pure helpers (video identity, duplicate bytes) are unit tested.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { isNotNull } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import { CACHE_KINDS, cacheIdleMs, planScratchSweep } from "./sweep.js";

/** The YouTube video id in a watch / short / embed / youtu.be URL, else null. */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return /^[\w-]{6,}$/.test(u.pathname.slice(1)) ? u.pathname.slice(1) : null;
    if (host === "youtube.com" || host === "music.youtube.com") {
      const v = u.searchParams.get("v");
      if (v) return v;
      const m = /^\/(?:shorts|embed|live|v)\/([\w-]+)/.exec(u.pathname);
      if (m) return m[1]!;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/** What identifies "the same video" for a URL project: the YouTube id, else the URL itself. */
export function videoIdentity(sourceUrl: string | null | undefined): string | null {
  const yt = youtubeId(sourceUrl);
  if (yt) return `youtube:${yt}`;
  return sourceUrl ? `url:${sourceUrl.trim()}` : null;
}

/** Bytes held by copies beyond the first of each video: every group keeps its largest copy. */
export function duplicateSourceBytes(sources: Array<{ identity: string | null; bytes: number }>): { bytes: number; groups: number } {
  const groups = new Map<string, number[]>();
  for (const s of sources) if (s.identity && s.bytes > 0) groups.set(s.identity, [...(groups.get(s.identity) ?? []), s.bytes]);
  let bytes = 0;
  let n = 0;
  for (const sizes of groups.values()) {
    if (sizes.length < 2) continue;
    n++;
    bytes += sizes.reduce((a, b) => a + b, 0) - Math.max(...sizes);
  }
  return { bytes, groups: n };
}

/** Total of file sizes under `dirs`, counting each inode once (hardlinks between scratch and store). */
export async function uniqueBytes(dirs: string[]): Promise<number> {
  const seen = new Set<string>();
  let total = 0;
  const visit = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await visit(full);
      else if (e.isFile()) {
        const st = await fs.stat(full).catch(() => null);
        if (!st) continue;
        const id = `${st.dev}:${st.ino}`;
        if (seen.has(id)) continue;
        seen.add(id);
        total += st.size;
      }
    }
  };
  for (const d of dirs) await visit(d);
  return total;
}

export interface StorageReport {
  uniqueBytes: number;
  scratchOrphanBytes: number;
  scratchOrphanFiles: number;
  /** scratch copies of stored files (S3 only): the sweep evicts them after SCRATCH_CACHE_HOURS idle, a job short of disk sooner */
  cacheBytes: number;
  cacheFiles: number;
  /** null: nothing is evictable (local store, or SCRATCH_CACHE_HOURS=0) */
  cacheIdleHours: number | null;
  duplicateSourceBytes: number;
  duplicateSourceGroups: number;
  expiredButPresentBytes: number;
  expiredButPresentProjects: number;
}

export async function storageReport(svc: Services): Promise<StorageReport> {
  const db = svc.database.db;
  const storeRoot = svc.config.STORAGE_DRIVER === "s3" ? null : (svc.config.STORAGE_LOCAL_DIR ?? svc.paths.storage);
  const unique = await uniqueBytes([svc.paths.projects, svc.paths.uploads, ...(storeRoot ? [storeRoot] : [])]);
  const planned = await planScratchSweep(svc, Date.now() + 365 * 86_400_000); // ignore the grace period and the idle time: report all of it
  const orphans = planned.filter((r) => !CACHE_KINDS.has(r.kind));
  const cache = planned.filter((r) => CACHE_KINDS.has(r.kind));
  const idleMs = cacheIdleMs(svc);

  const live = await db
    .select({ url: schema.projects.sourceUrl, bytes: schema.projects.sourceBytes })
    .from(schema.projects)
    .where(isNotNull(schema.projects.sourceBytes));
  const dup = duplicateSourceBytes(live.map((p) => ({ identity: videoIdentity(p.url), bytes: p.bytes ?? 0 })));

  // retention marked these expired, yet a source file is still on disk (scratch copy or store object)
  const expired = await db.select({ id: schema.projects.id, key: schema.projects.sourceKey }).from(schema.projects).where(isNotNull(schema.projects.sourceExpiredAt));
  let expiredBytes = 0;
  let expiredProjects = 0;
  for (const p of expired) {
    const dir = svc.paths.project(p.id);
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith("source.")).map((f) => path.join(dir, f));
    if (p.key && storeRoot && (await svc.storage.exists(p.key))) files.push(path.join(storeRoot, p.key));
    const sizes = new Map<string, number>();
    for (const f of files) {
      const st = await fs.stat(f).catch(() => null);
      if (st) sizes.set(`${st.dev}:${st.ino}`, st.size);
    }
    if (sizes.size) {
      expiredProjects++;
      expiredBytes += [...sizes.values()].reduce((a, b) => a + b, 0);
    }
  }
  return {
    uniqueBytes: unique,
    scratchOrphanBytes: orphans.reduce((s, r) => s + r.bytes, 0),
    scratchOrphanFiles: orphans.length,
    cacheBytes: cache.reduce((s, r) => s + r.bytes, 0),
    cacheFiles: cache.length,
    cacheIdleHours: idleMs === null ? null : idleMs / 3_600_000,
    duplicateSourceBytes: dup.bytes,
    duplicateSourceGroups: dup.groups,
    expiredButPresentBytes: expiredBytes,
    expiredButPresentProjects: expiredProjects,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}
