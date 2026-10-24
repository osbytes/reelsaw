"use client";

import { useEffect, type ReactNode } from "react";
import type { ReleasesFeed } from "@/lib/releases-data";
import { ReleaseArticle } from "./release-list";
import { ShippingChart } from "./shipping-chart";

function jump(tag: string) {
  const el = document.getElementById(tag);
  el?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
  if (el) window.history.replaceState(null, "", `#${tag}`);
}

export function ReleasesView({ feed, heading }: { feed: ReleasesFeed; heading: ReactNode }) {
  useEffect(() => {
    const tag = window.location.hash.replace(/^#/, "");
    if (tag) {
      const id = requestAnimationFrame(() => jump(tag));
      return () => cancelAnimationFrame(id);
    }
  }, []);
  return (
    <>
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between md:gap-6">
        {heading}
        <section aria-labelledby="activity-title" className="card w-fit max-w-full shrink-0 p-2.5 sm:p-3">
          <ShippingChart feed={feed} onSelectRelease={jump} />
        </section>
      </div>
      <section aria-label="Release notes" className="flex flex-col">
        {feed.releases.map((r) => (
          <ReleaseArticle key={r.tag} release={r} />
        ))}
      </section>
    </>
  );
}
