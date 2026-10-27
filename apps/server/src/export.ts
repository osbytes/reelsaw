/**
 * Bulk export: one zip with every rendered clip plus platform-ready metadata.
 *
 * Neither YouTube Studio nor the TikTok web uploader accept a metadata sidecar, so the
 * zip carries the metadata in the shapes their official APIs take (YouTube Data API v3
 * `videos.insert` body, TikTok Content Posting API `post_info`) plus a paste-ready text
 * file per clip, a manifest and a CSV for spreadsheet / automation use.
 */
import type { Logger } from "./log.js";
import path from "node:path";
import fsp from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ZipArchive, type ZipEntryData } from "archiver";
import type { Readable } from "node:stream";
import type { Storage } from "./storage/index.js";
import type { Paths } from "./config.js";
import type { Clip, Project } from "./db/schema.js";
import { formatTime, toSrt, toVtt } from "@reelsaw/shared";

export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;
export const YOUTUBE_TAGS_MAX_CHARS = 500;
export const TIKTOK_CAPTION_MAX = 2200;

export interface ExportInput {
  project: Pick<Project, "id" | "title" | "sourceType" | "sourceUrl" | "sourceMeta" | "durationSec" | "settings">;
  clips: Clip[];
  language: string | null;
  /** set when the zip holds only the clips the user picked, not every rendered clip */
  subset?: { requested: number; total: number };
}

export interface ClipExport {
  index: number;
  base: string;
  video: string;
  thumbnail: string | null;
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  startSec: number;
  endSec: number;
  durationSec: number;
  /** length of the rendered file: the clip plus any intro/outro (durationSec is the source span only) */
  renderedDurationSec: number | null;
  score: number;
  layout: string | null;
  parent: { url: string | null; atUrl: string | null; startSec: number };
  youtube: {
    snippet: { title: string; description: string; tags: string[]; categoryId: string; defaultLanguage?: string };
    status: { privacyStatus: "private" | "unlisted" | "public"; selfDeclaredMadeForKids: boolean };
  };
  tiktok: {
    post_info: { title: string; privacy_level: "SELF_ONLY" | "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR"; disable_duet: boolean; disable_comment: boolean; disable_stitch: boolean; video_cover_timestamp_ms: number };
  };
  text: string;
}

export interface ExportManifest {
  version: 1;
  generatedAt: string;
  generator: string;
  project: { id: string; title: string; durationSec: number | null; language: string | null };
  parent: { url: string | null; platform: "youtube" | "other" | null; videoId: string | null; uploader: string | null };
  /** present only for a partial export: the clips picked, and how many rendered clips the project has */
  subset?: { requested: number; total: number };
  clips: ClipExport[];
}

export const EXPORT_CLIP_IDS_MAX = 200;

/** The `?clips=a,b` allow-list: trimmed, de-duplicated, empty when absent. Null when it is malformed or too long. */
export function parseClipIds(raw: string | null | undefined): string[] | null {
  if (raw === undefined || raw === null || raw.trim() === "") return [];
  const ids = [...new Set(raw.split(",").map((x) => x.trim()).filter(Boolean))];
  if (ids.length > EXPORT_CLIP_IDS_MAX || ids.some((x) => !/^[\w-]{1,64}$/.test(x))) return null;
  return ids;
}

/** Narrows a project's clips to an allow-list (empty = all). Unknown ids are reported, not ignored. */
export function pickExportClips(clips: Clip[], ids: string[]): { clips: Clip[]; unknown: string[]; subset?: { requested: number; total: number } } {
  if (!ids.length) return { clips, unknown: [] };
  const have = new Set(clips.map((c) => c.id));
  const want = new Set(ids);
  const total = clips.filter((c) => c.status === "done" && c.outputKey).length;
  return { clips: clips.filter((c) => want.has(c.id)), unknown: ids.filter((x) => !have.has(x)), subset: { requested: ids.length, total } };
}

/** Extract a YouTube video id from the common URL shapes; null for anything else. */
export function youtubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return u.pathname.slice(1).split("/")[0] || null;
    if (host === "youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const m = /^\/(?:shorts|live|embed|v)\/([\w-]{6,})/.exec(u.pathname);
      if (m) return m[1];
    }
  } catch {
    /* not a url */
  }
  return null;
}

export function slugify(s: string, max = 60) {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\w\- ]+/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, max)
      .replace(/-$/, "") || "clip"
  );
}

function clampTitle(s: string, max: number) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function tag(s: string) {
  return s.replace(/^#/, "").replace(/[^\p{L}\p{N}_]+/gu, "");
}

/** Fit tags into YouTube's 500-character budget (commas count, multi-word tags are quoted). */
function fitYoutubeTags(tags: string[]) {
  const out: string[] = [];
  let used = 0;
  for (const t of tags) {
    const cost = (t.includes(" ") ? t.length + 2 : t.length) + (out.length ? 1 : 0);
    if (used + cost > YOUTUBE_TAGS_MAX_CHARS) break;
    out.push(t);
    used += cost;
  }
  return out;
}

export function buildClipExport(input: ExportInput, clip: Clip, videoId: string | null): ClipExport {
  const { project } = input;
  const n = String(clip.index + 1).padStart(2, "0");
  const base = `${n}-${slugify(clip.title)}`;
  const start = Math.max(0, Math.floor(clip.startSec));
  const parentUrl = project.sourceType === "url" ? (project.sourceUrl ?? null) : null;
  const atUrl = videoId ? `https://youtu.be/${videoId}?t=${start}` : parentUrl ? appendT(parentUrl, start) : null;
  const hashtags = Array.from(new Set(clip.hashtags.map(tag).filter(Boolean)));
  const hashLine = ["Shorts", ...hashtags.filter((h) => h.toLowerCase() !== "shorts")].map((h) => `#${h}`).join(" ");

  const descriptionParts = [clip.hook.trim(), clip.caption.trim()].filter(Boolean);
  const descriptionLines = [
    ...descriptionParts,
    "",
    ...(atUrl ? [`Full video: ${atUrl}`] : parentUrl ? [`Full video: ${parentUrl}`] : []),
    ...(project.sourceMeta?.uploader ? [`From "${project.title}" by ${String(project.sourceMeta.uploader)}`] : [`From "${project.title}"`]),
    "",
    hashLine,
  ];
  const description = descriptionLines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, YOUTUBE_DESCRIPTION_MAX);
  const ytTags = fitYoutubeTags([...hashtags, ...((project.sourceMeta?.tags as string[] | undefined) ?? [])].map((t) => t.trim()).filter((t, i, a) => t && a.indexOf(t) === i));

  const tiktokCaption = [clip.caption.trim() || clip.hook.trim(), hashtags.map((h) => `#${h}`).join(" ")]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, TIKTOK_CAPTION_MAX);

  const text = [
    `TITLE (${clampTitle(clip.title, YOUTUBE_TITLE_MAX).length}/${YOUTUBE_TITLE_MAX})`,
    clampTitle(clip.title, YOUTUBE_TITLE_MAX),
    "",
    "HOOK",
    clip.hook.trim(),
    "",
    "YOUTUBE DESCRIPTION",
    description,
    "",
    "YOUTUBE TAGS",
    ytTags.join(", "),
    "",
    "TIKTOK / REELS CAPTION",
    tiktokCaption,
    "",
    "SOURCE",
    `${formatTime(clip.startSec)} – ${formatTime(clip.endSec)} (${Math.round(clip.endSec - clip.startSec)}s) of "${project.title}"`,
    ...(atUrl ? [atUrl] : parentUrl ? [parentUrl] : []),
    "",
  ].join("\n");

  return {
    index: clip.index,
    base,
    video: `${base}.mp4`,
    thumbnail: clip.thumbnailKey ? `${base}.jpg` : null,
    title: clip.title,
    hook: clip.hook,
    caption: clip.caption,
    hashtags,
    startSec: clip.startSec,
    endSec: clip.endSec,
    durationSec: Math.round((clip.endSec - clip.startSec) * 100) / 100,
    renderedDurationSec: clip.diagnostics ? Math.round((clip.diagnostics.outDurationSec + (clip.diagnostics.bumpers?.introSec ?? 0) + (clip.diagnostics.bumpers?.outroSec ?? 0)) * 100) / 100 : null,
    score: clip.score,
    layout: clip.layout,
    parent: { url: parentUrl, atUrl, startSec: start },
    youtube: {
      snippet: {
        title: clampTitle(clip.title, YOUTUBE_TITLE_MAX),
        description,
        tags: ytTags,
        categoryId: "22",
        ...(input.language ? { defaultLanguage: input.language } : {}),
      },
      status: { privacyStatus: "private", selfDeclaredMadeForKids: false },
    },
    tiktok: {
      post_info: {
        title: tiktokCaption,
        privacy_level: "SELF_ONLY",
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
        video_cover_timestamp_ms: 1000,
      },
    },
    text,
  };
}

function appendT(url: string, t: number) {
  try {
    const u = new URL(url);
    u.searchParams.set("t", String(t));
    return u.toString();
  } catch {
    return url;
  }
}

export function buildManifest(input: ExportInput): ExportManifest {
  const videoId = youtubeVideoId(input.project.sourceUrl);
  const clips = input.clips
    .filter((c) => c.status === "done" && c.outputKey)
    .sort((a, b) => a.index - b.index)
    .map((c) => buildClipExport(input, c, videoId));
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    generator: "reelsaw",
    project: { id: input.project.id, title: input.project.title, durationSec: input.project.durationSec ?? null, language: input.language },
    parent: {
      url: input.project.sourceType === "url" ? (input.project.sourceUrl ?? null) : null,
      platform: videoId ? "youtube" : input.project.sourceUrl ? "other" : null,
      videoId,
      uploader: (input.project.sourceMeta?.uploader as string | undefined) ?? null,
    },
    ...(input.subset ? { subset: input.subset } : {}),
    clips,
  };
}

/**
 * One CSV field. Text a spreadsheet would run as a formula (a title or caption that starts with = + - @, a tab or a
 * carriage return; titles come from videos and models) gets a leading apostrophe, which Excel, Sheets and Numbers show as plain text.
 * Numbers are written as they are: a negative one is not text.
 */
export function csvCell(v: unknown) {
  let s = v == null ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(m: ExportManifest) {
  const header = ["file", "thumbnail", "title", "hook", "caption", "hashtags", "start_sec", "end_sec", "duration_sec", "rendered_duration_sec", "score", "layout", "parent_url", "parent_timestamp_url", "youtube_title", "youtube_description", "youtube_tags", "tiktok_caption"];
  const rows = m.clips.map((c) => [
    `clips/${c.video}`,
    c.thumbnail ? `clips/${c.thumbnail}` : "",
    c.title,
    c.hook,
    c.caption,
    c.hashtags.map((h) => `#${h}`).join(" "),
    c.startSec,
    c.endSec,
    c.durationSec,
    c.renderedDurationSec ?? "",
    c.score,
    c.layout ?? "",
    c.parent.url ?? "",
    c.parent.atUrl ?? "",
    c.youtube.snippet.title,
    c.youtube.snippet.description,
    c.youtube.snippet.tags.join(", "),
    c.tiktok.post_info.title,
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function buildReadme(m: ExportManifest) {
  return `Reelsaw export — "${m.project.title}"
${m.clips.length} clip(s)${m.subset ? ` (a selection: ${m.subset.requested} picked of ${m.subset.total} rendered)` : ""}, generated ${m.generatedAt}

LAYOUT
  clips/NN-title.mp4           vertical 1080x1920 H.264/AAC, ready to upload as-is
  clips/NN-title.jpg           thumbnail (first frame)
  clips/NN-title.txt           paste-ready title, description, tags and caption
  clips/NN-title.youtube.json  YouTube Data API v3 "videos.insert" request body (snippet + status)
  clips/NN-title.tiktok.json   TikTok Content Posting API "post_info" (Direct Post / Upload)
  clips/NN-title.srt, .vtt     the captions as rendered (same text and timing as the video), for
                               YouTube / Facebook / LinkedIn caption uploads; clips rendered before
                               caption files existed have none until they are re-rendered
  manifest.json                everything above in one machine-readable file
  clips.csv                    one row per clip, for spreadsheets / bulk tools

LENGTH
  start_sec, end_sec and duration_sec describe the moment in the source video. If you set an intro or
  outro in Settings, the mp4 also contains them, so check rendered_duration_sec (clips.csv) /
  renderedDurationSec (manifest.json) against platform length limits.

UPLOADING
  YouTube Studio: drag all clips/*.mp4 into Create → Upload videos (up to 15 at once). Studio has no
    metadata import, so paste title/description/tags from the matching .txt file. Vertical videos
    up to 3 minutes are treated as Shorts automatically; "#Shorts" is already in the description.
  TikTok: upload each .mp4 in the web uploader and paste the caption from the .txt file. TikTok
    captions do not render links, so the parent video is referenced by name only there.
  Automation: the .youtube.json and .tiktok.json files are the exact request bodies the official APIs
    take (videos.insert with the mp4 as the media part; TikTok /v2/post/publish/video/init/ with
    source_info for the mp4). Privacy defaults to private / SELF_ONLY so nothing goes live by accident.

LINKING SHORTS TO THE PARENT VIDEO
  YouTube: in Studio, open the uploaded Short → Details → "Related video" and pick the full-length
    video. That link is what shows the "watch full video" button on the Short. Neither the Studio
    bulk uploader nor the Data API expose it, so it is a per-Short click. As a fallback every
    description already contains a timestamped link to the exact moment in the parent video
    (parent_timestamp_url in clips.csv / parent.atUrl in manifest.json).
  TikTok: there is no parent-video concept. Use the pinned comment or the link in your bio.
`;
}

/**
 * Stream a zip of all rendered clips with metadata. Resolves to a Node readable; the caller is
 * responsible for piping it. Temp copies pulled from remote storage are removed when the archive
 * finishes or errors.
 */
export async function createExportZip(deps: { storage: Storage; paths: Paths; log?: Logger }, input: ExportInput): Promise<{ stream: Readable; filename: string; manifest: ExportManifest }> {
  const manifest = buildManifest(input);
  const byIndex = new Map(input.clips.map((c) => [c.index, c]));
  const tmpDir = path.join(deps.paths.tmp, `export-${randomUUID()}`);
  await fsp.mkdir(tmpDir, { recursive: true });

  const localFile = async (key: string, name: string) => {
    const loc = await deps.storage.resolve(key);
    if ("file" in loc) return loc.file;
    return deps.storage.ensureLocal(key, path.join(tmpDir, name));
  };

  const archive = new ZipArchive({ zlib: { level: 1 } });
  const cleanup = () => void fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  const log = deps.log?.child({ module: "export", projectId: input.project.id });
  archive.on("end", () => {
    cleanup();
    log?.info({ clips: manifest.clips.length, bytes: archive.pointer() }, "export sent");
  });
  archive.on("error", (err) => {
    cleanup();
    log?.warn({ err, clips: manifest.clips.length }, "export failed");
  });
  archive.on("close", cleanup);

  (async () => {
    try {
      archive.append(buildReadme(manifest), { name: "README.txt" });
      archive.append(JSON.stringify(manifest, null, 2), { name: "manifest.json" });
      archive.append(buildCsv(manifest), { name: "clips.csv" });
      for (const c of manifest.clips) {
        const clip = byIndex.get(c.index)!;
        archive.file(await localFile(clip.outputKey!, c.video), { name: `clips/${c.video}`, store: true } as ZipEntryData);
        if (clip.thumbnailKey && c.thumbnail) archive.file(await localFile(clip.thumbnailKey, c.thumbnail), { name: `clips/${c.thumbnail}`, store: true } as ZipEntryData);
        archive.append(c.text, { name: `clips/${c.base}.txt` });
        archive.append(JSON.stringify(c.youtube, null, 2), { name: `clips/${c.base}.youtube.json` });
        archive.append(JSON.stringify(c.tiktok, null, 2), { name: `clips/${c.base}.tiktok.json` });
        // the captions as rendered (times include the intro), for platforms that take a caption file; clips rendered before this existed have none
        if (clip.captions) {
          archive.append(toSrt(clip.captions.lines), { name: `clips/${c.base}.srt` });
          archive.append(toVtt(clip.captions.lines), { name: `clips/${c.base}.vtt` });
        }
      }
      await archive.finalize();
    } catch (err) {
      archive.destroy(err as Error);
    }
  })();

  return { stream: archive, filename: `${slugify(input.project.title, 80)}-clips.zip`, manifest };
}
