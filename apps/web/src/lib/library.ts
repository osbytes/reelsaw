import type { AssetProvenance } from "@reelsaw/shared";

export type LibraryKind = "video" | "image" | "audio";
export const KIND_FILTERS: Array<{ id: LibraryKind; label: string }> = [
  { id: "video", label: "Video" },
  { id: "image", label: "Image" },
  { id: "audio", label: "Audio" },
];

const FORMATS: Record<string, string> = {
  "image/gif": "GIF",
  "image/svg+xml": "SVG",
  "image/webp": "WebP",
  "image/png": "PNG",
  "image/jpeg": "JPG",
  "image/avif": "AVIF",
  "video/mp4": "MP4",
  "video/quicktime": "MOV",
  "video/webm": "WebM",
  "audio/mpeg": "MP3",
  "audio/mp3": "MP3",
  "audio/mp4": "M4A",
  "audio/x-m4a": "M4A",
  "audio/aac": "AAC",
  "audio/wav": "WAV",
  "audio/x-wav": "WAV",
  "audio/wave": "WAV",
  "audio/ogg": "OGG",
  "audio/flac": "FLAC",
  "audio/x-flac": "FLAC",
};
/** "GIF", "SVG", "MP4", "MP3"… from a mime type; null when unknown */
export function formatTag(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const m = mime.toLowerCase().split(";")[0]!.trim();
  return FORMATS[m] ?? (m.split("/")[1]?.replace(/^x-/, "").slice(0, 5).toUpperCase() || null);
}

export interface FilterableAsset {
  kind: LibraryKind;
  name: string;
  tags: string[];
  provenance: AssetProvenance | null;
}

/** the flat fields Fuse searches (arrays and nested provenance are joined) */
export const searchable = <T extends FilterableAsset>(a: T) => ({ ...a, tagText: a.tags.join(" "), attributionText: a.provenance?.attribution ?? "" });
export const SEARCH_KEYS = [
  { name: "name", weight: 2 },
  { name: "tagText", weight: 1.5 },
  { name: "attributionText", weight: 0.5 },
];

/** "CC0 · Freesound · author" */
export function licenseText(p: AssetProvenance): string {
  const provider = p.provider === "reelsaw" ? "Catalog" : p.provider.charAt(0).toUpperCase() + p.provider.slice(1);
  return [p.license?.name, provider, p.attribution].filter(Boolean).join(" · ");
}
