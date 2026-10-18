/**
 * "A newer Reelsaw is out": asks GitHub for the latest release of the repository and compares it
 * with the version baked into the image (REELSAW_VERSION). Admins see the answer under Settings →
 * System with the release notes link and the upgrade command; `reelsaw version` prints the same and
 * the `check_for_update` MCP tool returns it, all from this one state.
 *
 * Checked shortly after boot and every UPDATE_CHECK_HOURS, and on demand ("Check now", at most once
 * a minute). Only the request itself leaves the machine: no instance id, no usage, just a
 * `reelsaw/<version>` user agent. UPDATE_CHECK=false never contacts GitHub. GitHub's "latest"
 * release excludes pre-releases, so a beta install is told about the next final release only.
 * Running from source (version "dev") still shows the latest release but cannot say if it is newer.
 */
import semver from "semver";
import type { Config } from "./config.js";
import type { Logger } from "./log.js";

export const REPO_URL = "https://github.com/osbytes/reelsaw";
export const UPGRADE_DOCS_URL = `${REPO_URL}/blob/main/deploy/README.md#upgrade`;
/** "Check now" asks GitHub again only after this long (60 unauthenticated requests per hour per IP). */
export const MIN_CHECK_GAP_MS = 60_000;
const FIRST_CHECK_DELAY_MS = 10_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface UpdateState {
  /** UPDATE_CHECK (or the admin's runtime setting); when false nothing is fetched and `latest` stays null */
  enabled: boolean;
  /** REELSAW_VERSION: "0.5.0", or "dev" from source */
  current: string;
  /** the newest published release, once a check answered (kept when a later check fails) */
  latest: { version: string; url: string; publishedAt: string | null } | null;
  /** latest is newer than current; null until known, or when either is not a version (running from source) */
  available: boolean | null;
  checkedAt: string | null;
  /** a check is in flight (the UI shows "Checking…") */
  checking: boolean;
  /** why the last check gave no answer; null after a good one */
  error: string | null;
  /** how to move this install to `latest` */
  upgrade: { docsUrl: string; command: string; note: string };
}

export interface UpdateChecker {
  state(): UpdateState;
  /** Ask GitHub now; a check within the last minute is reused unless `force`. Resolves to the new state. */
  check(opts?: { force?: boolean }): Promise<UpdateState>;
  /** First check soon after boot, then every UPDATE_CHECK_HOURS. */
  start(): void;
  stop(): void;
}

/** "0.5.0" for a release build (a leading "v" is fine), null for "dev" or anything else. */
export function releaseVersion(v: string): string | null {
  return semver.valid(v.trim()) ?? null;
}

/** The upgrade step for this install, by how it runs. */
export function upgradeHowTo(current: string): UpdateState["upgrade"] {
  const source = releaseVersion(current) === null;
  return {
    docsUrl: UPGRADE_DOCS_URL,
    command: source ? "git pull && docker compose up -d --build" : "docker compose pull && docker compose up -d",
    note: source
      ? "Running from source: pull the repository and rebuild in the checkout."
      : "Run it in the install directory (~/reelsaw when the installer set it up). Data stays in the Docker volumes; the database migrates on boot.",
  };
}

type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function createUpdateChecker(
  config: Pick<Config, "REELSAW_VERSION" | "UPDATE_CHECK" | "UPDATE_CHECK_URL" | "UPDATE_CHECK_HOURS">,
  log: Logger,
  deps: { fetch?: FetchLike; now?: () => number; enabled?: () => boolean } = {},
): UpdateChecker {
  const doFetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const now = deps.now ?? Date.now;
  // UPDATE_CHECK, or the admin's runtime setting: read on every tick, so turning it off stops the next request
  const enabled = deps.enabled ?? (() => config.UPDATE_CHECK);
  const snapshot = (): UpdateState => ({ ...state, enabled: enabled() });
  const current = config.REELSAW_VERSION;
  const state: UpdateState = {
    enabled: config.UPDATE_CHECK,
    current,
    latest: null,
    available: null,
    checkedAt: null,
    checking: false,
    error: null,
    upgrade: upgradeHowTo(current),
  };
  let lastCheck = 0;
  let inflight: Promise<UpdateState> | null = null;
  let announced: string | null = null;
  let timer: NodeJS.Timeout | undefined;

  const fetchLatest = async () => {
    state.checking = true;
    try {
      const res = await doFetch(config.UPDATE_CHECK_URL, {
        headers: { accept: "application/vnd.github+json", "user-agent": `reelsaw/${current}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown };
      const tag = typeof body.tag_name === "string" ? body.tag_name : "";
      const version = releaseVersion(tag);
      if (!version) throw new Error(`unexpected release tag "${tag}"`);
      state.latest = { version, url: typeof body.html_url === "string" ? body.html_url : `${REPO_URL}/releases/tag/${tag}`, publishedAt: typeof body.published_at === "string" ? body.published_at : null };
      const running = releaseVersion(current);
      state.available = running ? semver.gt(version, running) : null;
      state.error = null;
      if (state.available && announced !== version) {
        announced = version;
        log.info({ current, latest: version, url: state.latest.url }, "a newer Reelsaw is available");
      } else log.debug({ current, latest: version, available: state.available }, "update check");
    } catch (err) {
      state.error = err instanceof Error ? (err.name === "TimeoutError" ? "GitHub did not answer in time" : err.message) : String(err);
      log.debug({ err, url: config.UPDATE_CHECK_URL }, "update check failed");
    } finally {
      state.checkedAt = new Date(now()).toISOString();
      state.checking = false;
      lastCheck = now();
    }
    return snapshot();
  };

  const check: UpdateChecker["check"] = async ({ force = false } = {}) => {
    if (!enabled()) return snapshot();
    if (inflight) return inflight;
    if (!force && state.checkedAt && now() - lastCheck < MIN_CHECK_GAP_MS) return snapshot();
    inflight = fetchLatest().finally(() => (inflight = null));
    return inflight;
  };

  return {
    state: snapshot,
    check,
    start() {
      if (timer) return;
      // the timer runs regardless; `check` itself does nothing while the setting is off
      const tick = () => void check({ force: true });
      timer = setTimeout(() => {
        tick();
        timer = setInterval(tick, config.UPDATE_CHECK_HOURS * 3600_000);
        timer.unref();
      }, FIRST_CHECK_DELAY_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearTimeout(timer), clearInterval(timer);
      timer = undefined;
    },
  };
}
