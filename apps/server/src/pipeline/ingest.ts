import path from "node:path";
import fs from "node:fs/promises";
import { QuotaExceededError, hasMinuteLimits, recordSourceDuration, sourceMinutesExceeded } from "../quota.js";
import { takeTxLock, txLock } from "../locks.js";
import { eq, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import { keys } from "../storage/index.js";
import { QUEUES } from "../queue/boss.js";
import { UnresolvableHostError, UnsafeUrlError, assertPublicHttpUrl } from "../lib/safe-url.js";
import { announcedDuration } from "../projects/peek.js";
import { type StageContext, NonRetryableError, SourceUnavailableError, exists, sourceScratchMB } from "./common.js";
import { count, histogram, realtimeFactor } from "../metrics.js";
import { sha256File } from "./bumpers.js";
import { CommandError } from "../media.js";
import { isPageMissing, isPermanentDownloadFailure, largestReportedFile } from "../ytdlp-errors.js";

export { isPermanentDownloadFailure } from "../ytdlp-errors.js";

const UPLOAD_MISSING = "Uploaded source file is missing";

/** Scratch MB to copy the source onto this node, on top of MIN_FREE_DISK_MB. Known size (an upload, or a stored source) is the file plus a small probe margin; a link is unknown so we reserve 2 GB. */
export function ingestScratchMB(knownBytes?: number | null) {
  return sourceScratchMB(knownBytes);
}

export async function ingest(ctx: StageContext) {
  const { svc, projectId } = ctx;
  const project = await ctx.project();
  const dir = await ctx.dir();
  await ctx.start("ingesting");

  const stored = project.sourceKey && (await svc.storage.exists(project.sourceKey));
  const upload =
    !stored && project.sourceType === "upload"
      ? await ctx.db.query.uploads.findFirst({ where: eq(schema.uploads.id, String(project.sourceMeta?.uploadId ?? "")) })
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
      if (announced) {
        const over = await svc.tx(async (u) => {
          await takeTxLock(u.db, txLock.quota(project.userId));
          return sourceMinutesExceeded(u.db, svc.settings.get(), project.userId, projectId, announced, svc.entitlements);
        });
        if (over) {
          ctx.log.warn({ userId: project.userId, durationSec: announced, reason: over }, "source-minutes limit reached before download");
          throw new QuotaExceededError(over);
        }
      }
      let stderrTail = "";
      let info: Record<string, unknown> | undefined;
      let downloaded = 0; // fraction so far; video then audio are two downloads, so never let the bar go backwards
      const t0 = performance.now();
      const { stdout, proxyId } = await svc.media
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
            "bv*[vcodec^=avc1][height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b",
            "--merge-output-format",
            "mp4",
            "--max-filesize",
            `${svc.settings.get().MAX_SOURCE_FILE_MB}M`,
            "-o",
            path.join(dir, "source.%(ext)s"),
            "--",
            project.sourceUrl!,
          ],
          {
            signal: ctx.signal,
            onStderr: (line) => {
              stderrTail = (stderrTail + "\n" + line).slice(-4000);
            },
            onStdout: (line) => {
              const tick = parseDownloadTick(line);
              if (!tick) return;
              downloaded = Math.max(downloaded, tick.fraction);
              void ctx.progress(downloaded * 0.6, tick.message).catch(() => {});
            },
          },
        )
        .catch((err: Error) => {
          const message = describeDownloadFailure(err, stderrTail);
          // a dead or unsupported link answers the same on every attempt: fail the run now rather than retry it
          if (isPermanentDownloadFailure(`${err.message}\n${stderrTail}`)) throw new SourceUnavailableError(message);
          throw new Error(message);
        });
      download = { proxy: proxyId, sec: (performance.now() - t0) / 1000 };
      const jsonLine = stdout
        .split("\n")
        .reverse()
        .find((l) => l.trim().startsWith("{"));
      if (jsonLine) {
        info = JSON.parse(jsonLine) as Record<string, unknown>;
        meta = {
          ...meta,
          title: info.title,
          uploader: info.uploader ?? info.channel ?? meta.uploader,
          duration: info.duration,
          webpage_url: info.webpage_url,
          // the source fingerprint decisions point at (docs/specs/decision-log.md): videoId gets the video back, formatId says which encode
          extractor: info.extractor_key,
          videoId: info.id,
          formatId: info.format_id,
          thumbnail: meta.thumbnail ?? info.thumbnail,
          ext: info.ext,
          description: typeof info.description === "string" ? info.description.slice(0, 4000) : undefined,
          tags: Array.isArray(info.tags) ? info.tags.slice(0, 40) : undefined,
          chapters: Array.isArray(info.chapters)
            ? (info.chapters as Array<{ title?: string }>)
                .map((c) => c.title)
                .filter(Boolean)
                .slice(0, 40)
            : undefined,
        };
      }
      const files = (await fs.readdir(dir)).filter((f) => f.startsWith("source."));
      const chosen = files.find((f) => f.endsWith(".mp4")) ?? files[0];
      if (!chosen) {
        // --max-filesize makes yt-dlp skip an over-limit download and still exit 0; the same video is as big next time
        const limitMB = svc.settings.get().MAX_SOURCE_FILE_MB;
        const largest = info ? largestReportedFile(info) : null;
        if (largest !== null && largest > limitMB * 1024 * 1024) {
          throw new NonRetryableError(
            `Could not download: the video is larger than the ${limitMB} MB download limit (about ${Math.ceil(largest / 1024 / 1024)} MB). Try a shorter video, or upload the file instead (New project → Upload).`,
          );
        }
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
    sourceKey = keys.source(projectId, path.extname(sourcePath) || ".mp4");
    await ctx.progress(0.7, "Storing source");
    await svc.storage.putFile(sourceKey, sourcePath);
  }
  if (!sourcePath || !(await exists(sourcePath))) throw new Error("Source file missing after ingest");
  ctx.log.debug(
    {
      sourceType: project.sourceType,
      reusedStoredSource: !!project.sourceKey && sourceKey === project.sourceKey,
      ytdlp: project.sourceType === "url" ? { title: meta.title, uploader: meta.uploader, duration: meta.duration, ext: meta.ext } : undefined,
    },
    "source fetched",
  );

  await ctx.progress(0.9, "Probing media");
  const probe = await svc.media.ffprobe(sourcePath);
  if (!probe.hasAudio) throw new NonRetryableError("Source has no audio track; nothing to transcribe");
  const sourceBytes = (await fs.stat(sourcePath)).size;
  // the exact bytes the transcript's timestamps refer to; a stored source already hashed keeps its hash
  if (!(stored && typeof meta.sha256 === "string")) meta = { ...meta, sha256: await sha256File(sourcePath) };
  await ctx.release(); // the source is on disk, where free-space checks count it: the lease has done its job
  ctx.log.debug(
    {
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      hasAudio: probe.hasAudio,
      sourceBytes,
      sourceType: project.sourceType,
      sha256: meta.sha256,
      videoId: meta.videoId,
    },
    "source facts",
  );
  if (download) recordDownload(download.proxy, download.sec, probe.durationSec, sourceBytes);

  const generic = !project.title || project.title === "Untitled" || /^[\w.-]+\.[a-z]{2,}$/i.test(project.title); // "Untitled" or a bare hostname
  const title = generic ? ((meta.title as string | undefined) ?? project.title) : project.title;
  await ctx.complete({ sourceDurationSec: probe.durationSec, title }, async (u) => {
    // the binding minutes check: under the account's quota lock, in the unit that records this length, so two
    // ingests of one account cannot both pass a cap they jointly exceed (the create-side check is only advisory)
    await takeTxLock(u.db, txLock.quota(project.userId));
    const over = await sourceMinutesExceeded(u.db, svc.settings.get(), project.userId, projectId, probe.durationSec, svc.entitlements);
    if (over) {
      ctx.log.warn({ userId: project.userId, durationSec: probe.durationSec, reason: over }, "source-minutes limit reached");
      throw new QuotaExceededError(over);
    }
    await u.db
      .update(schema.projects)
      .set({
        sourceKey,
        sourceBytes,
        sourceExpiredAt: null,
        sourceMeta: meta,
        durationSec: probe.durationSec,
        width: probe.width ?? null,
        height: probe.height ?? null,
        title: sql`case when ${schema.projects.title} = ${project.title} then ${title} else ${schema.projects.title} end`,
        updatedAt: new Date(),
      })
      .where(eq(schema.projects.id, projectId));
    await recordSourceDuration(u.db, projectId, probe.durationSec);
    await u.enqueue(QUEUES.transcribe, { projectId });
  });
  void svc;
}

/**
 * `announcedDuration` for the stage, and why it is missing (the site did not say, or the lookup failed): only a
 * cancelled stage or a permanently dead link stops here.
 */
async function announcedDurationOrNull(ctx: StageContext, url: string): Promise<{ sec: number | null; missing: "unannounced" | "failed" | null }> {
  try {
    const sec = await announcedDuration(ctx.svc.media, url, ctx.signal);
    return { sec: sec || null, missing: sec ? null : "unannounced" };
  } catch (err) {
    ctx.signal.throwIfAborted();
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

/**
 * A yt-dlp `--newline` progress line ("[download]  12.3% of ~ 1.57GiB at 5.00MiB/s ETA 04:00") as a
 * fraction and a short message for the activity bar. Null for every other line.
 */
export function parseDownloadTick(line: string): { fraction: number; message: string } | null {
  const m = /^\[download\]\s+(\d+(?:\.\d+)?)%(?:\s+of\s+~?\s*(\S+))?(?:\s+at\s+(\S+))?/.exec(line);
  if (!m) return null;
  const pct = Number(m[1]);
  const parts = [`Downloading ${Math.floor(pct)}%`];
  if (m[2]) parts.push(`of ${m[2]}`);
  if (m[3] && m[3] !== "Unknown") parts.push(`at ${m[3]}`);
  return { fraction: Math.max(0, Math.min(1, Math.round(pct * 100) / 10_000)), message: parts.join(" ") };
}

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
  if (/sign in to confirm|not a bot|HTTP Error 403|confirm your age|This video is private|Video unavailable/i.test(text)) {
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
