import { loadReleasesFeed, type ReleasesFeed } from "./releases-data";

const TOKEN = process.env.GITHUB_TOKEN;

/** Cached GitHub releases + heatmap. ISR on the page revalidates hourly; a failure returns null. */
export async function githubReleases(): Promise<ReleasesFeed | null> {
  try {
    return await loadReleasesFeed({
      fetch: (url, init) => fetch(url, { headers: init.headers, signal: init.signal, next: { revalidate: 3600 } }),
      userAgent: "reelsaw-website",
      ...(TOKEN ? { token: TOKEN } : {}),
    });
  } catch {
    return null;
  }
}
