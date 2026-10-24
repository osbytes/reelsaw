/**
 * Cached GitHub releases + 90-day commit heatmap (packages/shared/src/releases.ts). reelsaw.com/releases,
 * `list_releases` and `reelsaw releases` all read this. Fetched on demand, reused for an hour;
 * a later failure keeps the last good feed. Only the request leaves the machine.
 */
import { loadReleasesFeed, type ReleasesFeed } from "@reelsaw/shared";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";

export const FEED_TTL_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

export interface ReleaseFeedState {
  feed: ReleasesFeed | null;
  error: string | null;
  checking: boolean;
}

export interface ReleaseFeed {
  /** Last known feed and error; does not start a fetch. */
  state(): ReleaseFeedState;
  /** Cached feed if still fresh, else GitHub. Resolves to the new state. */
  get(opts?: { force?: boolean }): Promise<ReleaseFeedState>;
}

/** MCP / CLI shape: the changelog without the heatmap cells. */
export function listReleasesResult(state: ReleaseFeedState, input: { limit?: number; tag?: string } = {}) {
  const feed = state.feed;
  const limit = input.limit ?? 20;
  const needle = input.tag?.trim().replace(/^v/i, "").toLowerCase();
  if (!feed) return { releases: [] as const, total: 0, error: state.error ?? "GitHub has not answered yet", sourceUrl: "https://github.com/osbytes/reelsaw/releases" };
  const matched = needle
    ? feed.releases.filter((r) => r.version.toLowerCase() === needle || r.tag.replace(/^v/i, "").toLowerCase() === needle)
    : feed.releases;
  const releases = matched.slice(0, limit).map((r) => ({
    tag: r.tag,
    version: r.version,
    name: r.name,
    url: r.url,
    publishedAt: r.publishedAt,
    prerelease: r.prerelease,
    kinds: r.kinds,
    summary: r.summary,
    notes: r.notes,
  }));
  return {
    windowDays: feed.windowDays,
    since: feed.since,
    until: feed.until,
    commits: feed.commits,
    commitDays: feed.commitDays,
    releaseDays: feed.releaseDays,
    truncated: feed.truncated || releases.length < matched.length,
    total: matched.length,
    fetchedAt: feed.fetchedAt,
    sourceUrl: feed.sourceUrl,
    error: state.error,
    releases,
  };
}

type FetchLike = typeof fetch;

export function createReleaseFeed(
  config: Pick<Config, "REELSAW_VERSION">,
  log: Logger,
  deps: { fetch?: FetchLike; now?: () => number; token?: () => string | undefined } = {},
): ReleaseFeed {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const state: ReleaseFeedState = { feed: null, error: null, checking: false };
  let lastOk = 0;
  let inflight: Promise<ReleaseFeedState> | null = null;

  const snapshot = (): ReleaseFeedState => ({ ...state });

  const refresh = async (): Promise<ReleaseFeedState> => {
    state.checking = true;
    try {
      const token = deps.token?.();
      const feed = await loadReleasesFeed({
        fetch: (url, init) => doFetch(url, init),
        userAgent: `reelsaw/${config.REELSAW_VERSION}`,
        ...(token ? { token } : {}),
        now: new Date(now()),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      state.feed = feed;
      state.error = null;
      lastOk = now();
      log.debug(
        { releases: feed.releases.length, commits: feed.commits, truncated: feed.truncated },
        "release feed",
      );
    } catch (err) {
      state.error = err instanceof Error ? (err.name === "TimeoutError" ? "GitHub did not answer in time" : err.message) : String(err);
      log.debug({ err }, "release feed failed");
    } finally {
      state.checking = false;
    }
    return snapshot();
  };

  return {
    state: snapshot,
    get: async ({ force = false } = {}) => {
      if (inflight) return inflight;
      if (!force && state.feed && now() - lastOk < FEED_TTL_MS) return snapshot();
      inflight = refresh().finally(() => {
        inflight = null;
      });
      return inflight;
    },
  };
}
