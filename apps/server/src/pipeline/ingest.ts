import path from "node:path";
import fs from "node:fs/promises";
import { recordSourceDuration, sourceMinutesExceeded } from "../quota.js";
import { takeTxLock, txLock } from "../locks.js";
import { eq, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import { keys } from "../storage/index.js";
import { QUEUES } from "../queue/boss.js";
import { assertPublicHttpUrl } from "../lib/safe-url.js";
import { StageContext, exists, sourceScratchMB } from "./common.js";
import { histogram, realtimeFactor } from "../metrics.js";

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
  const upload = !stored && project.sourceType === "upload" ? await ctx.db.query.uploads.findFirst({ where: eq(schema.uploads.id, String(project.sourceMeta?.uploadId ?? "")) }) : undefined;
  if (!stored && project.sourceType === "upload" && !upload) throw new Error("Uploaded source file is missing");
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
      await assertPublicHttpUrl(project.sourceUrl ?? "", { allowPrivate: svc.settings.get().ALLOW_PRIVATE_SOURCE_URLS });
      let stderrTail = "";
      let downloaded = 0; // fraction so far; video then audio are two downloads, so never let the bar go backwards
      const t0 = performance.now();
      const { stdout, proxyId } = await svc.media.ytdlp(
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
      ).catch((err: Error) => {
        throw new Error(describeDownloadFailure(err, stderrTail));
      });
      download = { proxy: proxyId, sec: (performance.now() - t0) / 1000 };
      const jsonLine = stdout.split("\n").reverse().find((l) => l.trim().startsWith("{"));
      if (jsonLine) {
        const info = JSON.parse(jsonLine) as Record<string, unknown>;
        meta = {
          ...meta,
          title: info.title,
          uploader: info.uploader ?? info.channel ?? meta.uploader,
          duration: info.duration,
          webpage_url: info.webpage_url,
          thumbnail: meta.thumbnail ?? info.thumbnail,
          ext: info.ext,
          description: typeof info.description === "string" ? info.description.slice(0, 4000) : undefined,
          tags: Array.isArray(info.tags) ? info.tags.slice(0, 40) : undefined,
          chapters: Array.isArray(info.chapters) ? (info.chapters as Array<{ title?: string }>).map((c) => c.title).filter(Boolean).slice(0, 40) : undefined,
        };
      }
      const files = (await fs.readdir(dir)).filter((f) => f.startsWith("source."));
      const chosen = files.find((f) => f.endsWith(".mp4")) ?? files[0];
      if (!chosen) throw new Error("yt-dlp finished but no source file was produced");
      sourcePath = path.join(dir, chosen);
    } else {
      if (!upload) throw new Error("Uploaded source file is missing");
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
  ctx.log.debug({ sourceType: project.sourceType, reusedStoredSource: !!project.sourceKey && sourceKey === project.sourceKey, ytdlp: project.sourceType === "url" ? { title: meta.title, uploader: meta.uploader, duration: meta.duration, ext: meta.ext } : undefined }, "source fetched");

  await ctx.progress(0.9, "Probing media");
  const probe = await svc.media.ffprobe(sourcePath);
  if (!probe.hasAudio) throw new Error("Source has no audio track; nothing to transcribe");
  const sourceBytes = (await fs.stat(sourcePath)).size;
  await ctx.release(); // the source is on disk, where free-space checks count it: the lease has done its job
  ctx.log.debug({ width: probe.width, height: probe.height, fps: probe.fps, hasAudio: probe.hasAudio, sourceBytes, sourceType: project.sourceType }, "source facts");
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
      throw new Error(over);
    }
    await u.db
      .update(schema.projects)
      .set({ sourceKey, sourceBytes, sourceExpiredAt: null, sourceMeta: meta, durationSec: probe.durationSec, width: probe.width ?? null, height: probe.height ?? null, title: sql`case when ${schema.projects.title} = ${project.title} then ${title} else ${schema.projects.title} end`, updatedAt: new Date() })
      .where(eq(schema.projects.id, projectId));
    await recordSourceDuration(u.db, projectId, probe.durationSec);
    await u.enqueue(QUEUES.transcribe, { projectId });
  });
  void svc;
}

/**
 * Proxy performance normalised by the video: a 2-hour talk takes longer than a 30-second clip through
 * any exit, so compare download seconds per second of video, and bytes per second, by proxy.
 */
export function recordDownload(proxy: string, sec: number, videoSec: number, bytes: number) {
  const rtf = realtimeFactor(sec, videoSec);
  if (rtf !== null) histogram("reelsaw.ytdlp.download.realtime_factor", rtf, "1", { proxy }, "Download wall seconds per second of video, by the proxy that served it");
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
    const why = /private/i.test(text) ? "the video is private" : /unavailable/i.test(text) ? "the video is unavailable" : /age/i.test(text) ? "the video is age-restricted" : "the site blocked the download";
    return `Could not download: ${why}. Try uploading the file instead (New project → Upload).`;
  }
  if (/Unsupported URL|No video formats|Requested format is not available/i.test(text)) {
    return "Could not download: no usable video was found for this link. Try another URL, or upload the file instead (New project → Upload).";
  }
  const last = stderr.split("\n").map((l) => l.trim()).filter((l) => /^ERROR/i.test(l)).at(-1);
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
