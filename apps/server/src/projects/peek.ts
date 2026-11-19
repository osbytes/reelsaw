import { LRUCache } from "lru-cache";
import { z } from "zod";
import type { MediaTools } from "../media.js";

const oembedSchema = z.object({ title: z.string().optional(), thumbnail_url: z.string().optional(), author_name: z.string().optional() });

/** Best-effort title + thumbnail for a URL before ingest runs (YouTube/Vimeo oEmbed, 4 s budget). */
export async function peekUrlMeta(url: string): Promise<{ title?: string | undefined; thumbnail?: string | undefined; uploader?: string | undefined }> {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return {};
  }
  const oembed = /(^|\.)(youtube\.com|youtu\.be)$/.test(host)
    ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`
    : /(^|\.)vimeo\.com$/.test(host)
      ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`
      : null;
  if (!oembed) return { title: host };
  try {
    const res = await fetch(oembed, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { title: host };
    const j = oembedSchema.safeParse(await res.json());
    if (!j.success) return { title: host };
    return { title: j.data.title, thumbnail: j.data.thumbnail_url, uploader: j.data.author_name };
  } catch {
    return { title: host };
  }
}

/**
 * What every surface says when a link is a stream with no finished video yet: live, scheduled, or just ended and still
 * being processed by the site (YouTube's `post_live`, which reports no length and downloads for hours).
 */
export const LIVE_SOURCE_MESSAGE =
  "This link is a live stream, one that has not started yet, or one that just ended and is still being processed, so there is no finished video to download. Add it again once its recording is up (a stream that just ended can take a few hours), or upload the file instead (New project → Upload).";

/**
 * Every `live_status` yt-dlp sets (its README, "OUTPUT TEMPLATE"), and whether a finished video is behind it. The lookup
 * and the download filter are both derived from this, so they cannot disagree. A link whose extractor leaves the field
 * unset (a direct .mp4 through the generic extractor) is a finished file, and so is a value yt-dlp adds later: refusing
 * one would refuse ordinary videos, and the download limits still cap whatever it turns out to be.
 *
 * `post_live` is a stream that ended but whose recording the site is still processing: no length to check limits
 * against, and a fragment-by-fragment download of the whole stream (a day-long one ran for hours before it was stopped).
 */
export const LIVE_STATUSES = {
  not_live: "finished",
  was_live: "finished",
  is_live: "unfinished",
  is_upcoming: "unfinished",
  post_live: "unfinished",
} as const satisfies Record<string, "finished" | "unfinished">;

const UNFINISHED = new Set(Object.entries(LIVE_STATUSES).flatMap(([status, kind]) => (kind === "unfinished" ? [status] : [])));

/** Whether an info dict's live fields say there is no finished video to download yet. */
export function isUnfinishedStream(info: { is_live?: boolean | null | undefined; live_status?: string | null | undefined }): boolean {
  return info.is_live === true || UNFINISHED.has(info.live_status ?? "");
}

/** The link is a live, scheduled or still-processing stream: refused before anything is downloaded, on every attempt alike. */
export class LiveSourceError extends Error {
  constructor() {
    super(LIVE_SOURCE_MESSAGE);
    this.name = "LiveSourceError";
  }
}

/**
 * yt-dlp `--match-filter` that skips the same links as `isUnfinishedStream`, for when the lookup could not tell, instead
 * of recording a stream until it ends. A skipped link exits 0 with no info line and no file, so the download step reads
 * that as this refusal.
 *
 * yt-dlp fails a comparison against a field the extractor left unset unless the operator ends in `?`, and many leave
 * `live_status` unset (a direct .mp4 link through the generic extractor), so every comparison here carries the `?`;
 * otherwise ordinary files are refused as live streams. test/live-filter.test.ts runs the real yt-dlp over every status.
 */
export const NOT_LIVE_FILTER = ["!is_live", ...[...UNFINISHED].filter((s) => s !== "is_live").map((s) => `live_status!=?${s}`)].join(" & ");

/**
 * The length yt-dlp reports for a link without downloading it, in seconds; null when it does not say (some sites).
 * Throws `LiveSourceError` for a live, scheduled or still-processing stream (no length, and a download that would run
 * until the stream ends, or through every fragment of it), and the lookup's own error when it fails. Used when a link
 * is checked (check_source, the New project form), when
 * the project is created (a refusal with the upgrade offer instead of a failed project) and again before ingest downloads;
 * the binding check still runs on the probed file.
 *
 * Those three ask about the same link within seconds of each other, and each lookup is a yt-dlp run of a few seconds
 * (through the download proxies, when set), so an answer is reused for `LENGTH_REUSE_MS`. A failed lookup is not kept:
 * the next caller tries again.
 */
export async function announcedDuration(media: Pick<MediaTools, "ytdlp">, url: string, signal?: AbortSignal): Promise<number | null> {
  const known = lengths.get(url) ?? (await lookUp(media, url, signal));
  if (known.live) throw new LiveSourceError();
  return known.sec;
}

async function lookUp(media: Pick<MediaTools, "ytdlp">, url: string, signal?: AbortSignal): Promise<Announced> {
  const { stdout } = await media.ytdlp(["--no-playlist", "--no-warnings", "--no-download", "--ignore-no-formats-error", "--dump-single-json", "--", url], {
    signal,
  });
  const jsonLine = stdout
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  const parsed = jsonLine ? announcedSchema.safeParse(JSON.parse(jsonLine)) : null;
  const info = parsed?.success ? parsed.data : {};
  const answer = { sec: info.duration ?? null, live: isUnfinishedStream(info) };
  lengths.set(url, answer);
  return answer;
}

/** The fields of a yt-dlp info dict the lookup reads; anything malformed counts as not said. */
const announcedSchema = z.object({
  duration: z.number().positive().nullish().catch(null),
  is_live: z.boolean().nullish().catch(null),
  live_status: z.string().nullish().catch(null),
});

interface Announced {
  sec: number | null;
  live: boolean;
}

/** How long a link's looked-up length is reused: long enough to span checking a link, creating it and ingest starting. */
const LENGTH_REUSE_MS = 10 * 60_000;
/** Each link's answer, boxed so a link that announces no length is kept too (`sec: null`); least recently used goes first. */
const lengths = new LRUCache<string, Announced>({ max: 500, ttl: LENGTH_REUSE_MS });

/** Drop every remembered length (tests). */
export function forgetAnnouncedDurations() {
  lengths.clear();
}
