import type { Metadata } from "next";

/**
 * Open Graph + Twitter fields for a page. Images come from the nearest
 * `opengraph-image.tsx` (file convention); root `app/opengraph-image.tsx` is the fallback.
 */
export function socialMeta({
  title,
  description,
  url,
  type = "website",
}: {
  title: string;
  description: string;
  url: string;
  type?: "website" | "article";
}): Pick<Metadata, "openGraph" | "twitter"> {
  return {
    openGraph: { type, url, title, description },
    twitter: { card: "summary_large_image", title, description },
  };
}
