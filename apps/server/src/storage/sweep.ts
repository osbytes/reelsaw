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
import { eq, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import { keys } from "./index.js";
import { QUEUES } from "../queue/boss.js";
import { chunk, deadlineIn, expired, keysetLoop, mapLimit } from "../lib/batch.js";
import { getState, setState } from "../lib/state.js";
import { assetRefsReady } from "../library/refs.js";

/** Files younger than this are never touched: a worker may be writing or about to commit them. */
export const SWEEP_GRACE_MS = 60 * 60_000;
/** A scratch entry in tmp/ older than this was left by a crash or a kill: no job runs that long. */
export const TMP_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * What the app itself writes to tmp/ (files and per-run directories). Anything else there, such as
 * the zip `reelsaw export` saves when no --out is given, belongs to the operator and stays.
 */
const TMP_SCRATCH = /^(hear|bumper|catalog|export|import|report|subtitle)-/;

export interface ScratchFile {
  /** Path relative to the project directory, with forward slashes, e.g. "clips/<clip>.2.mp4". */
  rel: string;
  bytes: number;
  mtimeMs: number;
}
export interface ScratchProject {
  id: string;
  files: ScratchFile[];
  /** the listing was cut short by a time budget: fine for judging single files, not for "nothing fresh is in here" */
  partial?: boolean;
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
  kind: "stale-generation" | "clip-gone" | "project-gone" | "tmp";
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
      if (!p.partial && p.files.length && p.files.every((f) => settled(f.mtimeMs))) {
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
    if (TMP_SCRATCH.test(f.name) && now - f.mtimeMs >= TMP_MAX_AGE_MS) out.push({ kind: "tmp", path: `tmp/${f.name}`, bytes: f.bytes });
  }
  return out;
}

/** Bounds of one background sweep. A manual `reelsaw storage sweep` has no budget. */
export const SWEEP_CHUNK = 1000; // directories per database lookup (one array parameter each, never one parameter per id)
export const SWEEP_STAT_CONCURRENCY = 16;
export const SWEEP_BUDGET_MS = 60_000; // total per run; the rest continues next hour from the persisted cursor
export const SWEEP_DIR_BUDGET_MS = 10_000; // per project directory
const SWEEP_STATE = "sweep_state";

/** List a directory's files, `stat`ing 16 at a time. `partial` = the deadline hit before every entry was seen. */
export async function walkDir(dir: string, base: string, deadline = Infinity): Promise<{ files: ScratchFile[]; partial: boolean }> {
  const files: ScratchFile[] = [];
  let partial = false;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const stats = await mapLimit(
    entries.filter((e) => e.isFile()),
    SWEEP_STAT_CONCURRENCY,
    async (e) => {
      if (expired(deadline)) {
        partial = true;
        return null;
      }
      const full = path.join(dir, e.name);
      const st = await fs.stat(full).catch(() => null);
      return st ? { rel: path.relative(base, full).split(path.sep).join("/"), bytes: st.size, mtimeMs: st.mtimeMs } : null;
    },
  );
  for (const f of stats) if (f) files.push(f);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (expired(deadline)) {
      partial = true;
      break;
    }
    const sub = await walkDir(path.join(dir, e.name), base, deadline);
    files.push(...sub.files);
    partial ||= sub.partial;
  }
  return { files, partial };
}

export async function walk(dir: string, base = dir): Promise<ScratchFile[]> {
  return (await walkDir(dir, base)).files;
}

/** Read the database for one chunk of project directories: `= any($1)` with a single array parameter. */
export async function loadDbView(svc: Services, ids: string[]): Promise<DbView> {
  const db: DbView = { projects: new Map(), clips: new Map() };
  if (!ids.length) return db;
  const pool = svc.database.pool;
  const projects = await pool.query<{ id: string; status: string }>(`select id, status from projects where id = any($1::text[])`, [ids]);
  const clips = await pool.query<{ id: string; project_id: string; render_gen: number; output_key: string | null; thumbnail_key: string | null }>(
    `select id, project_id, render_gen, output_key, thumbnail_key from clips where project_id = any($1::text[])`,
    [ids],
  );
  // live jobs by (name, singleton_key): the key is the project id for stage jobs and the clip id for render/prepare
  // jobs, and the exclusive-policy queues index exactly that (data->>'projectId' would scan every job)
  const clipProject = new Map(clips.rows.map((c) => [c.id, c.project_id]));
  const jobs = await pool.query<{ key: string }>(
    `select distinct singleton_key as key from pgboss.job where name = any($1::text[]) and singleton_key = any($2::text[]) and state in ('created','retry','active')`,
    [Object.values(QUEUES), [...ids, ...clipProject.keys()]],
  );
  const live = new Set(jobs.rows.map((r) => clipProject.get(r.key) ?? r.key));
  for (const p of projects.rows) db.projects.set(p.id, { busy: live.has(p.id) || (p.status !== "done" && p.status !== "failed") });
  for (const c of clips.rows) {
    const referenced = new Set([c.output_key, c.thumbnail_key].filter((k): k is string => !!k).map((k) => path.posix.basename(k)));
    db.clips.set(c.id, { projectId: c.project_id, renderGen: c.render_gen, referenced });
  }
  return db;
}

export interface ScanResult {
  removals: Removal[];
  /** project directories looked at in this run */
  scanned: number;
  /** last directory name processed (sorted order) when the run stopped early; null when it reached the end */
  lastDir: string | null;
  /** every directory was reached */
  complete: boolean;
}

/**
 * Walks DATA_DIR in directory-name order, `SWEEP_CHUNK` projects per database lookup, and stops
 * (incomplete) when the total budget is spent; `after` resumes behind a previous run's last directory.
 * A directory whose own budget ran out is marked `partial`, which only forbids "project-gone".
 */
export async function scanScratch(svc: Services, opts: { now?: number; budgetMs?: number; after?: string | null } = {}): Promise<ScanResult> {
  const now = opts.now ?? Date.now();
  const deadline = deadlineIn(opts.budgetMs);
  // list the directories first, read the database second: a project created in between is seen
  const names = (await fs.readdir(svc.paths.projects, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  const pending = opts.after ? names.filter((n) => n > opts.after!) : names;
  const removals: Removal[] = [];
  let scanned = 0;
  let lastDir: string | null = opts.after ?? null;
  let complete = true;
  outer: for (const ids of chunk(pending, SWEEP_CHUNK)) {
    if (expired(deadline)) {
      complete = false;
      break;
    }
    const db = await loadDbView(svc, ids);
    const projects: ScratchProject[] = [];
    for (const id of ids) {
      if (expired(deadline)) {
        complete = false;
        removals.push(...planSweep({ projects, tmp: [], db, now }));
        break outer;
      }
      const dir = svc.paths.project(id);
      const dirDeadline = Math.min(deadline, deadlineIn(opts.budgetMs ? SWEEP_DIR_BUDGET_MS : 0));
      // a known project only needs its clips directory; an unknown one needs everything (to size and age it)
      const w = db.projects.has(id) ? await walkDir(path.join(dir, "clips"), dir, dirDeadline) : await walkDir(dir, dir, dirDeadline);
      projects.push({ id, files: w.files, partial: w.partial });
      scanned++;
      lastDir = id;
    }
    removals.push(...planSweep({ projects, tmp: [], db, now }));
  }
  if (complete) {
    const entries = (await fs.readdir(svc.paths.tmp, { withFileTypes: true }).catch(() => [])).filter((e) => e.isFile() || e.isDirectory());
    const tmp = (
      await mapLimit(entries, SWEEP_STAT_CONCURRENCY, async (e) => {
        const st = await fs.stat(path.join(svc.paths.tmp, e.name)).catch(() => null);
        return st ? { name: e.name, bytes: st.size, mtimeMs: st.mtimeMs } : null;
      })
    ).filter((t): t is TmpFile => !!t);
    removals.push(...planSweep({ projects: [], tmp, db: { projects: new Map(), clips: new Map() }, now }));
  }
  return { removals, scanned, lastDir: complete ? null : lastDir, complete };
}

/** Reads DATA_DIR and the database, returns everything a sweep would remove (no budget; nothing is deleted). */
export async function planScratchSweep(svc: Services, now = Date.now()): Promise<Removal[]> {
  return (await scanScratch(svc, { now })).removals;
}

export interface SweepState {
  cursor: string | null;
  lastRunAt: string;
  lastRunMs: number;
  lastScanned: number;
  lastComplete: boolean;
  lastRemoved: number;
}
export const readSweepState = (svc: Services) => getState<SweepState & Record<string, unknown>>(svc.database.db, SWEEP_STATE);

/**
 * Plans and executes a sweep, logging each removal with its ids and size. Background runs
 * (`budgeted`) stop after SWEEP_BUDGET_MS and continue from the saved cursor next time; a manual
 * run or a dry run covers everything and leaves the cursor alone.
 */
export async function sweepScratch(svc: Services, opts: { dryRun?: boolean; budgeted?: boolean } = {}): Promise<{ removals: Removal[]; bytes: number; scanned: number; complete: boolean }> {
  const log = svc.log.child({ module: "sweep" });
  const started = Date.now();
  const prior = opts.budgeted ? await readSweepState(svc) : {};
  const scan = await scanScratch(svc, { budgetMs: opts.budgeted ? SWEEP_BUDGET_MS : 0, after: prior.cursor ?? null });
  const done: Removal[] = [];
  for (const r of scan.removals) {
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
  if (!opts.dryRun) {
    log.info({ directories: scan.scanned, files: done.length, bytes, complete: scan.complete, ms: Date.now() - started }, "scratch sweep finished");
    if (opts.budgeted) {
      const state: SweepState = { cursor: scan.lastDir, lastRunAt: new Date().toISOString(), lastRunMs: Date.now() - started, lastScanned: scan.scanned, lastComplete: scan.complete, lastRemoved: done.length };
      await setState(svc.database.db, SWEEP_STATE, { ...state });
    }
  }
  return { removals: done, bytes, scanned: scan.scanned, complete: scan.complete };
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
export const PURGE_BATCH = 200;
export const PURGE_BUDGET_MS = 30_000;
export const BUMPER_PURGE_MS = 30 * 24 * 60 * 60_000;
export const ASSET_RESTORE_DAYS = BUMPER_PURGE_MS / 86_400_000;

/** Drop the store prefix and local cache for one library asset. A missing folder is fine. */
export async function dropAssetStorage(svc: Services, sourceKey: string) {
  const dir = keys.assetDir(sourceKey);
  if (typeof svc.storage.deletePrefix === "function") await svc.storage.deletePrefix(dir);
  const root = svc.paths.root;
  if (root) await fs.rm(path.join(root, dir), { recursive: true, force: true });
}

/**
 * A removed asset is purgeable once it has been gone for 30 days and no project setting or clip names it. An
 * instance-shared row (`userId` null) is never removed by anyone: it is purgeable once it is over 30 days old and
 * nothing references it.
 */
export function bumperPurgeable(a: { deletedAt: Date | null; userId?: string | null; createdAt?: Date }, referenced: boolean, now: number): boolean {
  if (a.userId === null) return !!a.createdAt && !referenced && now - a.createdAt.getTime() > BUMPER_PURGE_MS;
  return !!a.deletedAt && !referenced && now - a.deletedAt.getTime() > BUMPER_PURGE_MS;
}

/**
 * Hard-deletes library assets removed over 30 days ago that nothing references, and instance-shared rows that nothing
 * references (see bumperPurgeable), then drops their
 * storage objects (`bumpers/<id>/…`) and local cache. The row delete commits first; the files go after.
 */
export async function purgeBumperAssets(svc: Services, opts: { dryRun?: boolean; now?: number } = {}): Promise<string[]> {
  const log = svc.log.child({ module: "sweep" });
  const now = opts.now ?? Date.now();
  const cutoff = new Date(now - BUMPER_PURGE_MS);
  const purged: string[] = [];
  // "referenced" is read from asset_refs: until its backfill has covered every old project the table may be missing rows
  if (!(await assetRefsReady(svc.database.db))) {
    log.info("library purge waits for the asset refs backfill");
    return purged;
  }
  // Keyset over (deleted_at, id), 200 per batch. Still-referenced assets are excluded in SQL (`not exists`), so
  // they neither consume the batch nor starve the assets behind them. The timestamp travels as text to keep
  // microseconds: a JS Date would round the cursor and re-read or skip rows.
  // A live layer template that names the asset keeps it too (a small per-user table, so the jsonb walk is cheap).
  const templateUsesAsset = sql`select 1 from layer_templates t, jsonb_array_elements(t.layers) l where t.deleted_at is null and l->>'assetId' = a.id`;
  type Cur = { at: string; id: string };
  await keysetLoop<{ id: string; at: string }, Cur>({
    size: PURGE_BATCH,
    deadline: deadlineIn(PURGE_BUDGET_MS),
    start: null,
    fetch: async (cur, size) => {
      const res = await svc.database.db.execute(sql`
        select a.id as id, a.deleted_at::text as at from assets a
        where a.deleted_at is not null and a.deleted_at < ${cutoff.toISOString()}::timestamptz
          ${cur ? sql`and (a.deleted_at, a.id) > (${cur.at}::timestamptz, ${cur.id})` : sql``}
          and not exists (select 1 from asset_refs r where r.asset_id = a.id)
          and not exists (${templateUsesAsset})
        order by a.deleted_at, a.id limit ${size}`);
      return res.rows as Array<{ id: string; at: string }>;
    },
    cursorOf: (r) => ({ at: r.at, id: r.id }),
    handle: async (rows) => {
      await purgeBatch(rows.map((r) => r.id));
    },
  });
  // instance-shared rows (catalog / provider imports) that no project uses, over 30 days old
  await keysetLoop<{ id: string; at: string }, Cur>({
    size: PURGE_BATCH,
    deadline: deadlineIn(PURGE_BUDGET_MS),
    start: null,
    fetch: async (cur, size) => {
      const res = await svc.database.db.execute(sql`
        select a.id as id, a.created_at::text as at from assets a
        where a.user_id is null and a.created_at < ${cutoff.toISOString()}::timestamptz
          ${cur ? sql`and (a.created_at, a.id) > (${cur.at}::timestamptz, ${cur.id})` : sql``}
          and not exists (select 1 from asset_refs r where r.asset_id = a.id)
          and not exists (${templateUsesAsset})
        order by a.created_at, a.id limit ${size}`);
      return res.rows as Array<{ id: string; at: string }>;
    },
    cursorOf: (r) => ({ at: r.at, id: r.id }),
    handle: async (rows) => {
      await purgeBatch(rows.map((r) => r.id));
    },
  });
  if (purged.length) log.info({ count: purged.length, dryRun: !!opts.dryRun }, "library sweep: assets purged");
  return purged;

  async function purgeBatch(candidates: string[]) {
  for (const id of candidates) {
    if (opts.dryRun) {
      purged.push(id);
      continue;
    }
    const gone = await svc.tx(async (u) => {
      const [a] = await u.db.select({ id: schema.assets.id, userId: schema.assets.userId, createdAt: schema.assets.createdAt, deletedAt: schema.assets.deletedAt, sourceKey: schema.assets.sourceKey }).from(schema.assets).where(eq(schema.assets.id, id)).for("update");
      if (!a) return false;
      // refs are written in the transaction that points at the asset (library/refs.ts), after taking the same row lock
      const ref = await u.db.execute(sql`select exists (select 1 from asset_refs where asset_id = ${id}) as used`);
      const used = !!(ref.rows[0] as { used: boolean } | undefined)?.used;
      if (!bumperPurgeable(a, used, now)) return false;
      await u.db.delete(schema.assets).where(eq(schema.assets.id, id));
      u.afterCommit(async () => {
        try {
          // rows made before the rename keep their files under bumpers/<id>, newer ones under assets/<id>
          await dropAssetStorage(svc, a.sourceKey);
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
  }
}
