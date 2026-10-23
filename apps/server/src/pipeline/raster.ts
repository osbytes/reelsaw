/**
 * SVG rasterising with resvg (a Rust renderer shipped as prebuilt binaries), so an SVG logo works
 * the same on a dev Mac and in the Docker image, whatever librsvg the local ffmpeg was built with.
 * ffprobe cannot size an SVG reliably, so the size comes from here too.
 */
import { Resvg } from "@resvg/resvg-js";

/** Used when an SVG declares no size and has nothing drawable to measure. */
export const SVG_FALLBACK_PX = 1024;

const options = { font: { loadSystemFonts: false } } as const;

/** Intrinsic size of an SVG (width/height, else viewBox, else its content); null when it cannot be parsed. */
export function svgSize(svg: Buffer | string): { width: number; height: number } | null {
  try {
    const r = new Resvg(svg, options);
    const ok = (n: number) => Number.isFinite(n) && n >= 1;
    return ok(r.width) && ok(r.height) ? { width: Math.round(r.width), height: Math.round(r.height) } : { width: SVG_FALLBACK_PX, height: SVG_FALLBACK_PX };
  } catch {
    return null;
  }
}

/**
 * True when an SVG pulls in another file (an `<image>`, `<use>` or `<feImage>` whose href is not `#id` or an
 * embedded `data:` URI). Uploads are untrusted, so such a file is refused rather than letting the renderer open paths.
 */
export function svgHasExternalRefs(svg: Buffer | string): boolean {
  const text = typeof svg === "string" ? svg : svg.toString("utf8");
  for (const tag of text.matchAll(/<(?:image|use|feImage)\b[^>]*>/gi)) {
    for (const href of tag[0].matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
      const v = (href[1] ?? href[2] ?? "").trim();
      if (v && !v.startsWith("#") && !/^data:/i.test(v)) return true;
    }
  }
  return false;
}

const MAX_RASTER_PX = 8192;

/**
 * PNG bytes of an SVG scaled to `widthPx` wide (height follows the aspect ratio); the background stays
 * transparent. A very tall drawing is capped at 8192 px high instead, so one file cannot ask for gigabytes.
 */
export function rasterizeSvg(svg: Buffer | string, widthPx: number): Buffer {
  const size = svgSize(svg);
  if (!size) throw new Error("This SVG could not be read.");
  if (svgHasExternalRefs(svg)) throw new Error("This SVG links to other files.");
  const tooTall = (widthPx * size.height) / size.width > MAX_RASTER_PX;
  const r = new Resvg(svg, { ...options, fitTo: tooTall ? { mode: "height", value: MAX_RASTER_PX } : { mode: "width", value: widthPx } });
  return Buffer.from(r.render().asPng());
}
