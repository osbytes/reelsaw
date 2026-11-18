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
 * The length yt-dlp reports for a link without downloading it, in seconds; null when it does not say (live streams, some
 * sites). Throws when the lookup itself fails. Used when a link is checked (check_source, the New project form), when the
 * project is created (a refusal with the upgrade offer instead of a failed project) and again before ingest downloads; the
 * binding check still runs on the probed file.
 *
 * Those three ask about the same link within seconds of each other, and each lookup is a yt-dlp run of a few seconds
 * (through the download proxies, when set), so an answer is reused for `LENGTH_REUSE_MS`. A failed lookup is not kept:
 * the next caller tries again.
 */
export async function announcedDuration(media: Pick<MediaTools, "ytdlp">, url: string, signal?: AbortSignal): Promise<number | null> {
  const known = lengths.get(url);
  if (known) return known.sec;
  const { stdout } = await media.ytdlp(["--no-playlist", "--no-warnings", "--no-download", "--ignore-no-formats-error", "--dump-single-json", "--", url], {
    signal,
  });
  const jsonLine = stdout
    .split("\n")
    .reverse()
    .find((l) => l.trim().startsWith("{"));
  const duration = jsonLine ? z.object({ duration: z.number().positive() }).safeParse(JSON.parse(jsonLine)) : null;
  const sec = duration?.success ? duration.data.duration : null;
  lengths.set(url, { sec });
  return sec;
}

/** How long a link's looked-up length is reused: long enough to span checking a link, creating it and ingest starting. */
const LENGTH_REUSE_MS = 10 * 60_000;
/** Each link's answer, boxed so a link that announces no length is kept too (`sec: null`); least recently used goes first. */
const lengths = new LRUCache<string, { sec: number | null }>({ max: 500, ttl: LENGTH_REUSE_MS });

/** Drop every remembered length (tests). */
export function forgetAnnouncedDurations() {
  lengths.clear();
}
