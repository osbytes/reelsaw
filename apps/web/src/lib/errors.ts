import { t } from "@lingui/core/macro";

/**
 * Turn a stored pipeline error into a short sentence for the UI. Admins may see operator hints
 * (env keys, server config); everyone else gets a user-facing line with no platform details.
 * Raw text stays in `detail` for admins only when it adds anything the summary drops
 * (PRINCIPLES: plain language, detail one click away).
 */
export function summarizeError(raw: string, opts: { admin?: boolean | undefined } = {}): { summary: string; detail: string | null } {
  const admin = !!opts.admin;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return { summary: t`Something went wrong.`, detail: null };

  const match = (re: RegExp) => re.test(text);
  // User copy first; admin may get a second line with env / ops hints.
  let user: string | null = null;
  let hint: string | null = null;
  if (match(/Tunnel connection failed|ProxyError|407\s*NO_USER|(?:proxy|PROXY).*(?:fail|refus|auth|error)|Unable to connect to proxy|the proxy rejected/i)) {
    user = t`Couldn't download this video — a network proxy blocked the connection. Try uploading the file instead.`;
    hint = t`Check YTDLP_PROXY on the server.`;
  } else if (match(/sign in to confirm|not a bot|HTTP Error 403|refused the download from this server \(bot check\)/i)) {
    user = t`Couldn't download this video — the site blocked the download. Try uploading the file instead.`;
    hint = t`Set YTDLP_PROXY or YTDLP_COOKIES_FILE on the server.`;
  } else if (match(/This video is private|video is private/i)) {
    user = t`Couldn't download — the video is private.`;
  } else if (match(/confirm your age|age.restricted|age.gate|age-restricted/i)) {
    user = t`Couldn't download — the video is age-restricted. Try uploading the file instead.`;
    hint = t`Set YTDLP_COOKIES_FILE on the server if you need age-restricted links.`;
  } else if (match(/Video unavailable|video is unavailable/i)) {
    user = t`Couldn't download — the video is unavailable.`;
  } else if (match(/Unsupported URL|No video formats|Requested format is not available|no usable video format/i)) {
    user = t`Couldn't download — no usable video was found for this link. Try another URL, or upload the file.`;
  } else if (match(/ENOSPC|No space left|ran out of disk space/i)) {
    user = t`This project couldn't finish because the server ran out of disk space.`;
    hint = t`Free space on the host, or raise the volume size.`;
  } else if (match(/ENOMEM|out of memory|Cannot allocate memory|ran out of memory/i)) {
    user = t`This project couldn't finish because the server ran out of memory.`;
    hint = t`Lower concurrency or give the worker more RAM.`;
  } else if (match(/^[A-Z][\w ]* timed out: .*Retry continues where it stopped/)) {
    // the stage timeout message is already a plain sentence with the progress and the way out (pipeline/steps.ts)
    user = text;
  } else if (match(/^Could not download:/i) || match(/^Couldn’t /) || match(/^Couldn't /)) {
    // Already plain; strip any env-key / ops advice that may have been stored for older failures.
    user = scrubPlatform(text);
    if (user.length > 180) user = `${user.slice(0, 177)}…`;
    if (admin && /YTDLP_|COOKIES_FILE|on the server/i.test(text) && scrubPlatform(text) !== text) {
      hint = platformHints(text);
    }
  } else if (match(/^Download failed:/i) || match(/\[youtube\]|yt-dlp|Unable to download/i)) {
    user = t`Couldn't download this video. Try uploading the file instead, or check that the link still works.`;
    hint = t`Inspect yt-dlp on the server (YTDLP_PROXY / YTDLP_COOKIES_FILE).`;
  }

  if (user) {
    const summary = admin && hint ? `${user} ${hint}` : user;
    const detail = admin && text !== summary && looksTechnical(text) ? text : null;
    return { summary, detail };
  }

  const cleaned = scrubPlatform(
    text
      .replace(/;?\s*please report this issue on https?:\/\/\S+/gi, "")
      .replace(/\(caused by [^)]*\)/gi, "")
      .replace(/<urlopen error [^>]*>/gi, "")
      .replace(/\[(?:youtube|info|download|merger)\]\s+\S+:\s*/gi, "")
      .replace(/^ERROR:\s*/i, "")
      .replace(/^Download failed:\s*/i, "")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const short = cleaned.length > 140 ? `${cleaned.slice(0, 137)}…` : cleaned || t`Something went wrong.`;
  return { summary: short, detail: admin && short !== text && looksTechnical(text) ? text : null };
}

/** Drop env keys and “on the server” ops advice so a stored admin-era message stays safe for users. */
function scrubPlatform(s: string): string {
  return s
    .replace(/\s*Check YTDLP_\w+(?:\s*\/\s*YTDLP_\w+)? on the server\.?/gi, "")
    .replace(/\s*Set YTDLP_\w+(?:\s*\/\s*YTDLP_\w+)? on the server[^.]*\.?/gi, "")
    .replace(/\s*,?\s*or set YTDLP_\w+(?:\s*\/\s*YTDLP_\w+)? on the server\.?/gi, "")
    .replace(/\bYTDLP_\w+\b/g, t`server download settings`)
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\./g, ".")
    .trim();
}

function platformHints(s: string): string | null {
  const keys = [...s.matchAll(/\bYTDLP_\w+\b/g)].map((m) => m[0]!);
  if (!keys.length) return null;
  const names = [...new Set(keys)].join(" / ");
  return t`Check ${names} on the server.`;
}

function looksTechnical(s: string): boolean {
  return /\[youtube\]|urlopen|ProxyError|Traceback|yt-dlp|ERROR:|HTTP Error|\bYTDLP_/i.test(s) || s.length > 160;
}
