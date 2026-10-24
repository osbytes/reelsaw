import fs from "node:fs";
import fsp from "node:fs/promises";
import { Readable } from "node:stream";
import { contentTypeFor } from "./storage/index.js";

/**
 * Range-capable file response for video playback. The file's size and mtime make its ETag, so a cached
 * copy is revalidated with a 304 instead of re-sent; `revalidate` makes the browser ask every time, for a
 * file whose URL stays the same when its content changes (a re-rendered clip and its thumbnail).
 */
export async function sendFile(req: Request, file: string, downloadName?: string, opts: { revalidate?: boolean } = {}): Promise<Response> {
  let st: fs.Stats;
  try {
    st = await fsp.stat(file);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    "Content-Type": contentTypeFor(file),
    "Accept-Ranges": "bytes",
    "Cache-Control": opts.revalidate ? "private, no-cache" : "private, max-age=3600",
    ETag: etag,
    "Last-Modified": st.mtime.toUTCString(),
  };
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim() === etag)) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": headers["Cache-Control"]! } });
  // a range on a changed file must not be stitched onto the old one
  const ifRange = req.headers.get("if-range");
  const rangeOk = !ifRange || ifRange === etag || ifRange === headers["Last-Modified"];
  if (downloadName) headers["Content-Disposition"] = `attachment; filename="${downloadName.replace(/"/g, "")}"`;
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const m = rangeOk ? /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "") : null;
  if (m) {
    if (m[1]) start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), st.size - 1);
    if (!m[1] && m[2]) {
      start = Math.max(0, st.size - Number(m[2]));
      end = st.size - 1;
    }
    if (start > end || start >= st.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${st.size}` } });
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  }
  headers["Content-Length"] = String(end - start + 1);
  return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream, { status, headers });
}

