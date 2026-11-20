/**
 * The New project page and the link that opens it with a source already pasted. The web app's ⌘K, the
 * sign-up hand-off (`/signup?url=`, from the website's hero box) and anything else that starts a project
 * from a link build it here, so the page and its callers cannot drift apart on the route or the parameter.
 * The website (outside the pnpm workspace) mirrors `SOURCE_URL_PARAM` in `website/lib/site.ts`.
 */
export const NEW_PROJECT_PATH = "/new";
export const SOURCE_URL_PARAM = "url";

/** The longest link accepted from a query string: anything longer is not a video page someone pasted. */
const MAX_SOURCE_URL = 2048;

/**
 * A pasted link made usable, or null when it cannot be a web page: trimmed, `https://` added when the scheme
 * is missing ("youtube.com/watch?v=…"), only http(s), and a host with a dot in it.
 */
export function normalizeSourceUrl(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text || text.length > MAX_SOURCE_URL || /\s/.test(text)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** The New project page with `sourceUrl` in its link box. */
export function newProjectPath(sourceUrl: string): string {
  return `${NEW_PROJECT_PATH}?${SOURCE_URL_PARAM}=${encodeURIComponent(sourceUrl)}`;
}
