/**
 * Full-quality windows of a preview-sized link source.
 *
 * A plan with a `sourceHeight` (Free: 240p) downloads a small copy of a link: transcription, analysis, the editor
 * and the scene/text scans all work from it. Rendering needs pixels, so each clip renders from a window of the
 * video fetched at full quality (`--download-sections`), a few seconds wider than the clip, stored and reused by
 * every rerender that still fits inside it. The proxy carries the clips' minutes in HD, not the whole video.
 *
 * yt-dlp cuts a section on a keyframe (or with an edit list), so the file's first frame is near the requested
 * start but not exactly on it. Captions, cuts and framing are on the source clock, so the window is placed by its
 * sound: the window's audio is matched against the preview's around the requested start (`measureOffset`).
 * Without a clear match (silence, music loops) the requested start is used.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { LRUCache } from "lru-cache";
import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Project } from "../db/schema.js";
import type { Pool } from "pg";
import type { Services } from "../services.js";
import { keys } from "../storage/index.js";
import { removeScratchWindows } from "../storage/sweep.js";
import { clipPcm } from "../audio/pcm.js";
import { VAD_SR } from "../audio/vad.js";
import { isDownloadBlocked, isPermanentDownloadFailure } from "../ytdlp-errors.js";
import { count } from "../metrics.js";
import { sessionLock, waitSessionLock } from "../locks.js";
import { NoEligibleProxyError } from "../ytdlp-proxy.js";
import { type StageContext, DownloadFailedError } from "./common.js";
import { describeDownloadFailure, sourceFormat } from "./ingest.js";
import { ENCODE_PASS_CPU } from "../resources.js";
import { DownloadStalledError } from "../media.js";

/** Seconds fetched on each side of a clip: room for a keyframe before the start, and for small bound nudges. */
export const WINDOW_PAD_SEC = 3;
/** Full-quality height a window is fetched at. */
export const WINDOW_HEIGHT = 1080;
/** The match must be at least this good (normalised correlation of loudness envelopes) to move the window. */
const MATCH_MIN_SCORE = 0.6;
/** How far from the requested start the file may begin (keyframe distance), searched both ways. */
const SEARCH_SEC = 6;
/** Seconds of the window's sound that are matched. */
const PROBE_SEC = 8;
/** The window's sound is taken from this far in, past any decoder warm-up at the very first frame. */
const PROBE_FROM_SEC = 1;
const ENV_HZ = 100;

/** What a clip renders from: a local file, the source time of its first frame, and its pixel size. */
export interface RenderSource {
  path: string;
  /** source seconds at the file's t=0; read the clip at `clip.startSec - offsetSec` */
  offsetSec: number;
  width: number;
  height: number;
  /** the preview copy (a window could not be had for good); renders soft */
  preview: boolean;
}

/** Whether this project's stored source is a preview copy whose clips render from fetched windows. */
export function rendersFromWindows(project: Pick<Project, "sourceType" | "sourceMeta" | "sourceUrl">): number | null {
  const h = project.sourceMeta?.["previewHeight"];
  return project.sourceType === "url" && project.sourceUrl && typeof h === "number" && h > 0 ? h : null;
}

type Range = [number, number];
type Clip = { id: string; startSec: number; endSec: number };
type Window = typeof schema.sourceSections.$inferSelect;

/** Clips this close (seconds between their padded ranges) share one window instead of two downloads. */
export const MERGE_GAP_SEC = 15;
/** A merged window is never longer than this; past it the clip gets a window of its own. */
export const MAX_WINDOW_SEC = 600;
/** A missing stretch is fetched this far into what is already stored on each side, so the seam is inside both files. */
export const SEAM_SEC = 2;
/**
 * A window download that writes nothing for this long is stopped and the render retried. A hung connection otherwise
 * holds the render (and the project's window lock, so every other clip of the project) until the job expires, an hour.
 * Long enough for yt-dlp to read the page and the playlist through a slow proxy before the first bytes land.
 */
const WINDOW_STALL_MS = 5 * 60 * 1000;

/** Source seconds a clip's render may read: the clip and the room a window keeps on each side. */
function clipSpan(clip: Clip): [number, number] {
  return [Math.max(0, clip.startSec - WINDOW_PAD_SEC), clip.endSec + WINDOW_PAD_SEC];
}

/** The file a clip spanning [start, end] (source seconds) renders from. */
export async function renderSource(ctx: StageContext, project: Project, clip: Clip): Promise<RenderSource> {
  const previewHeight = rendersFromWindows(project);
  if (!previewHeight) {
    return { ...(await ctx.sourceAt(project, clipSpan(clip))), width: project.width ?? 1920, height: project.height ?? 1080, preview: false };
  }
  const { svc } = ctx;
  const covering = await coveringWindow(ctx, project.id, clip);
  if (covering) return covering;
  try {
    // one download per project at a time: a render that waited here usually finds its clip in what the other fetched
    return await waitSessionLock(
      lockPool(svc),
      sessionLock.sourceWindows(project.id),
      async () => {
        const covered = await coveringWindow(ctx, project.id, clip);
        if (covered) return covered;
        // a sibling clip just learned the windows cannot be had: do not walk every proxy into the same wall again
        const known = unavailable.get(project.id);
        if (known) throw new WindowUnavailableError(known);
        return await fetchWindow(ctx, project, clip);
      },
      { signal: ctx.signal },
    );
  } catch (err) {
    if (ctx.signal.aborted || !(err instanceof WindowUnavailableError)) throw err;
    unavailable.set(project.id, err.message);
    // the video is gone (deleted, private) or the site blocks us: the clip can still be made, softly, from the copy we have
    ctx.log.warn({ clipId: clip.id, err }, "full-quality window unavailable; rendering from the preview copy");
    await svc.events
      .emit("clip.preview_source", { projectId: project.id, clipId: clip.id, height: previewHeight, reason: err.message.slice(0, 500) })
      .catch(() => {});
    return { ...(await ctx.sourceAt(project, clipSpan(clip))), width: project.width ?? 426, height: project.height ?? previewHeight, preview: true };
  }
}

class WindowUnavailableError extends Error {}

/**
 * Projects whose full-quality windows could not be had (gone, or blocked), with why, so the rest of their clips render
 * from the preview copy without another download each. Per process and short-lived: a block can lift, and a re-render
 * after it expires tries again.
 */
const unavailable = new LRUCache<string, string>({ max: 1000, ttl: 30 * 60 * 1000 });

/**
 * The window lock's own small pool. The holder keeps its client for the whole download, and `fetchWindow` needs the
 * main pool meanwhile (queries, `svc.tx`): sharing one pool, enough projects fetching at once would hold every slot
 * and wait on each other for a connection.
 */
const lockPools = new WeakMap<Services, Pool>();
function lockPool(svc: Services): Pool {
  let p = lockPools.get(svc);
  if (!p) {
    p = svc.database.extraPool(8);
    lockPools.set(svc, p);
  }
  return p;
}

async function coveringWindow(ctx: StageContext, projectId: string, clip: Clip): Promise<RenderSource | null> {
  const w = await ctx.db.query.sourceSections.findFirst({
    where: and(
      eq(schema.sourceSections.projectId, projectId),
      lte(schema.sourceSections.startSec, clip.startSec),
      gte(schema.sourceSections.endSec, clip.endSec),
    ),
    orderBy: [asc(schema.sourceSections.bytes)],
  });
  if (!w) return null;
  const file = await localWindow(ctx, w);
  return file ? { path: file, offsetSec: w.offsetSec, width: w.width, height: w.height, preview: false } : null;
}

/** The window's file on this node; null (and the row dropped, so it is fetched again) when the store lost it. */
async function localWindow(ctx: StageContext, w: Window): Promise<string | null> {
  if (!(await ctx.svc.storage.exists(w.key))) {
    ctx.log.warn({ key: w.key }, "stored window is missing; it will be fetched again");
    await ctx.db.delete(schema.sourceSections).where(eq(schema.sourceSections.id, w.id));
    return null;
  }
  const local = path.join(await ctx.dir(), "sections", path.posix.basename(w.key));
  await fs.mkdir(path.dirname(local), { recursive: true });
  return ctx.svc.storage.ensureLocal(w.key, local);
}

/**
 * What to fetch for a clip no stored window covers.
 * - Nothing stored overlaps it: one window over every not-yet-covered clip within MERGE_GAP_SEC of it (chained), up
 *   to MAX_WINDOW_SEC and never into a stored window: the first render of a project fetches its neighbours' video too.
 * - Stored windows overlap it: only the stretches they miss (each SEAM_SEC into its neighbours), joined with the
 *   stored parts into one window for this clip (`stitch`). The stretches may be none: two windows that meet.
 */
export function planWindow(o: { clip: Range; clips: Range[]; windows: Range[]; total: number; pad?: number }): {
  range: Range;
  fetch: Range[];
  stitch: boolean;
} {
  const pad = o.pad ?? WINDOW_PAD_SEC;
  const padded = (r: Range): Range => [Math.max(0, r[0] - pad), Math.min(o.total, r[1] + pad)];
  const need = padded(o.clip);
  const touching = o.windows.some((w) => w[0] < need[1] && w[1] > need[0]);
  if (touching) {
    const fetch = uncovered(need, o.windows).map(([a, b]): Range => [Math.max(0, a - SEAM_SEC), Math.min(o.total, b + SEAM_SEC)]);
    return { range: need, fetch, stitch: true };
  }
  // the room between the stored windows on either side of the clip
  const lo = Math.max(0, ...o.windows.filter((w) => w[1] <= need[0]).map((w) => w[1]));
  const hi = Math.min(o.total, ...o.windows.filter((w) => w[0] >= need[1]).map((w) => w[0]));
  const others = o.clips
    .filter((c) => !o.windows.some((w) => w[0] <= c[0] && w[1] >= c[1]))
    .map(padded)
    .map((r): Range => [Math.max(lo, r[0]), Math.min(hi, r[1])])
    .filter((r) => r[1] > r[0]);
  let range = need;
  // grow until no other clip is within the gap; a clip that would make the window too long stays out
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of others) {
      const near = r[0] <= range[1] + MERGE_GAP_SEC && r[1] >= range[0] - MERGE_GAP_SEC;
      const merged: Range = [Math.min(range[0], r[0]), Math.max(range[1], r[1])];
      if (near && (merged[0] < range[0] || merged[1] > range[1]) && merged[1] - merged[0] <= MAX_WINDOW_SEC) {
        range = merged;
        grew = true;
      }
    }
  }
  return { range, fetch: [range], stitch: false };
}

/** `range` minus the union of `cover`, as sorted stretches (each longer than a frame or so). */
export function uncovered(range: Range, cover: Range[]): Range[] {
  const out: Range[] = [];
  let t = range[0];
  for (const [a, b] of [...cover].sort((x, y) => x[0] - y[0])) {
    if (b <= t) continue;
    if (a >= range[1]) break;
    if (a > t) out.push([t, Math.min(a, range[1])]);
    t = Math.max(t, b);
    if (t >= range[1]) break;
  }
  if (t < range[1]) out.push([t, range[1]]);
  return out.filter(([a, b]) => b - a > 0.05);
}

/**
 * Which file plays each stretch of `range`, back to back: from every point, the source that covers it and reaches
 * furthest. Null when some point is covered by none (a fetched stretch came back short).
 */
export function stitchPlan<T extends { start: number; end: number }>(range: Range, sources: T[]): Array<{ source: T; a: number; b: number }> | null {
  const out: Array<{ source: T; a: number; b: number }> = [];
  let t = range[0];
  while (t < range[1] - 0.001) {
    const here = sources.filter((s) => s.start <= t + 0.001 && s.end > t + 0.001);
    if (!here.length) return null;
    const best = here.reduce((x, y) => (y.end > x.end ? y : x));
    const b = Math.min(range[1], best.end);
    out.push({ source: best, a: t, b });
    t = b;
  }
  return out;
}

/** A downloaded stretch or a stored window, placed on the source clock. */
interface Piece {
  file: string;
  offsetSec: number;
  start: number;
  end: number;
  width: number;
  height: number;
  fps: number;
  aligned: boolean;
}

async function fetchWindow(ctx: StageContext, project: Project, clip: Clip): Promise<RenderSource> {
  const { svc } = ctx;
  const total = project.durationSec ?? Number.POSITIVE_INFINITY;
  const windows = await ctx.db.query.sourceSections.findMany({ where: eq(schema.sourceSections.projectId, project.id) });
  const clips = await ctx.db.query.clips.findMany({
    where: and(eq(schema.clips.projectId, project.id), isNull(schema.clips.deletedAt)),
    columns: { startSec: true, endSec: true },
  });
  const plan = planWindow({
    clip: [clip.startSec, clip.endSec],
    clips: clips.map((c): Range => [c.startSec, c.endSec]),
    windows: windows.map((w): Range => [w.startSec, w.endSec]),
    total,
  });
  const [start, end] = plan.range;
  ctx.log.info({ clipId: clip.id, range: plan.range, fetch: plan.fetch, stitch: plan.stitch }, "fetching a full-quality window");
  await ctx.progress(0.01, "Fetching the full-quality video", { clipId: clip.id }).catch(() => {});
  // about 1 MB a second at 1080p, and again for the stitched file next to its parts
  await ctx.acquire("render.section", Math.ceil((end - start) * (plan.stitch ? 3 : 2)) + 64, { clipId: clip.id });
  const dir = path.join(await ctx.dir(), "sections");
  await fs.mkdir(dir, { recursive: true });
  const pieces: Piece[] = [];
  for (const r of plan.fetch) pieces.push(await downloadPiece(ctx, project, r, dir));
  const downloadedSec = pieces.reduce((n, p) => n + (p.end - p.start), 0);

  let out: Piece;
  if (!plan.stitch) {
    out = pieces[0]!;
  } else {
    const stored: Piece[] = [];
    for (const w of windows.filter((x) => x.startSec < end && x.endSec > start)) {
      const file = await localWindow(ctx, w);
      if (!file) throw new DownloadFailedError("A stored window went missing; fetching again");
      stored.push({ file, offsetSec: w.offsetSec, start: w.startSec, end: w.endSec, width: w.width, height: w.height, fps: 0, aligned: true });
    }
    out = await stitch(ctx, [...pieces, ...stored], plan.range, dir);
  }
  // a window that stops short of the clip (a cut-short download) would render a truncated clip and be fetched again
  // by every later render: refuse it, and let the retry fetch again (the end of the video is as far as it can go)
  if (out.start > clip.startSec + 0.05 || out.end < Math.min(clip.endSec, total - 0.5) - 0.05) {
    await removeFiles(pieces.map((p) => p.file).concat(out.file));
    throw new DownloadFailedError(
      `The full-quality window came back short (${out.start.toFixed(2)}-${out.end.toFixed(2)} s for a clip at ${clip.startSec}-${clip.endSec} s)`,
    );
  }
  const key = keys.sourceSection(project.id, Math.round(out.start * 1000), Math.round(out.end * 1000));
  // under the window's own name: the sweep knows it as a cache of the store (the local store's object is this file)
  const file = path.join(dir, path.posix.basename(key));
  await fs.rename(out.file, file);
  await removeFiles(pieces.map((p) => p.file).filter((f) => f !== out.file));
  const bytes = (await fs.stat(file)).size;
  await svc.storage.putFile(key, file);
  const row = {
    id: randomUUID(),
    projectId: project.id,
    startSec: out.start,
    endSec: out.end,
    offsetSec: out.offsetSec,
    key,
    bytes,
    width: out.width,
    height: out.height,
  };
  const covered = clips.filter((c) => c.startSec >= row.startSec && c.endSec <= row.endSec).length;
  // a stitched window holds all of the stored windows inside it: those go (rows now, files after commit)
  const replaced = plan.stitch ? windows.filter((w) => w.startSec >= row.startSec - 0.01 && w.endSec <= row.endSec + 0.01) : [];
  await svc.tx(async (u) => {
    await u.db.insert(schema.sourceSections).values(row);
    if (replaced.length)
      await u.db.delete(schema.sourceSections).where(
        inArray(
          schema.sourceSections.id,
          replaced.map((w) => w.id),
        ),
      );
    await u.emit("source.section_fetched", {
      projectId: project.id,
      clipId: clip.id,
      start: Number(row.startSec.toFixed(2)),
      end: Number(row.endSec.toFixed(2)),
      bytes,
      height: out.height,
      aligned: pieces.every((p) => p.aligned) ? "audio" : "nominal",
      downloadedSec: Number(downloadedSec.toFixed(2)),
      clips: covered,
      stitched: plan.stitch,
    });
  });
  for (const w of replaced) {
    await svc.storage.delete(w.key).catch((err) => ctx.log.warn({ err, key: w.key }, "replaced window delete failed"));
    // the scratch copy stays until the sweep: a render on this node may still be reading it
  }
  return { path: file, offsetSec: out.offsetSec, width: out.width, height: out.height, preview: false };
}

async function removeFiles(files: string[]): Promise<void> {
  for (const f of new Set(files)) await fs.rm(f, { force: true }).catch(() => {});
}

/** One stretch of the link at full quality through the proxy pool, placed on the source clock by its sound. */
async function downloadPiece(ctx: StageContext, project: Project, [start, end]: Range, dir: string): Promise<Piece> {
  const { svc } = ctx;
  const stem = `piece-${Math.round(start * 1000)}-${Math.round(end * 1000)}`;
  for (const f of await fs.readdir(dir)) if (f.startsWith(`${stem}.`)) await fs.rm(path.join(dir, f), { force: true });
  let stderrTail = "";
  await svc.media
    .ytdlp(
      [
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "-f",
        sourceFormat(WINDOW_HEIGHT),
        "--merge-output-format",
        "mp4",
        "--download-sections",
        `*${start.toFixed(3)}-${end.toFixed(3)}`,
        "-o",
        path.join(dir, `${stem}.%(ext)s`),
        "--",
        project.sourceUrl!,
      ],
      {
        signal: ctx.signal,
        download: { dir, maxFileBytes: svc.settings.get().MAX_SOURCE_FILE_MB * 1024 * 1024, stallMs: WINDOW_STALL_MS },
        onStderr: (line) => {
          stderrTail = `${stderrTail}\n${line}`.slice(-4000);
        },
      },
    )
    .catch((err: Error) => {
      // a hung connection, not a refusal: the retry starts a fresh download (often through another exit)
      if (err instanceof DownloadStalledError) {
        ctx.log.warn({ range: [start, end], stallMs: err.stallMs }, "full-quality window download stalled; retrying");
        throw new DownloadFailedError(`The full-quality download stopped making progress for ${Math.round(err.stallMs / 60_000)} minutes`);
      }
      if (err instanceof NoEligibleProxyError)
        throw new WindowUnavailableError("no proxy in YTDLP_PROXY can fetch full-quality windows (they need an HTTP or HTTPS proxy, or direct)");
      const message = describeDownloadFailure(err, stderrTail);
      const text = `${err.message}\n${stderrTail}`;
      // gone for good, or the site is turning us away (every exit already tried): render from the preview copy now
      // rather than retry into the same block and fail the clip
      if (isPermanentDownloadFailure(text) || isDownloadBlocked(text)) throw new WindowUnavailableError(message);
      throw new DownloadFailedError(message);
    });
  const name = (await fs.readdir(dir)).find((f) => f.startsWith(`${stem}.`) && f.endsWith(".mp4"));
  if (!name) throw new DownloadFailedError("yt-dlp finished but no section file was produced");
  const file = path.join(dir, name);
  const probe = await svc.media.ffprobe(file);
  if (!probe.width || !probe.height || probe.durationSec <= 0) throw new DownloadFailedError("The downloaded section has no video");
  const placed = await placeWindow(ctx, project, file, start).catch((err: unknown) => {
    if (ctx.signal.aborted) throw err;
    ctx.log.warn({ err }, "could not match the section's audio to the source; using the requested start");
    return null;
  });
  const offsetSec = placed?.offsetSec ?? start;
  const bytes = (await fs.stat(file)).size;
  count(
    "reelsaw.source.section_bytes",
    bytes,
    "By",
    { aligned: placed ? "audio" : "nominal" },
    "Bytes of full-quality windows fetched for preview-sized sources",
  );
  return {
    file,
    offsetSec,
    start: offsetSec,
    end: offsetSec + probe.durationSec,
    width: probe.width,
    height: probe.height,
    fps: probe.fps ?? 0,
    aligned: !!placed,
  };
}

/**
 * One file for `range` from overlapping parts (stored windows and fresh stretches), re-encoded once at near-lossless
 * quality: the cut points are not keyframes, and parts may differ in size or frame rate. Each part's clock is its
 * placement on the source, so the seams land where the sound says. No proxy bytes; a few CPU seconds per minute.
 */
async function stitch(ctx: StageContext, parts: Piece[], range: Range, dir: string): Promise<Piece> {
  const plan = stitchPlan(range, parts);
  if (!plan) throw new DownloadFailedError("The fetched stretches do not reach across the clip; fetching again");
  const args = stitchArgs(plan, path.join(dir, `stitch-${Math.round(range[0] * 1000)}-${Math.round(range[1] * 1000)}.mp4`));
  await ctx.svc.resources.withCpu({ kind: "stitch", cpu: ENCODE_PASS_CPU, ids: { projectId: ctx.projectId } }, (threads) =>
    ctx.svc.media.ffmpeg(args.argv, { signal: ctx.signal, threads }),
  );
  ctx.log.info({ range, parts: plan.map((s) => ({ a: s.a, b: s.b, file: path.basename(s.source.file) })) }, "stitched a window from stored and fresh parts");
  return { file: args.file, offsetSec: range[0], start: range[0], end: range[1], width: args.width, height: args.height, fps: args.fps, aligned: true };
}

/** ffmpeg arguments that play each planned stretch from its file, conformed to the first part's size, back to back. */
export function stitchArgs(
  plan: Array<{ source: Pick<Piece, "file" | "offsetSec" | "width" | "height" | "fps">; a: number; b: number }>,
  file: string,
): { argv: string[]; file: string; width: number; height: number; fps: number } {
  const first = plan[0]!.source;
  const width = Math.round(first.width / 2) * 2;
  const height = Math.round(first.height / 2) * 2;
  const fps = plan.map((p) => p.source.fps).find((f) => f > 0) ?? 30;
  const inputs = plan.flatMap((seg) => ["-ss", (seg.a - seg.source.offsetSec).toFixed(3), "-t", (seg.b - seg.a).toFixed(3), "-i", seg.source.file]);
  const chains = plan.map(
    (_, i) =>
      `[${i}:v:0]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:-1:-1,setsar=1,fps=${fps.toFixed(3)},format=yuv420p[v${i}];` +
      `[${i}:a:0]aresample=48000,aformat=channel_layouts=stereo[a${i}]`,
  );
  const graph = `${chains.join(";")};${plan.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${plan.length}:v=1:a=1[v][a]`;
  const argv = [
    "-y",
    ...inputs,
    "-filter_complex",
    graph,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "16",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    file,
  ];
  return { argv, file, width, height, fps };
}

/** Where the window starts on the source clock, from its sound against the preview's. */
async function placeWindow(ctx: StageContext, project: Project, file: string, requested: number): Promise<{ offsetSec: number; score: number } | null> {
  const refStart = Math.max(0, requested - SEARCH_SEC + PROBE_FROM_SEC);
  const refSec = 2 * SEARCH_SEC + PROBE_SEC;
  const preview = await ctx.sourceAt(project, [refStart, refStart + refSec]);
  const [ref, probe] = await Promise.all([
    clipPcm(ctx.svc.config.FFMPEG_PATH, preview.path, refStart - preview.offsetSec, refSec, ctx.signal),
    clipPcm(ctx.svc.config.FFMPEG_PATH, file, PROBE_FROM_SEC, PROBE_SEC, ctx.signal),
  ]);
  const m = measureOffset(ref, probe, VAD_SR);
  if (!m) return null;
  // probe t=PROBE_FROM_SEC in the file is ref t=m.lagSec, i.e. source time refStart + lagSec
  const offsetSec = refStart + m.lagSec - PROBE_FROM_SEC;
  ctx.log.debug({ requested, offsetSec: Number(offsetSec.toFixed(3)), score: Number(m.score.toFixed(3)) }, "section placed by audio");
  return { offsetSec: Math.max(0, offsetSec), score: m.score };
}

/**
 * Where `probe` sits inside `ref` (both mono PCM at `sr`): the lag in seconds that best lines them up, found on
 * loudness envelopes (100 Hz) and refined on the samples within one envelope step. Null when the best match is
 * weak or the probe is near silence: a guess there would be worse than the requested start.
 */
export function measureOffset(ref: Float32Array, probe: Float32Array, sr: number): { lagSec: number; score: number } | null {
  if (probe.length < sr || ref.length < probe.length) return null;
  const hop = Math.round(sr / ENV_HZ);
  const re = envelope(ref, hop);
  const pe = envelope(probe, hop);
  const coarse = bestLag(re, pe, 0, re.length - pe.length);
  if (!coarse || coarse.score < MATCH_MIN_SCORE) return null;
  // fine: raw samples around the coarse lag, on a decimated stretch to bound the work
  const lo = Math.max(0, coarse.lag * hop - hop);
  const hi = Math.min(ref.length - probe.length, coarse.lag * hop + hop);
  const fine = bestLag(ref, probe.subarray(0, Math.min(probe.length, sr * 2)), lo, hi);
  const lag = fine && fine.score > 0.3 ? fine.lag : coarse.lag * hop;
  return { lagSec: lag / sr, score: coarse.score };
}

function envelope(x: Float32Array, hop: number): Float32Array {
  const n = Math.floor(x.length / hop);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) s += x[j]! * x[j]!;
    out[i] = Math.sqrt(s / hop);
  }
  return out;
}

/** Normalised cross-correlation of `b` against `a` at lags lo..hi; the best lag and its score (-1..1). */
function bestLag(a: Float32Array, b: Float32Array, lo: number, hi: number): { lag: number; score: number } | null {
  let bMean = 0;
  for (const v of b) bMean += v;
  bMean /= b.length;
  let bVar = 0;
  for (const v of b) bVar += (v - bMean) ** 2;
  if (bVar < 1e-9 * b.length) return null; // silence: nothing to match
  let best: { lag: number; score: number } | null = null;
  for (let lag = lo; lag <= hi; lag++) {
    let aMean = 0;
    for (let i = 0; i < b.length; i++) aMean += a[lag + i]!;
    aMean /= b.length;
    let num = 0;
    let aVar = 0;
    for (let i = 0; i < b.length; i++) {
      const da = a[lag + i]! - aMean;
      num += da * (b[i]! - bMean);
      aVar += da * da;
    }
    if (aVar <= 0) continue;
    const score = num / Math.sqrt(aVar * bVar);
    if (!best || score > best.score) best = { lag, score };
  }
  return best;
}

/** Drop a project's stored windows (its source changed or expired); the files go with the rows. */
export async function dropWindows(svc: Services, projectId: string): Promise<void> {
  const rows = await svc.database.db
    .delete(schema.sourceSections)
    .where(eq(schema.sourceSections.projectId, projectId))
    .returning({ key: schema.sourceSections.key });
  for (const r of rows) await svc.storage.delete(r.key).catch(() => {});
  await removeScratchWindows(svc, projectId);
}
