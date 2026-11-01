/**
 * Browser side of telemetry.ts on the server: Sentry for errors and PostHog for product events, each only when
 * `system.status.telemetry` carries its public key (set by SENTRY_DSN / POSTHOG_KEY on the server). The SDKs
 * are loaded on demand, so an instance without keys never requests the chunks. No autocapture: page views
 * and the handful of `track()` calls below are the whole event set; nothing from inputs or media.
 * Calls made before the SDKs finish loading (the first identify, a sign-in event) wait for them instead of
 * being dropped.
 */
type Public = {
  sentry: { dsn: string; environment: string; release: string; replaysOnErrorSampleRate?: number } | null;
  posthog: { key: string; host: string } | null;
};

type PH = typeof import("posthog-js").default;
type SB = typeof import("@sentry/browser");
let ph: PH | null = null;
let sb: SB | null = null;
let started: Promise<void> | null = null;
let ready = false;
let lastPath = "";
/**
 * The UTM tags of the URL the app was opened with (the website's links carry them), read when this module loads,
 * before the router can redirect "/" to "/login" and drop the query. Registered once as event properties at init.
 */
const landingUtm: Record<string, string> = (() => {
  try {
    const q = new URLSearchParams(window.location.search);
    const out: Record<string, string> = {};
    for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content"]) {
      const v = q.get(k);
      if (v) out[k] = v.slice(0, 100);
    }
    return out;
  } catch {
    return {};
  }
})();
/** calls made before init finished, run in order once it has (bounded: an instance without keys never inits) */
const pending: Array<() => void> = [];

function whenReady(fn: () => void) {
  if (ready) fn();
  else if (pending.length < 50) pending.push(fn);
}

/**
 * A refusal the app already shows the person (a quota, a validation error, a missing project): a tRPC error with a
 * 4xx status. Not a fault, so it stays out of Sentry even when a caller forgot to handle the rejection.
 */
export function isExpectedClientError(err: unknown): boolean {
  if (!err || typeof err !== "object" || (err as { name?: unknown }).name !== "TRPCClientError") return false;
  const status = (err as { data?: { httpStatus?: unknown } }).data?.httpStatus;
  return typeof status === "number" && status >= 400 && status < 500;
}

export function initTelemetry(t: Public | null | undefined): Promise<void> {
  if (started || !t || (!t.sentry && !t.posthog)) return started ?? Promise.resolve();
  started = (async () => {
    if (t.sentry) {
      sb = await import("@sentry/browser");
      const replays = t.sentry.replaysOnErrorSampleRate ?? 0;
      // tracesSampleRate stays 0. Browser traces are OpenTelemetry (lib/otel.ts, OTEL_TRACES_SAMPLE_RATE).
      // A non-zero rate here would send a second copy through the Sentry SDK.
      sb.init({
        dsn: t.sentry.dsn,
        environment: t.sentry.environment,
        release: t.sentry.release,
        tracesSampleRate: 0,
        // the user id is set by identify(); nothing inferred (the IP address) is ours to keep
        dataCollection: { userInfo: false },
        beforeSend: (event, hint) => (isExpectedClientError(hint.originalException) ? null : event),
        // replay only around an error, every word and image masked (SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE, default off)
        ...(replays > 0
          ? {
              replaysSessionSampleRate: 0,
              replaysOnErrorSampleRate: replays,
              integrations: [sb.replayIntegration({ maskAllText: true, maskAllInputs: true, blockAllMedia: true })],
            }
          : {}),
      });
    }
    if (t.posthog) {
      ph = (await import("posthog-js")).default;
      ph.init(t.posthog.key, {
        api_host: t.posthog.host,
        capture_pageview: false,
        capture_pageleave: true,
        autocapture: false,
        disable_session_recording: true,
        persistence: "localStorage+cookie",
      });
      // first touch wins: a later visit without tags does not overwrite where this browser first came from
      if (Object.keys(landingUtm).length) ph.register_once(landingUtm);
      if (lastPath) ph.capture("$pageview", { $current_url: window.location.href });
    }
  })()
    .catch((err) => console.warn("telemetry init failed", err))
    .finally(() => {
      ready = true;
      for (const fn of pending.splice(0)) fn();
    });
  return started;
}

export function identify(user: { id: string; role: string } | null) {
  whenReady(() => {
    if (!user) {
      ph?.reset();
      sb?.setUser(null);
      return;
    }
    // id and role only; the plan is set server-side when it changes (billing)
    ph?.identify(user.id, { role: user.role });
    sb?.setUser({ id: user.id });
  });
}

export function pageview(path: string) {
  if (path === lastPath) return;
  lastPath = path;
  ph?.capture("$pageview", { $current_url: window.location.href, path });
}

/** A product event: a short snake_case name and ids/counts/names only. */
export function track(event: string, properties?: Record<string, string | number | boolean | null | undefined>) {
  whenReady(() => ph?.capture(event, properties));
}

export function captureException(err: unknown, tags?: Record<string, string>) {
  sb?.captureException(err, tags ? { tags } : undefined);
}

/**
 * User feedback from "Report an issue": Sentry gets the message (and optional name/email/tags);
 * PostHog gets a product event with ids/counts only (never the free-text description).
 * No-ops when the matching SDK was not initialised. Awaits Sentry so a send failure can surface.
 */
export async function sendIssueFeedback(opts: {
  message: string;
  name?: string | undefined;
  email?: string | undefined;
  tags?: Record<string, string>;
  /** PostHog-only properties: ids, counts, route — not the description */
  properties?: Record<string, string | number | boolean | null | undefined>;
}): Promise<{ sentry: boolean; posthog: boolean }> {
  await (started ?? Promise.resolve());
  let sentry = false;
  if (sb?.sendFeedback) {
    await sb.sendFeedback({
      message: opts.message,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.email ? { email: opts.email } : {}),
      source: "report-dialog",
      ...(opts.tags ? { tags: opts.tags } : {}),
    });
    sentry = true;
  } else if (sb?.captureFeedback) {
    sb.captureFeedback({
      message: opts.message,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.email ? { email: opts.email } : {}),
      source: "report-dialog",
      ...(opts.tags ? { tags: opts.tags } : {}),
    });
    sentry = true;
  }
  if (ph) {
    // description stays in Sentry when that channel is on; PostHog-only instances still need the text
    ph.capture("issue_reported", {
      ...opts.properties,
      ...(sentry ? {} : { description: opts.message.slice(0, 2000) }),
    });
  }
  return { sentry, posthog: !!ph };
}
