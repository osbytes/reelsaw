import { TEXT_FONTS, type TextFont } from "@reelsaw/shared";

/**
 * The text-overlay fonts come from the server image (`/api/fonts/:family`, the same files libass
 * draws with), registered once per page so the editor preview shows the real face. A font the
 * server does not have fails quietly: the preview falls back to the caption font, like the render.
 */
const loaded = new Set<string>();
export function loadTextFonts() {
  if (typeof document === "undefined" || !("fonts" in document)) return;
  for (const f of TEXT_FONTS) {
    if (loaded.has(f.family)) continue;
    loaded.add(f.family);
    const face = new FontFace(f.family, `url(${fontUrl(f.family)})`, { weight: "400 700" });
    face
      .load()
      .then((ff) => document.fonts.add(ff))
      .catch(() => {});
  }
}
export const fontUrl = (family: string) => `/api/fonts/${encodeURIComponent(family)}`;
/** CSS font-family for a text overlay: the chosen face, then the caption font. */
export const textFontFamily = (family?: string | null) =>
  family ? `"${family}", "DejaVu Sans", Verdana, system-ui, sans-serif` : `"DejaVu Sans", Verdana, system-ui, sans-serif`;
export const isTextFont = (v: string): v is TextFont => TEXT_FONTS.some((f) => f.family === v);
