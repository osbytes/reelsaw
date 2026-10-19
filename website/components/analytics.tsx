"use client";

import posthog from "posthog-js";
import { useEffect } from "react";
import { POSTHOG_PROXY_PATH, posthogHosts } from "@/lib/posthog-hosts";

const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const hosts = posthogHosts(process.env.NEXT_PUBLIC_POSTHOG_HOST);

/**
 * Optional PostHog analytics. Renders nothing; does nothing unless NEXT_PUBLIC_POSTHOG_KEY is set.
 * Events go to this site's /ingest path, which next.config.ts reverse-proxies to PostHog.
 */
export function Analytics() {
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
