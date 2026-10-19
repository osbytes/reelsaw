import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: SITE.name,
    short_name: SITE.name,
    description: SITE.description,
    start_url: "/",
    display: "browser",
    background_color: "#131314",
    theme_color: "#8460d2",
    icons: [{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }],
  };
}
