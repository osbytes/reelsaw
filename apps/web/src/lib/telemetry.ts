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
  /** host: a path on this origin when the server proxies PostHog (POSTHOG_PROXY), else PostHog's own host */
  posthog: { key: string; host: string; uiHost?: string } | null;
};

import { ATTRIBUTION_HEADER, type Attribution, attributionFromSearch, attributionSchema, encodeAttributionHeader } from "@reelsaw/shared";

type PH = typeof import("posthog-js").default;
type SB = typeof import("@sentry/browser");
let ph: PH | null = null;
let sb: SB | null = null;
let started: Promise<void> | null = null;
let ready = false;
let lastPath = "";
/** Where the first touch is kept between visits (the sign-up often happens on a later page load than the landing). */
const FIRST_TOUCH_KEY = "reelsaw.firstTouch";

/**
 * First-touch attribution (@reelsaw/shared attribution.ts): the UTM tags and the website's site_* tags of the URL the
 * app was first opened with, read when this module loads, before the router can redirect "/" to "/login" and drop the
 * query. Kept in localStorage (first touch wins: a later visit without tags, or with others, does not replace it),
 * registered once as event properties at init, and sent with the sign-up (`attributionHeaders`).
 */
const landingUtm: Attribution = (() => {
  try {
    const stored = attributionSchema.safeParse(JSON.parse(localStorage.getItem(FIRST_TOUCH_KEY) ?? "null"));
    if (stored.success && Object.keys(stored.data).length) return stored.data;
  } catch {
    // storage blocked or the value is not ours: read the URL instead
  }
  try {
    const now = attributionFromSearch(window.location.search) ?? {};
    if (Object.keys(now).length) localStorage.setItem(FIRST_TOUCH_KEY, JSON.stringify(now));
    return now;
  } catch {
    return {};
  }
})();

/** Headers for the sign-up request: the first touch, so the server's `user.signed_up` carries where the account came from. */
export function attributionHeaders(): Record<string, string> {
  return Object.keys(landingUtm).length ? { [ATTRIBUTION_HEADER]: encodeAttributionHeader(landingUtm) } : {};
}
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

/**
 * React failing to remove or insert a node that something else moved: the browser's page translation (Chrome, Edge)
 * swaps text nodes for its own `<font>` wrappers, so React's next commit finds a stranger where its node was. The
 * page needs a reload; there is nothing of ours to fix, and translation stays on for the people who use it.
 */
export function isForeignDomMutation(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "NotFoundError") return false;
  return /Failed to execute '(removeChild|insertBefore)' on 'Node'/.test(err.message);
}

/**
 * Scripts a browser extension injects into the page (wallets, password managers, ad blockers). An error thrown from
 * one of them reaches the page's global handler like ours do, but there is nothing of ours to fix.
 */
export const EXTENSION_SCRIPT_URLS = [/^(chrome|moz|safari(-web)?|ms-browser)-extension:\/\//i];

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
        // nor the request's headers, cookies, bodies or query strings (the SDK's defaults collect them)
        dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
        // an error whose throwing frame is an extension's script, not the app's
        denyUrls: EXTENSION_SCRIPT_URLS,
        beforeSend: (event, hint) => (isExpectedClientError(hint.originalException) || isForeignDomMutation(hint.originalException) ? null : event),
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
      // the website's analytics id (its links carry it) becomes this browser's id when the app has none of its own yet:
      // with the site and the app on one PostHog project the visit and the sign-up are one person; on two, the same id
      // in both still joins them
      const fresh = !hasPosthogIdentity(t.posthog.key);
      ph.init(t.posthog.key, {
        ...(fresh && landingUtm.site_id ? { bootstrap: { distinctID: landingUtm.site_id } } : {}),
        api_host: t.posthog.host,
        ...(t.posthog.uiHost ? { ui_host: t.posthog.uiHost } : {}),
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

/** posthog-js already has an id stored for this key in this browser (its cookie or localStorage entry). */
function hasPosthogIdentity(key: string): boolean {
  const name = `ph_${key}_posthog`;
  try {
    if (localStorage.getItem(name)) return true;
  } catch {
    // storage blocked: fall through to the cookie
  }
  return document.cookie.split("; ").some((c) => c.startsWith(`${name}=`));
}

/**
 * A sign-up that must confirm its email first has no session here, but this browser is the one that came from the
 * website: name it as the new account now, so the visit (its UTM tags, the site's id) joins the account even when the
 * confirm link opens in another browser. The signed-out pages that follow do not reset it (see `identify(null)`).
 */
let signedUpAs: string | null = null;
export function identifySignup(userId: string) {
  signedUpAs = userId;
  whenReady(() => ph?.identify(userId, { role: "user" }));
}

export function identify(user: { id: string; role: string } | null) {
  whenReady(() => {
    // the account this browser just created, before its first sign-in: keep the identity that joins the visit to it
    if (!user && signedUpAs) return;
    if (user) {
      // another account signing in here than the one just created: a fresh identity, not a merge of the two
      if (signedUpAs && signedUpAs !== user.id) ph?.reset();
      signedUpAs = null;
    }
    if (!user) {
      // Only a browser that was signed in as someone gets a fresh identity. Every signed-out page load lands here too,
      // and resetting an anonymous visitor would drop the landing UTM tags registered at init and start a new
      // anonymous id, so the sign-up that follows would never join the visit that came from the website.
      if (ph?.get_property("$user_state") === "identified") {
        ph.reset();
        if (Object.keys(landingUtm).length) ph.register_once(landingUtm);
      }
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
