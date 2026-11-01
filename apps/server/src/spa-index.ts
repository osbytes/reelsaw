import path from "node:path";

/**
 * History fallback for the Vite build. Client routes have no file extension (`/signup`).
 * Missing `/favicon.ico` (and other assets) must 404, not return index.html: crawlers request
 * it by convention, and serving the shell there is why app.reelsaw.com showed a generic globe
 * in Google Search.
 */
export function isSpaIndexPath(urlPath: string): boolean {
  // /.well-known/* is machine-read (OAuth discovery when MCP_OAUTH is on): a 404 when nothing serves it, never the page
  if (urlPath.startsWith("/api/") || urlPath.startsWith("/media/") || urlPath.startsWith("/.well-known/")) return false;
  return path.posix.extname(urlPath) === "";
}
