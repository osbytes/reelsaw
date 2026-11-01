/**
 * One reading of yt-dlp failures, shared by the proxy pool (try the next exit or stop) and ingest (fail the run or
 * retry it). yt-dlp prints why it gave up as its last `ERROR:` line. Retry notices and warnings name HTTP errors too
 * ("[download] Got error: HTTP Error 404 ... Retrying"), so only that fatal line can make a failure permanent.
 */

export type YtdlpErrorKind = "content" | "abort" | "proxy" | "other";

const ABORT = /\bAbortError\b|The operation was aborted|aborted by signal/i;
/** the link or the video itself, the same through every exit and on every attempt */
const GONE =
  /Unsupported URL|this video is private|private video|video has been removed|has been removed by the uploader|no longer available because|account associated with this video has been terminated/i;
/** the video rather than the path, but not for good (an age check, a region, a format): stop the walk, keep the run retryable */
const CONTENT = /video unavailable|confirm your age|age-restricted|file is larger than max-filesize|requested format is not available/i;
/**
 * The page (not the media) answered 404 / 410. A site can do that to one region only, so every exit is asked before the
 * run fails. A 404 on the media URL itself (signed, expiring, IP-bound) is not this and stays retryable.
 */
const PAGE_MISSING = /Unable to download (?:webpage|JSON metadata|API page)\b[^\n]*HTTP Error (?:404|410)\b/i;
const PROXY =
  /sign in to confirm|not a bot|HTTP Error 403|HTTP Error 429|unable to connect to proxy|\bproxy\b|\bsocks\b|connection (refused|reset|timed out)|timed out|timeout|network is unreachable|no route to host|temporary failure in name resolution|nodename nor servname|ssl|tls handshake/i;

/** yt-dlp's last `ERROR:` line, trimmed; undefined when there is none (it was killed, or this is not yt-dlp output). */
export function fatalYtdlpLine(text: string): string | undefined {
  return text
    .split(/\r?
/)
    .map((l) => l.trim())
    .filter((l) => /^ERROR:/i.test(l))
    .at(-1);
}

/**
 * content = the video, not the path (private / removed / unsupported / too big): do not try another proxy and do not
 * open this one's circuit. abort = the job was cancelled. proxy = the path failed (bot check, 403, connection): trip
 * the breaker and try the next. other = try the next without a reliability hit (a page 404 lands here, so every exit
 * is asked).
 */
export function classifyYtdlpError(text: string): YtdlpErrorKind {
  if (ABORT.test(text)) return "abort";
  const fatal = fatalYtdlpLine(text) ?? text;
  if (GONE.test(fatal) || CONTENT.test(fatal)) return "content";
  if (PAGE_MISSING.test(fatal)) return "other";
  if (PROXY.test(text)) return "proxy";
  return "other";
}

/** The fatal line says the page itself is gone (404 / 410), as opposed to the media URL behind it. */
export function isPageMissing(text: string): boolean {
  const fatal = fatalYtdlpLine(text);
  return !!fatal && PAGE_MISSING.test(fatal);
}

/**
 * A failure another attempt cannot change: the page is gone, the URL is not a supported video, the video is private or
 * removed. Region and age blocks, bot checks, rate limits, server errors and an expired media URL stay retryable.
 */
export function isPermanentDownloadFailure(text: string): boolean {
  const fatal = fatalYtdlpLine(text);
  return !!fatal && (GONE.test(fatal) || PAGE_MISSING.test(fatal));
}

/** The largest size yt-dlp's info JSON reports for the download or any of its parts, in bytes; null when it says none. */
export function largestReportedFile(info: Record<string, unknown>): number | null {
  const sizes: number[] = [];
  const take = (o: unknown) => {
    if (!o || typeof o !== "object") return;
    for (const k of ["filesize", "filesize_approx"]) {
      const v = (o as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v) && v > 0) sizes.push(v);
    }
  };
  take(info);
  if (Array.isArray(info.requested_formats)) info.requested_formats.forEach(take);
  return sizes.length ? Math.max(...sizes) : null;
}
