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

/** What every surface says when a link is a live or scheduled stream: there is no end to download up to. */
export const LIVE_SOURCE_MESSAGE =
  "This link is a live stream (or one that has not started yet), which never finishes downloading. Add it again once the stream has ended and its recording is up, or upload the file instead (New project → Upload).";

/** The link is a live or scheduled stream: refused before anything is downloaded, on every attempt alike. */
export class LiveSourceError extends Error {
  constructor() {
    super(LIVE_SOURCE_MESSAGE);
    this.name = "LiveSourceError";
  }
}

/**
 * yt-dlp `--match-filter` that skips a live or scheduled stream instead of recording it until the stream ends. A skipped
 * link exits 0 with no info line and no file, so the download step reads that as this refusal.
 */
export const NOT_LIVE_FILTER = "!is_live & live_status!=is_upcoming";

/**
 * The length yt-dlp reports for a link without downloading it, in seconds; null when it does not say (some sites).
 * Throws `LiveSourceError` for a live or scheduled stream (no length, and a download that would run until the stream
 * ends), and the lookup's own error when it fails. Used when a link is checked (check_source, the New project form), when
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
  const answer = { sec: info.duration ?? null, live: info.is_live === true || info.live_status === "is_live" || info.live_status === "is_upcoming" };
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
