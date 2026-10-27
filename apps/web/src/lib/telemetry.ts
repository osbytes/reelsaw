/**
 * Browser side of telemetry.ts on the server: Sentry for errors and PostHog for product events, each only when
 * `system.status.telemetry` carries its public key (set by SENTRY_DSN / POSTHOG_KEY on the server). The SDKs
 * are loaded on demand, so an instance without keys never requests the chunks. No autocapture: page views
 * and the handful of `track()` calls below are the whole event set; nothing from inputs or media.
 */
type Public = { sentry: { dsn: string; environment: string; release: string } | null; posthog: { key: string; host: string } | null };

type PH = typeof import("posthog-js").default;
type SB = typeof import("@sentry/browser");
let ph: PH | null = null;
let sb: SB | null = null;
let started: Promise<void> | null = null;
let lastPath = "";

export function initTelemetry(t: Public | null | undefined): Promise<void> {
  if (started || !t || (!t.sentry && !t.posthog)) return started ?? Promise.resolve();
  started = (async () => {
    if (t.sentry) {
      sb = await import("@sentry/browser");
      // tracesSampleRate stays 0. Browser traces are OpenTelemetry (lib/otel.ts, OTEL_TRACES_SAMPLE_RATE).
      // A non-zero rate here would send a second copy through the Sentry SDK.
      sb.init({ dsn: t.sentry.dsn, environment: t.sentry.environment, release: t.sentry.release, tracesSampleRate: 0 });
    }
    if (t.posthog) {
      ph = (await import("posthog-js")).default;
      ph.init(t.posthog.key, { api_host: t.posthog.host, capture_pageview: false, capture_pageleave: true, autocapture: false, disable_session_recording: true, persistence: "localStorage+cookie" });
      if (lastPath) ph.capture("$pageview", { $current_url: window.location.href });
    }
  })().catch((err) => console.warn("telemetry init failed", err));
  return started;
}

export function identify(user: { id: string; email: string; name: string; role: string; plan?: string | null } | null) {
  if (!user) {
    ph?.reset();
    sb?.setUser(null);
    return;
  }
  ph?.identify(user.id, { role: user.role, ...(user.plan ? { plan: user.plan } : {}) });
  sb?.setUser({ id: user.id });
}

export function pageview(path: string) {
  if (path === lastPath) return;
  lastPath = path;
  ph?.capture("$pageview", { $current_url: window.location.href, path });
}

/** A product event: a short snake_case name and ids/counts/names only. */
export function track(event: string, properties?: Record<string, string | number | boolean | null | undefined>) {
  ph?.capture(event, properties);
}

export function captureException(err: unknown, tags?: Record<string, string>) {
  sb?.captureException(err, { tags });
}

/**
 * User feedback from "Report an issue": Sentry gets the message (and optional name/email/tags);
 * PostHog gets a product event with ids/counts only (never the free-text description).
 * No-ops when the matching SDK was not initialised. Awaits Sentry so a send failure can surface.
 */
export async function sendIssueFeedback(opts: {
  message: string;
  name?: string;
  email?: string;
  tags?: Record<string, string>;
  /** PostHog-only properties: ids, counts, route — not the description */
  properties?: Record<string, string | number | boolean | null | undefined>;
}): Promise<{ sentry: boolean; posthog: boolean }> {
  await (started ?? Promise.resolve());
  let sentry = false;
  if (sb?.sendFeedback) {
    await sb.sendFeedback({
      message: opts.message,
      name: opts.name,
      email: opts.email,
      source: "report-dialog",
      tags: opts.tags,
    });
    sentry = true;
  } else if (sb?.captureFeedback) {
    sb.captureFeedback({
      message: opts.message,
      name: opts.name,
      email: opts.email,
      source: "report-dialog",
      tags: opts.tags,
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
