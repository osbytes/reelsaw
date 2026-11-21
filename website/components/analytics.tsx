"use client";

import posthog from "posthog-js";
import { useEffect } from "react";
import { captureFirstTouch, decorateAppUrl } from "@/lib/attribution";
import { POSTHOG_PROXY_PATH, posthogHosts } from "@/lib/posthog-hosts";

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const hosts = posthogHosts(process.env.NEXT_PUBLIC_POSTHOG_HOST);

/** This site's analytics id, when PostHog is on and loaded (it goes into links to the app as `site_id`). */
export function siteDistinctId(): string | null {
  return key && posthog.__loaded ? posthog.get_distinct_id() : null;
}

/**
 * Optional PostHog analytics. Renders nothing; does nothing unless NEXT_PUBLIC_POSTHOG_KEY is set.
 * Events go to this site's /ingest path, which next.config.ts reverse-proxies to PostHog.
 * Also, with or without analytics: the visit's first touch is kept, and every link into the app carries it
 * (lib/attribution.ts), added when the link is followed so static pages need no per-visitor HTML.
 */
export function Analytics() {
  useEffect(() => {
    captureFirstTouch();
    // capture phase, before the browser follows the link: rewrite its href in place (middle-click and ⌘-click too)
    const tag = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
      if (a instanceof HTMLAnchorElement) a.href = decorateAppUrl(a.href, siteDistinctId());
    };
    document.addEventListener("click", tag, true);
    document.addEventListener("auxclick", tag, true);
    return () => {
      document.removeEventListener("click", tag, true);
      document.removeEventListener("auxclick", tag, true);
    };
  }, []);
  useEffect(() => {
    if (!key || posthog.__loaded) return;
    posthog.init(key, {
      api_host: POSTHOG_PROXY_PATH,
      ui_host: hosts.ui,
      defaults: "2025-05-24",
      capture_pageview: "history_change",
      capture_pageleave: true,
      capture_exceptions: true,
      person_profiles: "identified_only",
      respect_dnt: true,
    });
  }, []);
  return null;
}

export { posthog };
