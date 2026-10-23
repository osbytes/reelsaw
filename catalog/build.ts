/**
 * Builds the Reelsaw starter pack: downloads every source in catalog/sources.json into a fresh temp directory
 * (outside the repo; archives are untrusted data and nothing in them is ever executed), normalises it, and writes
 *
 *   apps/server/assets/catalog/index.json          the manifest (docs/specs/library.md, "System assets")
 *   apps/server/assets/catalog/files/<id>.<ext>    the files, served at GET /media/catalog/<file>
 *
 * Run from the repo root:  npx tsx catalog/build.ts   (needs ffmpeg + ffprobe on PATH and the network)
 * Only CC0 / ISC / MIT / Apache-2.0 items may be bundled (see catalog/README.md); the script refuses anything else.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "apps/server/assets/catalog");
const BUNDLE_LICENSES = new Set(["cc0", "isc", "mit", "apache-2.0"]);
const MAX_DOWNLOAD = 50 * 1024 * 1024;
const ICON_PX = 512;

interface Item { file: string; name: string; tags: string[]; archive?: string; path?: string }
interface Group {
  type: "svg" | "audio";
  kind: "image" | "audio";
  category: string;
  idPrefix: string;
  license: { id: string; name: string; url: string };
  attribution: string;
  urlTemplate?: string;
  sourceTemplate?: string;
  tint?: string;
  items: Item[];
}
interface Sources { version: number; archives: Record<string, { page: string; url: string }>; groups: Group[] }

async function download(url: string, to: string) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60_000), headers: { "user-agent": "reelsaw-catalog-build" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_DOWNLOAD) throw new Error(`${url}: larger than ${MAX_DOWNLOAD} bytes`);
  await fs.writeFile(to, buf);
}

/** Make a source SVG usable as an overlay: fixed pixel size (librsvg rasterises at the declared size), optional tint. */
function prepareSvg(svg: string, tint: string | undefined): { svg: string; viewBox: number[] } {
  const open = /<svg\b[^>]*>/i.exec(svg);
  if (!open) throw new Error("not an SVG");
  let tag = open[0];
  const vb = /viewBox\s*=\s*"([^"]+)"/i.exec(tag)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (!vb || vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) throw new Error("SVG has no usable viewBox");
  tag = tag.replace(/\s(width|height)\s*=\s*"[^"]*"/gi, "").replace(/<svg\b/i, `<svg width="${ICON_PX}" height="${ICON_PX}"`);
  let out = svg.replace(open[0], tag);
  if (/<script\b|\son\w+\s*=|javascript:/i.test(out)) throw new Error("SVG contains script");
  if (tint) out = out.replace(/currentColor/g, tint);
  return { svg: out, viewBox: vb };
}

const sha256 = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

async function main() {
  const sources: Sources = JSON.parse(await fs.readFile(path.join(root, "catalog/sources.json"), "utf8"));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "reelsaw-catalog-"));
  console.log(`working in ${tmp}`);
  try {
    // archives: download, extract with unzip into their own empty directory, never run anything from them
    const archiveDirs: Record<string, string> = {};
    for (const [name, a] of Object.entries(sources.archives)) {
      const zip = path.join(tmp, `${name}.zip`);
      const dir = path.join(tmp, `x-${name}`);
      await fs.mkdir(dir);
      await download(a.url, zip);
      await run("unzip", ["-q", "-o", zip, "-d", dir]);
      archiveDirs[name] = dir;
      console.log(`archive ${name}`);
    }

    const stage = path.join(tmp, "out");
    await fs.mkdir(path.join(stage, "files"), { recursive: true });
    const items: unknown[] = [];
    const seen = new Set<string>();
    for (const g of sources.groups) {
      if (!BUNDLE_LICENSES.has(g.license.id)) throw new Error(`license ${g.license.id} may not be bundled`);
      for (const it of g.items) {
        const id = `${g.idPrefix}${it.file}`;
        if (seen.has(id)) throw new Error(`duplicate id ${id}`);
        seen.add(id);
        let ext: string;
        let data: Buffer;
        let extra: Record<string, unknown> = {};
        let sourceUrl: string;
        if (g.type === "svg") {
          const url = g.urlTemplate!.replace("{file}", it.file);
          const tmpFile = path.join(tmp, `${id}.svg`);
          await download(url, tmpFile);
          const prepared = prepareSvg(await fs.readFile(tmpFile, "utf8"), g.tint);
          data = Buffer.from(prepared.svg);
          ext = "svg";
          extra = { width: ICON_PX, height: ICON_PX };
          sourceUrl = g.sourceTemplate!.replace("{file}", it.file);
        } else {
          const dir = archiveDirs[it.archive!];
          if (!dir || !it.path) throw new Error(`${id}: archive/path missing`);
          const src = path.resolve(dir, it.path);
          if (!src.startsWith(dir + path.sep)) throw new Error(`${id}: path escapes the archive`);
          const dest = path.join(tmp, `${id}.mp3`);
          // mono, 64 kbps, no metadata: effects sit under speech
          await run("ffmpeg", ["-v", "error", "-y", "-i", src, "-vn", "-map_metadata", "-1", "-ac", "1", "-ar", "44100", "-codec:a", "libmp3lame", "-b:a", "64k", dest]);
          const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", dest]);
          const dur = Number(probe.stdout.trim());
          if (!Number.isFinite(dur) || dur <= 0) throw new Error(`${id}: could not read the duration`);
          if (dur > 8) throw new Error(`${id}: ${dur.toFixed(1)} s is not a short effect`);
          data = await fs.readFile(dest);
          ext = "mp3";
          extra = { durationSec: Math.round(dur * 100) / 100 };
          sourceUrl = sources.archives[it.archive!]!.page;
        }
        await fs.writeFile(path.join(stage, "files", `${id}.${ext}`), data);
        items.push({
          id,
          kind: g.kind,
          mime: ext === "svg" ? "image/svg+xml" : "audio/mpeg",
          name: it.name,
          tags: it.tags,
          category: g.category,
          ...extra,
          bytes: data.length,
          sha256: sha256(data),
          url: `files/${id}.${ext}`,
          license: g.license,
          attribution: g.attribution,
          source: { url: sourceUrl },
        });
      }
    }
    const manifest = { version: sources.version, generatedAt: new Date().toISOString(), items };
    await fs.writeFile(path.join(stage, "index.json"), JSON.stringify(manifest, null, 2) + "\n");

    // replace the committed pack only once everything above succeeded
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(outDir), { recursive: true });
    await fs.cp(stage, outDir, { recursive: true });
    const total = (items as Array<{ bytes: number }>).reduce((n, i) => n + i.bytes, 0);
    console.log(`wrote ${items.length} items, ${(total / 1024).toFixed(0)} KB, to ${path.relative(root, outDir)}`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
