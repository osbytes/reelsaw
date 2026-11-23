import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  QuotaExceededError,
  type SourceAdmission,
  admitRanges,
  admitSource,
  hasMinuteLimits,
  recordSourceDuration,
  recordedSourceSec,
  sourceHeightFor,
  trackIngestRefusal,
} from "../quota.js";
import { takeTxLock, txLock } from "../locks.js";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { RANGE_FETCH_GAP_SEC, RANGE_MIN_SEC, mergeSpans, planRanges, spansCover, spansSec, transcriptSpans } from "@reelsaw/shared";
import { buildSparseSource, type SourcePiece } from "./sparse.js";
import { rangeProblemsText } from "../projects/ranges.js";
import type { Project, ProjectRange } from "../db/schema.js";
import type { UnitOfWork } from "../uow.js";
import type { Services } from "../services.js";
import { schema } from "../db/index.js";
import { keys } from "../storage/index.js";
import { QUEUES } from "../queue/boss.js";
import { UnresolvableHostError, UnsafeUrlError, assertPublicHttpUrl } from "../lib/safe-url.js";
import { LIVE_SOURCE_MESSAGE, LiveSourceError, NOT_LIVE_FILTER, announcedDuration } from "../projects/peek.js";
import { type StageContext, DownloadFailedError, NonRetryableError, SourceUnavailableError, exists, sourceScratchMB } from "./common.js";
import { count, histogram, realtimeFactor } from "../metrics.js";
import { sha256File } from "./bumpers.js";
import { CommandError, DownloadTooLargeError } from "../media.js";
import { BOT_CHECK, FFMPEG_REFUSED, isPageMissing, isPermanentDownloadFailure, largestReportedFile } from "../ytdlp-errors.js";
import { NoEligibleProxyError } from "../ytdlp-proxy.js";
import { ENCODE_PASS_CPU } from "../resources.js";

export { isPermanentDownloadFailure } from "../ytdlp-errors.js";

const UPLOAD_MISSING = "Uploaded source file is missing";
/** The download skipped a link the lookup said was not live: a fault in Reelsaw's filter, not in the link. */
const FILTER_CONTRADICTION_MESSAGE =
  "Could not download this link: the downloader skipped it as a live stream, but it is not one. This is a Reelsaw problem, not your link. Try again after an update, or upload the file instead (New project → Upload).";

/** A source with sound and no picture at all: every clip's render needs a video stream to frame. */
export const NO_VIDEO_MESSAGE =
  "This file has sound but no video, and clips are made from video. Upload the video itself, or an audio file with cover art (the art becomes the picture).";

/**
 * ffmpeg arguments that turn a source whose only picture is a still (an audio file's cover art, or a video track of one
 * frame) into a real video: the picture held for `durationSec` at one frame a second, the first audio stream copied
 * untouched so the transcript's timestamps still line up with the sound. `audio: "aac"` re-encodes a codec mp4 cannot
 * carry. A keyframe every 10 s keeps a clip's seek cheap.
 */
export function stillVideoArgs(picture: string, source: string, durationSec: number, out: string, audio: "copy" | "aac" = "copy"): string[] {
  return [
    "-y",
    "-loop",
    "1",
    "-framerate",
    "1",
    "-i",
    picture,
    "-i",
    source,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-t",
    durationSec.toFixed(3),
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "stillimage",
    "-g",
    "10",
    "-pix_fmt",
    "yuv420p",
    ...(audio === "copy" ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "192k"]),
    "-movflags",
    "+faststart",
    out,
  ];
}

/**
 * The source as a real video when its only picture is a still. Rendered as it is, such a source makes clips with sound
 * alone: each clip seeks past the one frame, ffmpeg drops the empty video stream, and the thumbnail of the result then
 * fails, on every retry. Done once, here, so every later stage (framing, render, the editor's preview) sees a video.
 */
async function stillAsVideo(ctx: StageContext, sourcePath: string): Promise<string> {
  const { media } = ctx.svc;
  const probe = await media.ffprobe(sourcePath);
  if (!probe.still || !probe.hasAudio || !(probe.durationSec > 0)) return sourcePath;
  await ctx.progress(0.65, "Turning the cover art into video");
  const dir = path.dirname(sourcePath);
  const picture = path.join(dir, "still.png");
  const out = path.join(dir, "source.still.mp4");
  try {
    await media.ffmpeg(["-y", "-i", sourcePath, "-map", "0:v:0", "-frames:v", "1", picture], { signal: ctx.signal, threads: "light" });
    await ctx.svc.resources.withCpu({ kind: "ingest-encode", cpu: ENCODE_PASS_CPU, ids: { projectId: ctx.projectId } }, (threads) =>
      media
        .ffmpeg(stillVideoArgs(picture, sourcePath, probe.durationSec, out), { signal: ctx.signal, threads })
        .catch(() => media.ffmpeg(stillVideoArgs(picture, sourcePath, probe.durationSec, out, "aac"), { signal: ctx.signal, threads })),
    );
    const video = path.join(dir, "source.mp4");
    await fs.rm(sourcePath, { force: true });
    await fs.rename(out, video);
    ctx.log.info({ durationSec: probe.durationSec, width: probe.width, height: probe.height }, "still source made into video");
    return video;
  } finally {
    await fs.rm(picture, { force: true });
    await fs.rm(out, { force: true });
  }
}

/** Scratch MB to copy the source onto this node, on top of MIN_FREE_DISK_MB. Known size (an upload, or a stored source) is the file plus a small probe margin; a link is unknown so we reserve 2 GB. */
export function ingestScratchMB(knownBytes?: number | null) {
  return sourceScratchMB(knownBytes);
}

export async function ingest(ctx: StageContext) {
  const { svc, projectId } = ctx;
  const project = await ctx.project();
  const dir = await ctx.dir();
  await ctx.start("ingesting");

  // a link's ranges: when a person or a caller chose some, only the time every range needs is downloaded (a sparse
  // source), its "whole" ranges included (a partly processed start, parts added by Clip the rest); a range added since
  // that the sparse source does not hold has it fetched again
  const linkRanges =
    project.sourceType === "url"
      ? await ctx.db
          .select({ startSec: schema.projectRanges.startSec, endSec: schema.projectRanges.endSec, origin: schema.projectRanges.origin })
          .from(schema.projectRanges)
          .where(eq(schema.projectRanges.projectId, projectId))
      : [];
  const chosenRanges = linkRanges.filter((r) => r.origin !== "whole");
  const sparseHeld = (project.sourceMeta?.["sparse"] as { spans?: [number, number][] } | undefined)?.spans;
  const sparseShort = !!sparseHeld && project.durationSec !== null && !spansCover(sparseHeld, transcriptSpans(linkRanges, project.durationSec));
  const stored = !sparseShort && project.sourceKey && (await svc.storage.exists(project.sourceKey));
  const upload =
    !stored && project.sourceType === "upload"
      ? await ctx.db.query.uploads.findFirst({ where: eq(schema.uploads.id, String(project.sourceMeta?.["uploadId"] ?? "")) })
      : undefined;
  // the upload row is written before the project that names it, so a missing one is gone for good, not late
  if (!stored && project.sourceType === "upload" && !upload) throw new NonRetryableError(UPLOAD_MISSING);
  await ctx.acquire("ingest", ingestScratchMB(stored ? project.sourceBytes : upload?.sizeBytes));

  let meta: Record<string, unknown> = project.sourceMeta ?? {};
  let sourcePath: string | undefined;
  let sourceKey = project.sourceKey ?? undefined;
  /** a link's download, measured once the probe knows the video's length */
  let download: { proxy: string; sec: number } | undefined;

  if (stored && sourceKey) {
    sourcePath = await svc.storage.ensureLocal(sourceKey, path.join(dir, path.posix.basename(sourceKey)));
  } else {
    if (project.sourceType === "url") {
      // web and MCP both land here, so one check covers every way of adding a link
      await assertPublicHttpUrl(project.sourceUrl ?? "", { allowPrivate: svc.settings.get().ALLOW_PRIVATE_SOURCE_URLS }).catch((err: unknown) => {
        // a malformed or internal link is refused the same way every time; a DNS lookup that failed may work next time
        if (err instanceof UnsafeUrlError && !(err instanceof UnresolvableHostError)) throw new NonRetryableError(err.message);
        throw err;
      });
      // refuse an over-limit video before fetching it, when the site tells us its length up front
      const { sec: announced, missing } = await announcedDurationOrNull(ctx, project.sourceUrl ?? "");
      // no length up front: the limit is checked only on the file, after the whole download (worth knowing how often)
      if (missing && (await hasMinuteLimits(svc.database.db, svc.settings.get(), project.userId, svc.entitlements))) countMinutesPrecheckSkipped(missing);
      // (a video admitted before, fetched again after retention, is not decided again)
      if (announced && (await recordedSourceSec(ctx.db, projectId)) === null) {
        const over = await svc.tx(async (u) => {
          await takeTxLock(u.db, txLock.quota(project.userId));
          // ranges count only their own time (admitted whole or refused, as at the end of ingest); a whole video is not
          // refused while its start fits: only less than one chunk of room refuses before downloading
          const planned = chosenRanges.length
            ? planRanges(
                chosenRanges.map((r) => ({ startSec: r.startSec, endSec: r.endSec })),
                { durationSec: announced, maxClipSec: Number.POSITIVE_INFINITY },
              )
            : null;
          const admit: Promise<unknown> = planned
            ? planned.ok
              ? admitRanges(u.db, svc.settings.get(), project.userId, projectId, planned.billedSec, svc.entitlements)
              : Promise.resolve() // ranges that cannot be ranges are refused, with their reasons, once the file's length is known
            : admitSource(u.db, svc.settings.get(), project.userId, projectId, announced, svc.config.TRANSCRIBE_CHUNK_SECONDS, svc.entitlements);
          return admit.then(
            () => null,
            (err: unknown) => {
              if (err instanceof QuotaExceededError) return err;
              throw err;
            },
          );
        });
        if (over) {
          ctx.log.warn({ userId: project.userId, durationSec: announced, reason: over.message }, "source-minutes limit reached before download");
          trackIngestRefusal(svc.telemetry, project.userId, over);
          throw over;
        }
      }
      // a plan with a source cap (Free) downloads a small copy for the editor and analysis; each clip's render
      // fetches its own window at full quality (windows.ts), so the proxy never carries the whole video in HD
      const cap = await sourceHeightFor(ctx.db, project.userId, svc.entitlements);
      const { previewHeight: _was, ...rest } = meta;
      meta = cap ? { ...rest, previewHeight: cap } : rest;
      let stderrTail = "";
      let info: Record<string, unknown> | undefined;
      let downloaded = 0; // fraction so far; video then audio are two downloads, so never let the bar go backwards
      let jsonLine: string | undefined; // --print-json's info line; stdout itself is not kept (progress has no size bound)
      const limitMB = svc.settings.get().MAX_SOURCE_FILE_MB;
      // --max-filesize only refuses a size known up front; a fragmented download (a stream's recording) has none, so
      // stop it ourselves once what has arrived passes the limit instead of letting it run for hours
      const oversize = new AbortController();
      /**
       * one yt-dlp download to `<stem>.<ext>`: the whole video, or one section of it; `share` places its progress and
       * `part` ("part 2 of 3") says which section, since each one's own percentage starts over
       */
      const fetchSource = (stem: string, section: [number, number] | null, share: [number, number], part?: string) =>
        svc.media
          .ytdlp(
            [
              "--no-playlist",
              "--no-warnings",
              // --print-json implies --quiet, which hides progress unless asked for; --newline makes each tick a stdout line
              "--progress",
              "--newline",
              "--print-json",
              // prefer H.264: decodes everywhere (browser preview, Safari) and renders 3-5x faster than AV1/VP9 on CPU
              "-f",
              sourceFormat(cap ?? 1080, !!cap),
              "--merge-output-format",
              "mp4",
              // a live stream would be recorded until it ends; skip it here too, for when the lookup above could not tell
              "--match-filter",
              NOT_LIVE_FILTER,
              "--max-filesize",
              `${limitMB}M`,
              ...(section ? ["--download-sections", `*${section[0].toFixed(3)}-${section[1].toFixed(3)}`] : []),
              "-o",
              path.join(dir, `${stem}.%(ext)s`),
              "--",
              project.sourceUrl!,
            ],
            {
              signal: AbortSignal.any([ctx.signal, oversize.signal]),
              download: { dir, maxFileBytes: limitMB * 1024 * 1024 },
              onStderr: (line) => {
                stderrTail = (stderrTail + "\n" + line).slice(-4000);
              },
              onStdout: (line) => {
                if (line.trimStart().startsWith("{")) jsonLine = line;
                const tick = parseDownloadTick(line);
                if (!tick) return;
                if (tick.bytes !== null && tick.bytes > limitMB * 1024 * 1024 && !oversize.signal.aborted) oversize.abort();
                downloaded = Math.max(downloaded, share[0] + tick.fraction * share[1]);
                void ctx.progress(downloaded * 0.6, part ? `${tick.message} (${part})` : tick.message).catch(() => {});
              },
            },
          )
          .catch((err: Error) => {
            ctx.signal.throwIfAborted();
            if (oversize.signal.aborted || err instanceof DownloadTooLargeError) throw new NonRetryableError(overSizeLimitMessage(limitMB, null));
            // this server's download route cannot fetch parts of a video: say so, not "the site blocked it"
            if (err instanceof NoEligibleProxyError) throw new DownloadFailedError(NO_SECTION_ROUTE_MESSAGE);
            const message = describeDownloadFailure(err, stderrTail);
            // a dead or unsupported link answers the same on every attempt: fail the run now rather than retry it
            if (isPermanentDownloadFailure(`${err.message}\n${stderrTail}`)) throw new SourceUnavailableError(message);
            throw new DownloadFailedError(message);
          });
      // a link with ranges (docs/specs/range-clipping.md): only its padded ranges are downloaded, close ones together,
      // and joined on the source clock into a sparse source (pipeline/sparse.ts); needs the length the site announced
      const sparseSpans = chosenRanges.length && announced ? mergeSpans(transcriptSpans(linkRanges, announced), RANGE_FETCH_GAP_SEC) : null;
      const t0 = performance.now();
      let proxyId = "";
      const pieces: SourcePiece[] = [];
      if (sparseSpans) {
        const total = spansSec(sparseSpans);
        let done = 0;
        for (const [i, span] of sparseSpans.entries()) {
          const stem = `piece-${i}`;
          for (const f of await fs.readdir(dir)) if (f.startsWith(`${stem}.`)) await fs.rm(path.join(dir, f), { force: true });
          const part = `part ${i + 1} of ${sparseSpans.length}`;
          // a section's first progress line comes only once ffmpeg has found its start, which takes a while: say which now
          await ctx.progress((done / total) * 0.6, `Downloading ${part}`).catch(() => {});
          ({ proxyId } = await fetchSource(stem, span, [done / total, (span[1] - span[0]) / total], part));
          done += span[1] - span[0];
          const name = (await fs.readdir(dir)).find((f) => f.startsWith(`${stem}.`) && f.endsWith(".mp4"));
          if (!name) throw new Error("yt-dlp finished but no file was produced for a range");
          pieces.push({ path: path.join(dir, name), startSec: span[0], endSec: span[1] });
        }
        meta = { ...meta, sparse: { spans: sparseSpans } };
        ctx.log.info({ spans: sparseSpans, fetchedSec: Math.round(total), durationSec: announced }, "downloaded only the project's ranges");
      } else {
        ({ proxyId } = await fetchSource("source", null, [0, 1]));
        const { sparse: _was, ...rest } = meta;
        meta = rest;
      }
      download = { proxy: proxyId, sec: (performance.now() - t0) / 1000 };
      if (jsonLine) {
        info = JSON.parse(jsonLine) as Record<string, unknown>;
        meta = {
          ...meta,
          title: info["title"],
          uploader: info["uploader"] ?? info["channel"] ?? meta["uploader"],
          duration: info["duration"],
          webpage_url: info["webpage_url"],
          // the source fingerprint decisions point at (docs/specs/decision-log.md): videoId gets the video back, formatId says which encode
          extractor: info["extractor_key"],
          videoId: info["id"],
          formatId: info["format_id"],
          thumbnail: meta["thumbnail"] ?? info["thumbnail"],
          ext: info["ext"],
          description: typeof info["description"] === "string" ? info["description"].slice(0, 4000) : undefined,
          tags: Array.isArray(info["tags"]) ? info["tags"].slice(0, 40) : undefined,
          chapters: Array.isArray(info["chapters"])
            ? (info["chapters"] as Array<{ title?: string }>)
                .map((c) => c.title)
                .filter(Boolean)
                .slice(0, 40)
            : undefined,
        };
      }
      // --match-filter skipped the link: no info line, no file, exit 0. That is the live refusal only when the lookup
      // could not tell; a lookup that said "not live" contradicts the filter, which is our fault, not the link's
      if (!info) {
        if (missing === "failed") throw new NonRetryableError(LIVE_SOURCE_MESSAGE);
        ctx.log.error({ filter: NOT_LIVE_FILTER, stderrTail }, "download skipped by the live filter although the lookup said not live");
        throw new NonRetryableError(FILTER_CONTRADICTION_MESSAGE, "platform");
      }
      if (sparseSpans && announced) {
        await ctx.progress(0.62, "Joining the ranges");
        sourcePath = await buildSparseSource(ctx, pieces, announced, dir);
      }
      const files = (await fs.readdir(dir)).filter((f) => f.startsWith("source."));
      const chosen = files.find((f) => f.endsWith(".mp4")) ?? files[0];
      if (!chosen) {
        // --max-filesize makes yt-dlp skip an over-limit download and still exit 0; the same video is as big next time
        const largest = info ? largestReportedFile(info) : null;
        if (largest !== null && largest > limitMB * 1024 * 1024) throw new NonRetryableError(overSizeLimitMessage(limitMB, largest));
        throw new Error("yt-dlp finished but no source file was produced");
      }
      sourcePath = path.join(dir, chosen);
    } else {
      if (!upload) throw new NonRetryableError(UPLOAD_MISSING);
      const ext = path.extname(upload.storageKey) || ".mp4";
      sourcePath = path.join(dir, `source${ext}`);
      await ctx.progress(0.3, "Copying your upload");
      await svc.storage.ensureLocal(upload.storageKey, sourcePath);
    }
    sourcePath = await stillAsVideo(ctx, sourcePath);
    sourceKey = keys.source(projectId, path.extname(sourcePath) || ".mp4");
    await ctx.progress(0.7, "Storing source");
    await svc.storage.putFile(sourceKey, sourcePath);
  }
  if (!sourcePath || !(await exists(sourcePath))) throw new Error("Source file missing after ingest");
  ctx.log.debug(
    {
      sourceType: project.sourceType,
      reusedStoredSource: !!project.sourceKey && sourceKey === project.sourceKey,
      ytdlp: project.sourceType === "url" ? { title: meta["title"], uploader: meta["uploader"], duration: meta["duration"], ext: meta["ext"] } : undefined,
    },
    "source fetched",
  );

  await ctx.progress(0.9, "Probing media");
  const probe = await svc.media.ffprobe(sourcePath);
  if (!probe.hasAudio) throw new NonRetryableError("Source has no audio track; nothing to transcribe");
  if (!probe.width || !probe.height) throw new NonRetryableError(NO_VIDEO_MESSAGE);
  const sourceBytes = (await fs.stat(sourcePath)).size;
  // the exact bytes the transcript's timestamps refer to; a stored source already hashed keeps its hash
  if (!(stored && typeof meta["sha256"] === "string")) meta = { ...meta, sha256: await sha256File(sourcePath) };
  await ctx.release(); // the source is on disk, where free-space checks count it: the lease has done its job
  ctx.log.debug(
    {
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      sourceBytes,
      sourceType: project.sourceType,
      sha256: meta["sha256"],
      videoId: meta["videoId"],
    },
    "source facts",
  );
  if (download) recordDownload(download.proxy, download.sec, probe.durationSec, sourceBytes);

  // an upload has no platform thumbnail: a frame a tenth of the way in (past a black or fading first second) is its
  // poster on the project page and its tile until clips exist. Best effort: a poster is never worth failing ingest.
  if (!meta["thumbnail"] && probe.width) {
    // its own name: an upload's source path can sit in a folder other ingests share
    const posterPath = path.join(os.tmpdir(), `reelsaw-poster-${projectId}.jpg`);
    try {
      const firstSpan = (meta["sparse"] as { spans?: [number, number][] } | undefined)?.spans?.[0];
      const at = firstSpan ? Math.min(firstSpan[1], firstSpan[0] + 20) : Math.min(30, Math.max(0, (probe.durationSec ?? 0) * 0.1));
      await svc.media.ffmpeg(["-y", "-ss", at.toFixed(2), "-i", sourcePath, "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", "-q:v", "4", posterPath], {
        threads: "light",
      });
      await svc.storage.putFile(keys.sourcePoster(projectId), posterPath);
      meta = { ...meta, thumbnail: `/media/source/${projectId}/poster.jpg` };
    } catch (err) {
      ctx.log.warn({ err }, "source poster skipped");
    } finally {
      await fs.rm(posterPath, { force: true });
    }
  }

  const generic = !project.title || project.title === "Untitled" || /^[\w.-]+\.[a-z]{2,}$/i.test(project.title); // "Untitled" or a bare hostname
  const title = generic ? ((meta["title"] as string | undefined) ?? project.title) : project.title;
  // set inside the unit of work (which may run again after a deadlock), read after it commits
  const decided: { admitted: SourceAdmission | null } = { admitted: null };
  await ctx.complete({ sourceDurationSec: probe.durationSec, title }, async (u) => {
    // the binding minutes check: under the account's quota lock, in the unit that records this length, so two
    // ingests of one account cannot both pass a cap they jointly exceed (the create-side check is only advisory).
    // A video admitted before (its source fetched again after retention) keeps what it was admitted as.
    await takeTxLock(u.db, txLock.quota(project.userId));
    decided.admitted = null;
    const recorded = await recordedSourceSec(u.db, projectId);
    // ranges, then the project row: the ranges a person or a caller chose are admitted whole or refused, never cut short
    const ranges = await u.db.select().from(schema.projectRanges).where(eq(schema.projectRanges.projectId, projectId)).for("update");
    const chosen = ranges.filter((r) => r.origin !== "whole");
    const rangesSec = chosen.length && recorded === null ? await settleRanges(svc, u, project, chosen, probe.durationSec) : null;
    if (recorded === null && rangesSec === null) {
      try {
        decided.admitted = await admitSource(
          u.db,
          svc.settings.get(),
          project.userId,
          projectId,
          probe.durationSec,
          svc.config.TRANSCRIBE_CHUNK_SECONDS,
          svc.entitlements,
        );
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          ctx.log.warn({ userId: project.userId, durationSec: probe.durationSec, reason: err.message }, "source-minutes limit reached");
          trackIngestRefusal(svc.telemetry, project.userId, err);
        }
        throw err;
      }
    }
    const admitted = decided.admitted;
    // ranges bound the work themselves; a whole video may be cut to the start the minutes cover
    const limit = chosen.length ? null : admitted ? admitted.until : (project.sourceLimitSec ?? null);
    await u.db
      .update(schema.projects)
      .set({
        sourceKey,
        sourceBytes,
        sourceExpiredAt: null,
        sourceMeta: meta,
        durationSec: probe.durationSec,
        sourceLimitSec: limit,
        width: probe.width ?? null,
        height: probe.height ?? null,
        title: sql`case when ${schema.projects.title} = ${project.title} then ${title} else ${schema.projects.title} end`,
        updatedAt: new Date(),
      })
      .where(eq(schema.projects.id, projectId));
    if (rangesSec !== null) await recordSourceDuration(u.db, projectId, rangesSec);
    if (!ranges.length) {
      const end = limit === null ? probe.durationSec : Math.min(limit, probe.durationSec);
      await u.db.insert(schema.projectRanges).values({ id: randomUUID(), projectId, startSec: 0, endSec: end, mode: "find", origin: "whole", billedSec: end });
    }
    if (admitted) {
      // the ledger counts what is processed: the whole video, or the start a partial project covers
      await recordSourceDuration(u.db, projectId, admitted.until ?? probe.durationSec);
      if (admitted.until !== null) {
        const reason = admitted.firstVideo ? "first_video" : "minutes";
        await u.emit("source.partial", { projectId, untilSec: admitted.until, durationSec: probe.durationSec, reason });
        ctx.log.info({ untilSec: admitted.until, durationSec: probe.durationSec, reason }, "processing the start of the video the minutes cover");
      }
    }
    await u.enqueue(QUEUES.transcribe, { projectId });
  });
  const partial = decided.admitted;
  if (partial?.until != null)
    svc.telemetry.capture("source.partial", project.userId, {
      projectId,
      firstVideo: partial.firstVideo,
      processedMinutes: Math.round(partial.until / 60),
      totalMinutes: Math.round(probe.durationSec / 60),
    });
  void svc;
}

/**
 * The ranges a project was created with, now that the file's length is known: clamped to it (the length announced
 * before downloading can differ by a second), joined where they overlap, priced, and admitted against the account's
 * minutes (refused with the upgrade offer when they do not fit). Returns the billed seconds. In the ingest's unit,
 * under the quota lock and with the ranges locked.
 */
async function settleRanges(svc: Services, u: UnitOfWork, project: Project, all: ProjectRange[], durationSec: number): Promise<number> {
  // a file's length is known only now: a range that starts past its end (or keeps less than RANGE_MIN_SEC of it) is
  // dropped, and the others are clipped; only when none is left does the project fail, with every reason
  const fits = (r: ProjectRange) => r.startSec < durationSec && Math.min(r.endSec, durationSec) - r.startSec >= RANGE_MIN_SEC;
  const chosen = all.filter(fits);
  const outside = all.filter((r) => !fits(r));
  const asInput = (r: ProjectRange) => ({ startSec: r.startSec, endSec: r.endSec, mode: r.mode });
  // modes were settled when the ranges were chosen; here only the length can change them
  const plan = planRanges(chosen.map(asInput), { durationSec, maxClipSec: Number.POSITIVE_INFINITY });
  if (!plan.ok) {
    const refused = planRanges(all.map(asInput), { durationSec, maxClipSec: Number.POSITIVE_INFINITY });
    // stored as the owner reads it: the job runs in their locale
    throw new NonRetryableError(rangeProblemsText(refused.ok ? [] : refused.problems).join(" "));
  }
  if (outside.length)
    svc.log
      .child({ module: "ingest", projectId: project.id })
      .warn({ durationSec, dropped: outside.map((r) => [r.startSec, r.endSec]) }, "ranges past the end of the file dropped");
  const dropped: string[] = outside.map((r) => r.id);
  for (const r of plan.ranges) {
    const [keep, ...rest] = r.inputs.map((i) => chosen[i]).filter((x): x is ProjectRange => x !== undefined);
    if (!keep) continue;
    dropped.push(...rest.map((x) => x.id));
    await u.db
      .update(schema.projectRanges)
      .set({ startSec: r.startSec, endSec: r.endSec, mode: r.mode, billedSec: r.billedSec })
      .where(eq(schema.projectRanges.id, keep.id));
  }
  if (dropped.length) await u.db.delete(schema.projectRanges).where(inArray(schema.projectRanges.id, dropped));
  try {
    await admitRanges(u.db, svc.settings.get(), project.userId, project.id, plan.billedSec, svc.entitlements);
  } catch (err) {
    if (err instanceof QuotaExceededError) trackIngestRefusal(svc.telemetry, project.userId, err);
    throw err;
  }
  return plan.billedSec;
}

/**
 * yt-dlp format selector for a link's source, at most `height` tall. H.264 first: it decodes everywhere (browser
 * preview, Safari) and renders 3-5x faster than AV1/VP9 on CPU. A preview copy (`small`) keeps the same audio stream
 * as the full download (`ba[ext=m4a]`, ~1 MB a minute): transcription hears it at full quality, and a clip's
 * full-quality window lines up with it sample for sample (windows.ts). Without a small enough video, the smallest.
 */
export function sourceFormat(height: number, small = false): string {
  const h = `[height<=${height}]`;
  return [`bv*[vcodec^=avc1]${h}[ext=mp4]+ba[ext=m4a]`, `bv*${h}[ext=mp4]+ba[ext=m4a]`, `b${h}[ext=mp4]`, `bv*${h}+ba`, small ? "wv*+ba/w" : "b"].join("/");
}

/**
 * `announcedDuration` for the stage, and why it is missing (the site did not say, or the lookup failed): only a
 * cancelled stage, a permanently dead link or a live stream stops here.
 */
async function announcedDurationOrNull(ctx: StageContext, url: string): Promise<{ sec: number | null; missing: "unannounced" | "failed" | null }> {
  try {
    const sec = await announcedDuration(ctx.svc.media, url, ctx.signal);
    return { sec: sec || null, missing: sec ? null : "unannounced" };
  } catch (err) {
    ctx.signal.throwIfAborted();
    if (err instanceof LiveSourceError) throw new NonRetryableError(err.message);
    // the lookup already walked every proxy: a permanent answer here would be the download's answer too
    const stderr = err instanceof CommandError ? err.stderr : "";
    const text = `${err instanceof Error ? err.message : String(err)}\n${stderr}`;
    if (err instanceof Error && isPermanentDownloadFailure(text)) throw new SourceUnavailableError(describeDownloadFailure(err, stderr));
    ctx.log.debug({ err }, "could not look up the video's length before downloading");
    return { sec: null, missing: "failed" };
  }
}

/** A link with a minutes limit downloaded before its length was known: the binding check ran only on the file. */
function countMinutesPrecheckSkipped(reason: "unannounced" | "failed") {
  count("reelsaw.quota.minutes_precheck_skipped", 1, "{download}", { reason }, "Links downloaded under a minutes limit before their length was known");
}

/**
 * Proxy performance normalised by the video: a 2-hour talk takes longer than a 30-second clip through
 * any exit, so compare download seconds per second of video, and bytes per second, by proxy.
 */
export function recordDownload(proxy: string, sec: number, videoSec: number, bytes: number) {
  const rtf = realtimeFactor(sec, videoSec);
  if (rtf !== null)
    histogram("reelsaw.ytdlp.download.realtime_factor", rtf, "1", { proxy }, "Download wall seconds per second of video, by the proxy that served it");
  if (sec > 0 && bytes > 0) histogram("reelsaw.ytdlp.download.throughput", bytes / sec, "By/s", { proxy }, "Downloaded source bytes per wall second, by proxy");
}

/** The same video is as big on every attempt: refused with the size when yt-dlp reported one. */
function overSizeLimitMessage(limitMB: number, bytes: number | null) {
  const about = bytes === null ? "" : ` (about ${Math.ceil(bytes / 1024 / 1024)} MB)`;
  return `Could not download: the video is larger than the ${limitMB} MB download limit${about}. Try a shorter video, or upload the file instead (New project → Upload).`;
}

/**
 * A yt-dlp `--newline` progress line ("[download]  12.3% of ~ 1.57GiB at 5.00MiB/s ETA 04:00") as a fraction, the
 * bytes of the current file that have arrived (null when the line gives no total) and a short message for the activity
 * bar. Null for every other line.
 */
export function parseDownloadTick(line: string): { fraction: number; bytes: number | null; message: string } | null {
  const m = /^\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*(\S+))?(?:\s+at\s+(\S+))?/.exec(line);
  if (!m) return null;
  const pct = Number(m[1]);
  const parts = [`Downloading ${Math.floor(pct)}%`];
  if (m[2]) parts.push(`of ${m[2]}`);
  if (m[3] && m[3] !== "Unknown") parts.push(`at ${m[3]}`);
  const fraction = Math.max(0, Math.min(1, Math.round(pct * 100) / 10_000));
  const total = m[2] ? sizeBytes(m[2]) : null;
  return { fraction, bytes: total === null ? null : Math.round(total * fraction), message: parts.join(" ") };
}

const SIZE_UNITS: Record<string, number> = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 };

/** yt-dlp's size ("1.57GiB", "114.74KiB") in bytes; null for anything else ("Unknown", "N/A"). */
function sizeBytes(s: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(B|KiB|MiB|GiB|TiB)$/.exec(s);
  return m ? Number(m[1]) * SIZE_UNITS[m[2]!]! : null;
}

/** A project with ranges on a server whose download route cannot fetch parts of a video (SOCKS-only YTDLP_PROXY). */
const NO_SECTION_ROUTE_MESSAGE =
  "Could not download: this server cannot fetch only parts of a video, so the ranges could not be downloaded. Clip the whole video instead, or upload the file (New project → Upload).";

/**
 * yt-dlp failures in plain words for every user. No env keys or ops advice here — those are
 * admin-only in the UI (`summarizeError({ admin: true })`). Datacentre IPs are often refused by
 * YouTube; misconfigured proxies surface as 407 / Tunnel connection failed.
 */
export function describeDownloadFailure(err: Error, stderr: string): string {
  const text = `${err.message}\n${stderr}`;
  if (/Tunnel connection failed|ProxyError|407\s*NO_USER|Unable to connect to proxy/i.test(text)) {
    return "Could not download: a network proxy blocked the connection. Try uploading the file instead (New project → Upload).";
  }
  if (BOT_CHECK.test(text) || FFMPEG_REFUSED.test(text) || /HTTP Error 403|confirm your age|This video is private|Video unavailable/i.test(text)) {
    const why = /private/i.test(text)
      ? "the video is private"
      : /unavailable/i.test(text)
        ? "the video is unavailable"
        : /age/i.test(text)
          ? "the video is age-restricted"
          : "the site blocked the download";
    return `Could not download: ${why}. Try uploading the file instead (New project → Upload).`;
  }
  if (isPageMissing(text)) {
    return "Could not download: the link no longer exists (the site answered page not found). Check the URL, or upload the file instead (New project → Upload).";
  }
  if (/Unsupported URL|No video formats|Requested format is not available/i.test(text)) {
    return "Could not download: no usable video was found for this link. Try another URL, or upload the file instead (New project → Upload).";
  }
  const last = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^ERROR/i.test(l))
    .at(-1);
  if (!last) return scrubStoredDownloadError(err.message.slice(0, 300));
  // Drop the "please report this on github" trailer — keep a short ERROR line without ops advice.
  const cleaned = last
    .replace(/^ERROR:\s*/i, "")
    .replace(/;?\s*please report this issue on https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
  return scrubStoredDownloadError(`Could not download: ${cleaned}`);
}

/** Stored project errors are visible to every owner; never persist env keys in them. */
function scrubStoredDownloadError(msg: string): string {
  return msg
    .replace(/\bYTDLP_\w+\b/g, "download settings")
    .replace(/\s{2,}/g, " ")
    .trim();
}
