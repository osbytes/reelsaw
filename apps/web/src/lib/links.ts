/** Video-link helpers shared by New project and the ⌘K palette. */

export function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return u.pathname.slice(1) || null;
    if (host.endsWith("youtube.com")) return u.searchParams.get("v") ?? /^\/(?:shorts|live|embed)\/([\w-]+)/.exec(u.pathname)?.[1] ?? null;
  } catch {
    /* not a url yet */
  }
  return null;
}

export const isUrl = (s: string) => /^https?:\/\/\S+\.\S+/.test(s.trim());

/** Every http(s) link in some text (split on whitespace and newlines), without duplicates. */
export function extractUrls(text: string): string[] {
  return [...new Set(text.split(/\s+/).filter((t) => isUrl(t)))];
}

/** True when the text is nothing but links (one or several). */
export const isOnlyUrls = (text: string) => {
  const tokens = text.split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every(isUrl);
};

/** Identity of a link for "does a project already exist for this": the YouTube id, else the URL without tracking noise. */
export function linkKey(url: string): string {
  const yt = youtubeId(url);
  if (yt) return `yt:${yt}`;
  try {
    const u = new URL(url.trim());
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|si$)/i.test(k)) u.searchParams.delete(k);
    u.searchParams.sort();
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return url.trim();
  }
}
