/**
 * Scratch hygiene. Files under DATA_DIR are a cache of the store, so a leftover is harmless but
 * costs disk (the local store hardlinks scratch files; unlinking only one side frees nothing).
 *
 * `planSweep` is pure: given a listing of DATA_DIR and a view of the database it says which paths
 * are safe to delete. `sweepScratch` gathers both, runs the plan and logs every removal. The
 * reconciler runs it about hourly, `reelsaw storage sweep` runs it on demand.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import { keys } from "./index.js";

/** Files younger than this are never touched: a worker may be writing or about to commit them. */
export const SWEEP_GRACE_MS = 60 * 60_000;
export const HEAR_TMP_MAX_AGE_MS = 24 * 60 * 60_000;

export interface ScratchFile {
  /** Path relative to the project directory, with forward slashes, e.g. "clips/<clip>.2.mp4". */
  rel: string;
  bytes: number;
  mtimeMs: number;
}
export interface ScratchProject {
  id: string;
  files: ScratchFile[];
}
export interface TmpFile {
  name: string;
  bytes: number;
  mtimeMs: number;
}
export interface DbView {
  /** Projects that exist. `busy` = a live job, or a status that is not done/failed. */
  projects: Map<string, { busy: boolean }>;
  /** Clips that exist, with the file names their current rows point at. */
  clips: Map<string, { projectId: string; renderGen: number; referenced: Set<string> }>;
}
export interface Removal {
  kind: "stale-generation" | "clip-gone" | "project-gone" | "hear-tmp";
  /** Relative to DATA_DIR. */
  path: string;
  bytes: number;
  projectId?: string;
  clipId?: string;
  gen?: number;
  /** Store keys to drop as well (a stale generation whose store delete never ran). */
  storageKeys?: string[];
}

const CLIP_FILE = /^([^./]+)(?:\.(\d+))?\.(mp4|jpg)$/;

/** "clips/<clip>.<gen>.<mp4|jpg>" (gen 0 has no number), or null for any other file. */
export function parseClipFile(rel: string): { clipId: string; gen: number; name: string } | null {
  const m = /^clips\/([^/]+)$/.exec(rel);
  if (!m) return null;
  const c = CLIP_FILE.exec(m[1]!);
  return c ? { clipId: c[1]!, gen: c[2] ? Number(c[2]) : 0, name: m[1]! } : null;
}

export function planSweep(input: { projects: ScratchProject[]; tmp: TmpFile[]; db: DbView; now: number }): Removal[] {
  const { db, now } = input;
  const out: Removal[] = [];
  const settled = (mtimeMs: number) => now - mtimeMs >= SWEEP_GRACE_MS;
  for (const p of input.projects) {
    const known = db.projects.get(p.id);
    if (!known) {
      // no row: the project was deleted (or never existed). Only when nothing in it is fresh.
      if (p.files.length && p.files.every((f) => settled(f.mtimeMs))) {
        out.push({ kind: "project-gone", path: `projects/${p.id}`, bytes: p.files.reduce((s, f) => s + f.bytes, 0), projectId: p.id });
      }
      continue;
    }
    if (known.busy) continue; // a live job may be rendering or about to commit a generation
    for (const f of p.files) {
      const clip = parseClipFile(f.rel);
      if (!clip || !settled(f.mtimeMs)) continue;
      const row = db.clips.get(clip.clipId);
      const at = `projects/${p.id}/${f.rel}`;
      if (!row || row.projectId !== p.id) {
        out.push({ kind: "clip-gone", path: at, bytes: f.bytes, projectId: p.id, clipId: clip.clipId, gen: clip.gen });
      } else if (clip.gen < row.renderGen && !row.referenced.has(clip.name)) {
        const key = clip.name.endsWith(".jpg") ? keys.thumb(p.id, clip.clipId, clip.gen) : keys.clip(p.id, clip.clipId, clip.gen);
        out.push({ kind: "stale-generation", path: at, bytes: f.bytes, projectId: p.id, clipId: clip.clipId, gen: clip.gen, storageKeys: [key] });
      }
      // gen >= renderGen, or named by the row: current (or newer than the row knows): keep
    }
  }
  for (const f of input.tmp) {
    if (f.name.startsWith("hear-") && now - f.mtimeMs >= HEAR_TMP_MAX_AGE_MS) out.push({ kind: "hear-tmp", path: `tmp/${f.name}`, bytes: f.bytes });
  }
  return out;
}

export async function walk(dir: string, base = dir): Promise<ScratchFile[]> {
  const out: ScratchFile[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else if (e.isFile()) {
      const st = await fs.stat(full).catch(() => null);
      if (st) out.push({ rel: path.relative(base, full).split(path.sep).join("/"), bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/** Reads DATA_DIR and the database, returns what a sweep would remove (nothing is deleted). */
export async function planScratchSweep(svc: Services, now = Date.now()): Promise<Removal[]> {
  // list the directories first, read the database second: a project created in between is seen
  const ids = (await fs.readdir(svc.paths.projects, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).map((e) => e.name);
  const db: DbView = { projects: new Map(), clips: new Map() };
  if (ids.length) {
    const d = svc.database.db;
    const projects = await d.select({ id: schema.projects.id, status: schema.projects.status }).from(schema.projects).where(inArray(schema.projects.id, ids));
    const clips = await d
      .select({ id: schema.clips.id, projectId: schema.clips.projectId, renderGen: schema.clips.renderGen, outputKey: schema.clips.outputKey, thumbnailKey: schema.clips.thumbnailKey })
      .from(schema.clips)
      .where(inArray(schema.clips.projectId, ids));
    const jobs = await svc.database.pool.query<{ id: string }>(
      `select distinct data->>'projectId' as id from pgboss.job where state in ('created','retry','active') and data->>'projectId' = any($1)`,
      [ids],
    );
    const live = new Set(jobs.rows.map((r) => r.id));
    for (const p of projects) db.projects.set(p.id, { busy: live.has(p.id) || (p.status !== "done" && p.status !== "failed") });
    for (const c of clips) {
      const referenced = new Set([c.outputKey, c.thumbnailKey].filter((k): k is string => !!k).map((k) => path.posix.basename(k)));
      db.clips.set(c.id, { projectId: c.projectId, renderGen: c.renderGen, referenced });
    }
  }
  const projects: ScratchProject[] = [];
  for (const id of ids) {
    const dir = svc.paths.project(id);
    // a known project only needs its clips directory; an unknown one needs everything (to size and age it)
    projects.push({ id, files: db.projects.has(id) ? (await walk(path.join(dir, "clips"), dir)) : await walk(dir) });
  }
  const tmp: TmpFile[] = [];
  for (const e of await fs.readdir(svc.paths.tmp, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile() || !e.name.startsWith("hear-")) continue;
    const st = await fs.stat(path.join(svc.paths.tmp, e.name)).catch(() => null);
    if (st) tmp.push({ name: e.name, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  return planSweep({ projects, tmp, db, now });
}

/** Plans and executes a sweep, logging each removal with its ids and size. */
export async function sweepScratch(svc: Services, opts: { dryRun?: boolean } = {}): Promise<{ removals: Removal[]; bytes: number }> {
  const log = svc.log.child({ module: "sweep" });
  const removals = await planScratchSweep(svc);
  const done: Removal[] = [];
  for (const r of removals) {
    if (!opts.dryRun) {
      try {
        await fs.rm(path.join(svc.paths.root, r.path), { recursive: true, force: true });
        for (const k of r.storageKeys ?? []) await svc.storage.delete(k);
      } catch (err) {
        log.warn({ err, path: r.path }, "could not remove a leftover file");
        continue;
      }
      log.info({ kind: r.kind, path: r.path, bytes: r.bytes, projectId: r.projectId, clipId: r.clipId, gen: r.gen }, "removed a leftover file nothing points at");
    }
    done.push(r);
  }
  const bytes = done.reduce((s, r) => s + r.bytes, 0);
  if (done.length && !opts.dryRun) log.info({ files: done.length, bytes }, "scratch sweep finished");
  return { removals: done, bytes };
}

/** Delete one clip render (mp4 or jpg) from scratch, given its store key. The store copy is separate. */
export async function removeScratchClip(svc: Services, projectId: string, key: string) {
  await fs.rm(path.join(svc.paths.project(projectId), "clips", path.posix.basename(key)), { force: true }).catch(() => {});
}

/** Delete the scratch copy of a project's source (`source.*`). */
export async function removeScratchSource(svc: Services, projectId: string) {
  const dir = svc.paths.project(projectId);
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    if (f.startsWith("source.")) await fs.rm(path.join(dir, f), { force: true }).catch(() => {});
  }
}

/** Soft-deleted library assets are kept this long so Undo and restore keep working. */
export const BUMPER_PURGE_MS = 30 * 24 * 60 * 60_000;

/** A removed asset is purgeable once it has been gone for 30 days and no project setting or clip names it. */
export function bumperPurgeable(a: { deletedAt: Date | null }, referenced: boolean, now: number): boolean {
  return !!a.deletedAt && !referenced && now - a.deletedAt.getTime() > BUMPER_PURGE_MS;
}

/**
 * Hard-deletes library assets removed over 30 days ago that nothing references, then drops their
 * storage objects (`bumpers/<id>/…`) and local cache. The row delete commits first; the files go after.
 */
export async function purgeBumperAssets(svc: Services, opts: { dryRun?: boolean; now?: number } = {}): Promise<string[]> {
  const log = svc.log.child({ module: "sweep" });
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - BUMPER_PURGE_MS);
  const candidates = await svc.database.db
    .select({ id: schema.bumperAssets.id })
    .from(schema.bumperAssets)
    .where(and(isNotNull(schema.bumperAssets.deletedAt), lt(schema.bumperAssets.deletedAt, cutoff)))
    .limit(200);
  const purged: string[] = [];
  for (const { id } of candidates) {
    if (opts.dryRun) {
      purged.push(id);
      continue;
    }
    const gone = await svc.tx(async (u) => {
      const [a] = await u.db.select({ id: schema.bumperAssets.id, deletedAt: schema.bumperAssets.deletedAt }).from(schema.bumperAssets).where(eq(schema.bumperAssets.id, id)).for("update");
      if (!a) return false;
      const ref = await u.db.execute(sql`
        select exists (select 1 from projects where settings ->> 'introAssetId' = ${id} or settings ->> 'outroAssetId' = ${id})
            or exists (select 1 from clips where bumpers ->> 'intro' = ${id} or bumpers ->> 'outro' = ${id}) as used`);
      const used = !!(ref.rows[0] as { used: boolean } | undefined)?.used;
      if (!bumperPurgeable(a, used, now)) return false;
      await u.db.delete(schema.bumperAssets).where(eq(schema.bumperAssets.id, id));
      u.afterCommit(async () => {
        try {
          await svc.storage.deletePrefix(`bumpers/${id}`);
          await fs.rm(path.join(svc.paths.root, "bumpers", id), { recursive: true, force: true });
        } catch (err) {
          log.warn({ err, assetId: id }, "purged a library asset but could not remove its files");
        }
      });
      return true;
    });
    if (gone) {
      purged.push(id);
      log.info({ assetId: id }, "purged a library asset removed over 30 days ago");
    }
  }
  return purged;
}
