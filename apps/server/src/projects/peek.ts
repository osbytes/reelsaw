import { z } from "zod";

const oembedSchema = z.object({ title: z.string().optional(), thumbnail_url: z.string().optional(), author_name: z.string().optional() });

/** Best-effort title + thumbnail for a URL before ingest runs (YouTube/Vimeo oEmbed, 4 s budget). */
export async function peekUrlMeta(url: string): Promise<{ title?: string; thumbnail?: string; uploader?: string }> {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return {};
  }
  const oembed = /(^|\.)(youtube\.com|youtu\.be)$/.test(host)
    ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`
    : /(^|\.)vimeo\.com$/.test(host)
      ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`
      : null;
  if (!oembed) return { title: host };
  try {
    const res = await fetch(oembed, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return { title: host };
    const j = oembedSchema.safeParse(await res.json());
    if (!j.success) return { title: host };
    return { title: j.data.title, thumbnail: j.data.thumbnail_url, uploader: j.data.author_name };
  } catch {
    return { title: host };
  }
}
