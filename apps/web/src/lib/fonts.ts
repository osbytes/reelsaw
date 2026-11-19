import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { TEXT_FONTS } from "@reelsaw/shared";
import { useTRPC } from "./trpc";

/**
 * The fonts captions, hooks and text layers can use (server: fonts.ts): the image's and the ones an admin uploaded,
 * each loaded from the server (`/api/fonts/:family`, the same files libass draws with) once per page so the editor
 * preview shows the real face. A font the server cannot serve fails quietly: the preview falls back to DejaVu Sans,
 * like the render.
 */
const loaded = new Set<string>();
function loadFonts(families: readonly string[]) {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  for (const family of families) {
    if (loaded.has(family)) continue;
    loaded.add(family);
    const face = new FontFace(family, `url(${fontUrl(family)})`, { weight: "400 700" });
    face
      .load()
      .then((ff) => document.fonts.add(ff))
      .catch(() => loaded.delete(family));
  }
}
export const fontUrl = (family: string) => `/api/fonts/${encodeURIComponent(family)}`;

const BUILTIN = {
  defaultFamily: TEXT_FONTS[0].family as string,
  fonts: TEXT_FONTS.map((f) => ({ family: f.family as string, label: f.label as string, builtin: true })),
};

/**
 * The font list (the built-in ones until the server answers) and the family a style without its own font uses (the
 * instance's CAPTION_FONT). Registers every face for the preview.
 */
export function useFonts() {
  const trpc = useTRPC();
  const q = useQuery({ ...trpc.fonts.list.queryOptions(), staleTime: 60_000 });
  const data = q.data ?? BUILTIN;
  const key = data.fonts.map((f) => f.family).join("\n");
  useEffect(() => loadFonts(key.split("\n")), [key]);
  return data;
}

/** Select options for a font: every available font, under the label the server gives it. */
export const fontOptions = (fonts: ReadonlyArray<{ family: string; label: string }>) => fonts.map((f) => ({ value: f.family, label: f.label }));

/** CSS font-family for a caption, hook or text layer: the chosen face, then the built-in fallback. */
export const cssFontFamily = (family?: string | null) =>
  family ? `"${family}", "DejaVu Sans", Verdana, system-ui, sans-serif` : `"DejaVu Sans", Verdana, system-ui, sans-serif`;
