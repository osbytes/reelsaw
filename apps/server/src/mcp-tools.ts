/**
 * The MCP tool catalogue: names, descriptions and input schemas of every tool Reelsaw exposes.
 * `mcp.ts` binds them to the tRPC procedures for `/api/mcp`; `mcp-stdio.ts` registers the same
 * catalogue over stdio and forwards calls to a running instance. One list, so the two surfaces
 * cannot drift (`test/mcp.test.ts` checks they advertise the same tools and schemas).
 */
import { z } from "zod";
import { CLEARABLE_SETTINGS, projectSettingsPatchSchema, reframeModeSchema, layoutSectionSchema, styleOverrideSchema, clipOverlaySchema, clipAudioSchema, clipLayerSchema, assetTagsSchema, MAX_CLIP_OVERLAYS, MAX_CLIP_AUDIO, MAX_CLIP_LAYERS } from "@reelsaw/shared";
import { addAssetInput, addBumperInput, bumperNameSchema, setClipBumpersInput, setProjectBumpersInput } from "./library/service.js";
import { settingsPatchSchema } from "./instance-settings.js";

export const INSTRUCTIONS = `Reelsaw turns long-form videos into vertical short clips (transcribe → find moments → reframe, caption, render).
Workflow: create_project(sourceUrl) → wait_for_project (call again until done; a 30-min video takes several minutes) → get_project for the clips → get_clip for download links.
Which tool when:
- inspect: get_project (state + all clips), get_clip (one clip in full), get_transcript (the words, timed), get_project_events (what happened and why), report_issue (zip of a project, or instance-wide diagnostics for admins); admins: get_failure for one failed project or clip's full reason
- change: update_clip (one clip's text, bounds, framing, style, overlays), create_clip (a new moment from a time range), update_project (title and settings, nothing re-run), reanalyze_project (pick clips again)
- recover: retry_project (resume a failed project where it stopped) vs reanalyze_project (different clips); render: rerender_clip (one clip) vs rerender_clips (many clips of a project)
Your library (list_assets, add_asset, update_asset, remove_asset, asset_usage; the *_bumper tools are aliases) holds videos, images, GIFs, SVGs and sounds. Bumpers are short intro/outro videos or images (max 10 s) from it that are joined around every clip; set one as your default for new projects (set_default_bumper), per project (set_project_bumpers) or per clip (set_clip_bumpers). Bumpers are burned into the rendered video, so a change only shows after a re-render: pass rerender: true to re-render just the affected clips. The same library items go on a clip as layers over a time range: update_clip { layers: [{ kind: "asset", id, assetId, start, end, x, y, w }, { kind: "text", id, text, start, end, x, y, size, color, box }, { kind: "audio", id, assetId, start, end, volume, duck, fade, loop }] } (a sound effect is an audio layer with loop false, duck false, fade 0).
Deleting is reversible for a while: delete_project, delete_clip and the clips a reanalyze_project replaces can be brought back (restore_project, restore_clip); clips you made or edited survive a re-analyze.
You only see and change your own projects and library. Admins may pass instance: true on report_issue to include unfinished work and errors across the instance. All ids are strings. Times are seconds from the start of the source video. Media URLs need the same Authorization header as this server.`;

const settingsInput = projectSettingsPatchSchema.describe("Project settings; omit for the defaults (automatic clip count, 20–60 s clips, natural pauses, refine steps off). Set refineEntities / refineDisfluency / disfluencyLlm / refineScenes true to opt into polish (instance Pipeline gates must be on).");

/** Ids and scalars only, never bodies (captions, transcripts, prompts): enough to find what a tool touched. */
export function argSummary(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!args || typeof args !== "object") return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = /id$/i.test(k) || k === "cursor" ? v.slice(0, 64) : `${v.length} chars`;
    else if (Array.isArray(v)) out[k] = `${v.length} items`;
    else if (v && typeof v === "object") out[k] = `{${Object.keys(v).join(",")}}`;
  }
  return out;
}

/** A tool result: JSON for objects, the string itself for text. */
export function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

/** A tool error the model can read (not a protocol failure). */
export function fail(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const projectId = (from = "list_projects, search_clips or create_project") => z.string().describe(`Project id (from ${from})`);
const clipId = (what = "Clip id") => z.string().describe(`${what} (from get_project or search_clips)`);
const assetIdInput = (from = "list_assets") => z.string().min(1).max(100).describe(`Library asset id (from ${from})`);

export const TOOLS = {
  list_projects: {
    title: "List projects",
    description: "Your projects, most recently updated first. Returns { projects: [{ id, title, status, stage, clips: \"n/m rendered\", url }], total, nextCursor }; pass nextCursor as cursor for the next page. Use get_project for one project's clips, search_clips to find by words.",
    inputSchema: {
      cursor: z.string().optional().describe("nextCursor from the previous page; omit for the first page"),
      limit: z.number().int().min(1).max(100).default(24).describe("Projects per page (1-100, default 24)"),
      deleted: z.boolean().optional().describe("true = only deleted projects that restore_project can still bring back"),
    },
    annotations: { readOnlyHint: true },
  },
  get_project: {
    title: "Get project",
    description: "One of your projects: status, settings, effective intro/outro, transcript summary, and every clip (id, title, hook, bounds, score, status, download links); replacedClips lists deleted or replaced clips for restore_clip. Returns the project object. For one clip's full detail use get_clip, for the words get_transcript, for the pipeline history get_project_events.",
    inputSchema: { id: projectId() },
    annotations: { readOnlyHint: true },
  },
  create_project: {
    title: "Create project",
    description: "Start clipping a video from a URL (YouTube, Vimeo, a direct link; anything yt-dlp fetches). Returns { id, title, status: \"queued\", next } at once; the pipeline (download, transcribe, pick, render) runs in the background for minutes, so follow with wait_for_project(id). Intro/outro default to your library defaults unless introAssetId/outroAssetId say otherwise.",
    inputSchema: {
      sourceUrl: z.url().describe("http(s) URL of the video"),
      title: z.string().min(1).max(200).optional().describe("Project title (default: the video's own title)"),
      settings: settingsInput.optional(),
      introAssetId: z.string().min(1).max(100).nullable().optional().describe("Library asset id (list_assets) for the intro of every clip; null = no intro; omitted = your default intro"),
      outroAssetId: z.string().min(1).max(100).nullable().optional().describe("Same for the outro"),
      introSec: z.number().min(1).max(10).optional().describe("Seconds an intro image shows (1-10)"),
      outroSec: z.number().min(1).max(10).optional().describe("Seconds an outro image shows (1-10)"),
    },
  },
  update_project: {
    title: "Update project",
    description: "Rename a project and/or change its saved settings (focus, instructions, clip length, maxClips, caption style, framing, pauses, refineEntities, refineDisfluency, disfluencyLlm, refineScenes); only the fields you pass change. Does not re-pick clips or re-render: reanalyze_project picks again with the new selection settings, refine_project applies refine toggles, rerender_clips applies style changes. Returns { changed, needsReanalyze, needsRefine, needsRerender, hint }.",
    inputSchema: {
      id: projectId(),
      title: z.string().trim().min(1).max(200).optional().describe("New title"),
      settings: projectSettingsPatchSchema.optional().describe("Settings to change; keys left out keep their value. Intro/outro go through set_project_bumpers"),
      clear: z.array(z.enum(CLEARABLE_SETTINGS)).max(CLEARABLE_SETTINGS.length).optional().describe("Optional settings to reset to their default, e.g. maxClips (back to automatic) or focus"),
    },
    annotations: { idempotentHint: true },
  },
  wait_for_project: {
    title: "Wait for project",
    description: "Block until the project is done or failed, or timeoutSeconds pass. Returns { id, status, stage, stageProgress, error, clips: [{ id, title, status }] }; on timeout the same with hint \"Still running\": call it again. Use get_project instead for a non-blocking look with full clip details.",
    inputSchema: {
      id: projectId("create_project or list_projects"),
      timeoutSeconds: z.number().int().min(1).max(120).default(60).describe("Longest to wait, seconds (1-120, default 60)"),
    },
    annotations: { readOnlyHint: true },
  },
  get_transcript: {
    title: "Get transcript",
    description: "The project's transcript as timed lines \"[m:ss] text\", optionally only a time range. Returns text; output longer than maxChars is cut with a note saying which fromSec to continue from. Use it to pick your own moments for create_clip.",
    inputSchema: {
      id: projectId(),
      fromSec: z.number().min(0).optional().describe("Start of the range, seconds from the start of the video"),
      toSec: z.number().min(0).optional().describe("End of the range, seconds"),
      maxChars: z.number().int().min(1000).max(200_000).default(60_000).describe("Cut the output at this many characters (1000-200000, default 60000)"),
    },
    annotations: { readOnlyHint: true },
  },
  get_clip_captions: {
    title: "Get clip captions",
    description: "The captions of a clip's last render as an SRT or WebVTT file: the same lines and times as the video (intro included), even when the style has captions off. Returns the file text; VTT with words: true adds karaoke word timestamps. A clip rendered before caption files existed answers that it needs a re-render (rerender_clip).",
    inputSchema: {
      id: clipId(),
      format: z.enum(["srt", "vtt"]).default("srt").describe("srt (default) or vtt"),
      words: z.boolean().default(false).describe("VTT only: add a <timestamp> before every word after the first in each cue"),
    },
    annotations: { readOnlyHint: true },
  },
  get_project_transcript_file: {
    title: "Get transcript file",
    description: "The project transcript as an SRT or WebVTT subtitle file, one cue per transcript segment, in source-video seconds. Returns the file text; VTT with words: true adds word timestamps. Use get_transcript to read it as plain timed lines instead.",
    inputSchema: {
      id: projectId(),
      format: z.enum(["srt", "vtt"]).default("srt").describe("srt (default) or vtt"),
      words: z.boolean().default(false).describe("VTT only: add a <timestamp> before every word after the first in each cue"),
    },
    annotations: { readOnlyHint: true },
  },
  import_transcript: {
    title: "Import transcript",
    description: "Use an SRT or WebVTT file as the project's transcript instead of transcribing: right after create_project (only the video is fetched) or on a done or failed project (it then re-cleans the transcript and picks clips again). Give exactly one of text, uploadId or url. Returns { format, cues, words, warnings, message }; follow with wait_for_project.",
    inputSchema: {
      id: projectId(),
      text: z.string().max(10 * 1024 * 1024).optional().describe("The contents of the .srt or .vtt file"),
      uploadId: z.string().optional().describe("Upload id of an .srt/.vtt file sent to POST /api/upload"),
      url: z.url().optional().describe("http(s) link to a public .srt/.vtt file"),
      format: z.enum(["auto", "srt", "vtt"]).default("auto").describe("auto (default) decides from the WEBVTT header"),
      language: z.string().min(2).max(12).optional().describe("Language code of the text, e.g. en, es, ja (default: the existing transcript's, else unknown)"),
    },
  },
  search_clips: {
    title: "Search clips",
    description: "Find your clips and projects by words in their title, hook or caption (every word must match; case-insensitive, typo-tolerant; best first). Returns { projects (max 8), clips (max limit) with ids, bounds and links, truncated? }. Use list_projects to browse instead.",
    inputSchema: {
      q: z.string().min(1).max(200).describe("Words to find, e.g. \"budget tips\""),
      limit: z.number().int().min(1).max(50).default(15).describe("Most clips to return (1-50, default 15)"),
    },
    annotations: { readOnlyHint: true },
  },
  get_project_events: {
    title: "Project activity",
    description: "The project's pipeline history, newest first: stage starts and completions, clip renders, retries, failures with reasons. Returns [{ at, type, ...details }]. Use it to find out why something failed or is slow; get_project shows the current state.",
    inputSchema: {
      id: projectId(),
      limit: z.number().int().min(1).max(200).default(50).describe("Most events to return (1-200, default 50)"),
    },
    annotations: { readOnlyHint: true },
  },
  get_clip: {
    title: "Get clip",
    description: "Everything about one clip: text, bounds, scores, framing, style, emphasis, own and effective intro/outro, layers (overlays, text, sounds), render diagnostics, video/thumbnail/editor links. Returns the clip object. get_project lists all clips in brief; poll this after an edit to see the render finish (status done).",
    inputSchema: { id: clipId() },
    annotations: { readOnlyHint: true },
  },
  update_clip: {
    title: "Update clip",
    description: "Edit one clip: only the fields you pass change; style, layoutSections and layers replace the whole value (null = project's / none). Title, caption and hashtags apply at once; bounds, hook, framing, style, emphasis and layers are burned in and re-render in the background (~1 min) unless rerender is false. Section fields: offsetX/Y nudge the (top) crop relative to the followed face, offsetX2/Y2 the bottom crop of a split, subjectX/X2 follow the person at that x. Returns the clip summary; poll get_clip until done.",
    inputSchema: {
      id: clipId(),
      title: z.string().min(1).max(120).optional().describe("Clip title (1-120 chars)"),
      hook: z.string().max(80).optional().describe("On-screen opening line (max 80 chars)"),
      caption: z.string().max(300).optional().describe("Post caption, not burned in (max 300 chars)"),
      hashtags: z.array(z.string().min(1).max(40)).max(20).optional().describe("Hashtags without # (max 20); replaces the list"),
      startSec: z.number().min(0).optional().describe("New start, seconds from the start of the source video"),
      endSec: z.number().min(0).optional().describe("New end, seconds from the start of the source; clip must stay ≥3 s"),
      layoutOverride: reframeModeSchema.nullable().optional().describe("Framing for the whole clip; null = automatic"),
      layoutSections: z.array(layoutSectionSchema).max(50).nullable().optional().describe("Framing per time range (max 50), source seconds; replaces all sections; null or [] = automatic"),
      style: styleOverrideSchema.nullable().optional().describe("Caption/hook style for this clip on top of the project's; replaces the clip's override; null = follow the project"),
      emphasis: z.array(z.string().min(1).max(40)).max(30).optional().describe("Words the captions colour (max 30); replaces the list"),
      layers: z.array(clipLayerSchema).max(MAX_CLIP_LAYERS).nullable().optional().describe(`Everything laid over or played under the clip, one list (max ${MAX_CLIP_LAYERS}): kind asset = a library image/GIF/video (list_assets; logos, stickers, b-roll), kind text = a line of text, kind audio = music or a sound effect (a library audio asset with a window in source seconds, volume, ducking, fade, loop). Replaces the whole list; null or [] = none. get_clip returns it`),
      overlays: z.array(clipOverlaySchema).max(MAX_CLIP_OVERLAYS).nullable().optional().describe(`Edits the asset and text half of layers (max ${MAX_CLIP_OVERLAYS}): kind asset = a library image/video (list_assets), kind text = a line of text (size, color, box). Replaces that half, keeps the sounds; null or [] = none`),
      audio: z.array(clipAudioSchema).max(MAX_CLIP_AUDIO).nullable().optional().describe(`Edits the audio half of layers (max ${MAX_CLIP_AUDIO}; the same asset may repeat): library audio assets (list_assets, kind audio), each with a window in source seconds, volume, ducking under speech, fades. Replaces that half, keeps the visuals; null or [] = none`),
      rerender: z.boolean().default(true).describe("Re-render when a burned-in field changed (default true); false = keep the old video until rerender_clip"),
    },
  },
  create_clip: {
    title: "Create clip",
    description: "Add a clip from a time range of the source (needs a transcript). mode exact keeps your bounds (3 s-10 min); mode ai lets the model pick the best moment inside them (≥8 s). Returns the new clip { id, status: \"preparing\" }; it gets a title and renders in the background (about a minute), so poll get_clip until done. To change an existing clip use update_clip instead.",
    inputSchema: {
      projectId: projectId(),
      startSec: z.number().min(0).describe("Range start, seconds from the start of the source video"),
      endSec: z.number().min(0).describe("Range end, seconds"),
      mode: z.enum(["exact", "ai"]).default("exact").describe("exact = these bounds (default); ai = best moment inside them"),
    },
  },
  delete_clip: {
    title: "Delete clip",
    description: "Delete one clip of your project; a render in progress stops. Reversible: restore_clip brings it back for DELETED_RETENTION_DAYS (7 days by default). Returns { changed, restorable }.",
    inputSchema: { id: clipId() },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  rerender_clip: {
    title: "Re-render clip",
    description: "Queue one clip for rendering again (after rerender: false edits, a failure, or an intro/outro change). Async: the new video replaces the old when done (usually under a minute); poll get_clip. Returns { step: render | prepare } (prepare = it never got its AI title, which runs first). For several clips of a project use rerender_clips.",
    inputSchema: { id: clipId("Clip id, not a project id") },
    annotations: { idempotentHint: true },
  },
  rerender_clips: {
    title: "Re-render clips",
    description: "Queue several clips of one project for rendering again in one step (after edits or failures). Finished and failed clips are queued, clips still rendering are skipped; each new video replaces the old when done. Returns { requested, rerendered, skipped }; poll get_project or wait_for_project. For a single clip rerender_clip is enough.",
    inputSchema: {
      projectId: projectId(),
      clipIds: z.array(z.string()).min(1).max(200).describe("Clip ids of that project (get_project), 1-200"),
    },
    annotations: { idempotentHint: true },
  },
  export_project: {
    title: "Export clips",
    description: "A download link for a zip of the project's rendered clips with YouTube/TikTok metadata. Returns { url, clips, notRendered }; the link needs the same Authorization header as this server.",
    inputSchema: {
      id: projectId(),
      clipIds: z.array(z.string()).max(200).optional().describe("Only these clips (max 200; must be rendered clips of the project); omitted = every rendered clip"),
    },
    annotations: { readOnlyHint: true },
  },
  report_issue: {
    title: "Report an issue",
    description:
      "A download link for an issue-report zip (the same file Report an issue in the app saves; admins may include instance-wide diagnostics). Returns { url, filename }; GET the url with the same Authorization header as this server. Admins may set instance true to include unfinished work, failed jobs, usage and error logs across every account, for queue, disk or machine problems that are not just one project. On hosted instances with telemetry, non-admins cannot download a zip.",
    inputSchema: {
      description: z.string().trim().min(3).max(2000).describe("What went wrong (a sentence is enough)"),
      projectId: z.string().optional().describe("Project the report is about (from list_projects); omit for an account- or instance-level report"),
      clipIds: z.array(z.string()).max(50).optional().describe("Clips the problem shows up in (from get_project)"),
      instance: z.boolean().default(false).describe("Admins only: include unfinished work, failed jobs, usage and error logs across every account"),
      logs: z.boolean().default(true).describe("Include this project's log lines (default true)"),
      system: z.boolean().default(true).describe("Include versions, machine resources, queue counts and recent errors (default true; ignored when not allowed)"),
      previews: z.boolean().default(true).describe("Include thumbnails and the selected clips' videos (default true)"),
      allClips: z.boolean().default(false).describe("Include every rendered clip (default false)"),
      source: z.boolean().default(false).describe("Include the source video file (default false)"),
    },
    annotations: { readOnlyHint: true },
  },
  retry_project: {
    title: "Retry project",
    description: "Resume a failed or stuck project from its furthest completed stage: re-render unfinished clips if there are clips, else pick clips, refine or transcribe again. Finished clips, the transcript and the source are kept. Returns { queue } (the stage restarted); then wait_for_project. To pick different clips use reanalyze_project instead.",
    inputSchema: { id: projectId() },
  },
  reanalyze_project: {
    title: "Re-analyze project",
    description: "Pick clips again from the existing transcript (needs one), optionally with new settings. Clips you created or edited are kept; untouched AI picks are replaced and restorable with restore_clip for a while. Returns { kept, replaced } at once; the picking runs in the background, so follow with wait_for_project. To only save settings use update_project; to resume a failure use retry_project.",
    inputSchema: { id: projectId(), settings: settingsInput.optional() },
  },

  // ── intro / outro library ────────────────────────────────────────────────

  list_assets: {
    title: "List library assets",
    description: "Your library: videos, images (GIF, SVG), music and sounds. Returns { assets: [{ id, name, kind, mime, owner, saved, tags, provenance, durationSec, isDefaultIntro, isDefaultOutro, usedBy, thumbnailUrl, url }], removed }. owner \"shared\" = a catalog or provider import every account uses (remove_asset only unsaves it; it cannot be renamed). Use the ids in update_clip layers, set_project_bumpers or set_default_bumper.",
    annotations: { readOnlyHint: true },
  },
  add_asset: {
    title: "Add library asset",
    description: "Add a video (MP4/MOV/WebM), image (PNG/JPG/WebP/GIF/SVG) or sound (MP3/M4A/AAC/WAV/OGG/FLAC) to your library from a public url or an uploadId, with optional tags. Returns { id, name, kind, mime, durationSec, duplicate, restored } (the same file twice returns the existing item). setDefault makes it your default intro/outro for NEW projects only.",
    inputSchema: addAssetInput,
  },
  search_library: {
    title: "Search catalog and providers",
    description:
      "Find sounds, icons, stickers, photos, videos and GIFs to add to your library. provider omitted = the Reelsaw catalog (CC0 / permissive; works offline); others (pexels, pixabay, freesound, iconify, openverse, giphy, klipy) appear when an admin enabled them. Returns { provider, items: [{ provider, externalId, name, kind, license, attribution, previewUrl, durationSec }], nextCursor, unavailable }. Nothing is added: pass provider + externalId to import_asset.",
    inputSchema: {
      q: z.string().max(200).describe("What to look for, e.g. \"whoosh\", \"arrow\", \"city at night\"; empty lists the catalog"),
      provider: z.string().min(1).max(40).optional().describe("reelsaw (default), pexels, pixabay, freesound, iconify, openverse, giphy or klipy"),
      kind: z.enum(["video", "image", "audio"]).optional().describe("Only this kind of result"),
      cursor: z.string().max(200).optional().describe("nextCursor from the previous page; omit for the first page"),
      limit: z.number().int().min(1).max(60).default(24).describe("Results per page (1-60, default 24)"),
      license: z.enum(["cc0", "by"]).optional().describe("freesound only: cc0 (default) or by (CC0 and CC-BY, attribution is stored)"),
    },
    annotations: { readOnlyHint: true },
  },
  import_asset: {
    title: "Import from catalog or provider",
    description:
      "Save one search_library result into your library: downloaded server-side (max 50 MB), catalog checksum verified, license and attribution recorded. The item is one shared copy per instance, so if it was imported before (by anyone) nothing is downloaded and duplicate is true. Returns { id, name, kind, mime, durationSec, duplicate, restored }; use the id in update_clip layers.",
    inputSchema: {
      provider: z.string().min(1).max(40).describe("The result's provider (search_library)"),
      externalId: z.string().min(1).max(200).describe("The result's externalId (search_library)"),
      color: z.string().max(9).optional().describe("iconify only: icon color as hex, e.g. #ffffff (default white)"),
      tags: z.array(z.string().trim().min(1).max(40)).max(30).optional().describe("Extra search tags for the library item"),
    },
  },
  update_asset: {
    title: "Update library asset",
    description: "Rename one of your own library items, replace its tags, or change how long a still image shows (removed items too; shared catalog and provider items cannot be changed). Only labels change; nothing re-renders, except that a new image length applies on each project's next render. Returns { id, name, tags, durationSec, previousName }.",
    inputSchema: {
      assetId: assetIdInput(),
      name: bumperNameSchema.optional().describe("New name (1-120 chars)"),
      tags: assetTagsSchema.optional().describe("Replaces the tags (lowercase words; max 20); [] clears them"),
      imageSeconds: z.number().min(1).max(10).optional().describe("Seconds a still image shows as an intro/outro (1-10); images only"),
    },
    annotations: { idempotentHint: true },
  },
  remove_asset: {
    title: "Remove library asset",
    description: "Remove an item from your library and from your defaults (a shared catalog or provider item is only unsaved). Projects and clips already using it keep rendering with it. Undo with restore_asset within 30 days; check asset_usage first. Returns { ok }.",
    inputSchema: { assetId: assetIdInput() },
    annotations: { destructiveHint: true },
  },
  restore_asset: {
    title: "Restore library asset",
    description: "Bring one of your removed library items back (list_assets shows them under removed); restoring an item that is not removed changes nothing. It does not become a default again. Returns { ok }.",
    inputSchema: { assetId: assetIdInput("list_assets → removed") },
    annotations: { idempotentHint: true },
  },
  asset_usage: {
    title: "Where a library asset is used",
    description: "The projects and clips that use a library item, as intro, outro, overlay or music (clips a re-analyze replaced are left out). Returns { projects: [{ id, title, slots, clips: [{ id, index, title, slots, via, overlays, music }] }] }: slots are the roles on that clip, via says whether through the project or the clip. Check before removing one.",
    inputSchema: { assetId: assetIdInput() },
    annotations: { readOnlyHint: true },
  },
  set_default_bumper: {
    title: "Set default intro/outro",
    description: "Make a library item your default intro or outro for projects you create from now on (assetId null clears it). Existing projects keep theirs; to change one use set_project_bumpers. Returns { ok }.",
    inputSchema: {
      slot: z.enum(["intro", "outro"]).describe("Which default to set"),
      assetId: z.string().min(1).max(100).nullable().describe("Library asset id (list_assets), or null for no default"),
    },
    annotations: { idempotentHint: true },
  },
  // old names, kept for one release: same handlers as the *_asset tools
  list_bumpers: {
    title: "List library assets (alias)",
    description: "(alias of list_assets) Your library: intros, outros, overlays, music and sounds. Returns { assets: [{ id, name, kind, mime, tags, durationSec, isDefaultIntro, isDefaultOutro, usedBy, usedByClips, thumbnailUrl, url }], removed: [...] }.",
    annotations: { readOnlyHint: true },
  },
  add_bumper: {
    title: "Add library asset (alias)",
    description: "(alias of add_asset) Add a video, image or sound to your library from a public url or an uploadId. Returns { id, name, kind, mime, durationSec, duplicate, restored }. setDefault makes it your default for NEW projects only.",
    inputSchema: addBumperInput,
  },
  rename_bumper: {
    title: "Rename library asset (alias)",
    description: "(alias of update_asset) Rename one of your library items (removed ones too). Only the label changes; nothing re-renders. Returns { id, name, previousName }.",
    inputSchema: { assetId: assetIdInput(), name: bumperNameSchema.describe("New name (1-120 chars)") },
    annotations: { idempotentHint: true },
  },
  remove_bumper: {
    title: "Remove library asset (alias)",
    description: "(alias of remove_asset) Remove an item from your library and from your defaults; projects and clips using it keep rendering. Undo with restore_asset within 30 days. Returns { ok }.",
    inputSchema: { assetId: assetIdInput() },
    annotations: { destructiveHint: true },
  },
  restore_bumper: {
    title: "Restore library asset (alias)",
    description: "(alias of restore_asset) Bring one of your removed library items back. Returns { ok }.",
    inputSchema: { assetId: assetIdInput("list_assets → removed") },
    annotations: { idempotentHint: true },
  },
  bumper_usage: {
    title: "Where a library asset is used (alias)",
    description: "(alias of asset_usage) The projects and clips that use a library item, as intro, outro, overlay or music. Returns { projects: [{ id, title, slots, clips: [{ id, index, title, slots, via, overlays, music }] }] }.",
    inputSchema: { assetId: assetIdInput() },
    annotations: { readOnlyHint: true },
  },
  set_project_bumpers: {
    title: "Set a project's intro/outro",
    description: "Set one project's intro and/or outro: \"default\" (your current default), \"none\", or a library asset id; a slot left out is untouched, and introSec/outroSec are saved with the project. Clips with their own choice (set_clip_bumpers) keep it. Applies on each clip's next render; rerender: true re-renders finished clips now. Returns { rerendered }. set_default_bumper changes future projects instead.",
    inputSchema: setProjectBumpersInput,
  },
  set_clip_bumpers: {
    title: "Set clips' intro/outro",
    description: "Override the intro and/or outro of up to 200 clips of one project: \"inherit\" (follow the project), \"none\", or a library asset id; a slot left out is untouched. rerender: true re-renders only these clips. Returns { updated, rerendered }.",
    inputSchema: setClipBumpersInput,
  },
  delete_project: {
    title: "Delete project",
    description: "Delete one of your projects and all its clips; work in progress stops. Reversible: restore_project brings it back for DELETED_RETENTION_DAYS (7 days by default), then it and its files are removed for good. Returns { changed, restorable, message }.",
    inputSchema: { id: projectId() },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  restore_project: {
    title: "Restore project",
    description: "Bring back a deleted project with its clips and files (find it with list_projects deleted: true); restoring a project that is not deleted changes nothing. A project that was processing comes back failed: retry_project resumes it. Returns { changed, status }.",
    inputSchema: { id: projectId("list_projects with deleted: true") },
    annotations: { idempotentHint: true },
  },
  restore_clip: {
    title: "Restore clip",
    description: "Bring back a deleted clip or one a re-analyze replaced (get_project lists them as replacedClips); it goes to the end of the project's clips. Returns { changed, status, needsRerender }; needsRerender means it never finished, so call rerender_clip.",
    inputSchema: { id: z.string().describe("Clip id (from get_project → replacedClips)") },
    annotations: { idempotentHint: true },
  },
  check_for_update: {
    title: "Check for update",
    description: "Admins only: is a newer Reelsaw published? Returns { current, latest: { version, url, publishedAt }, available, checkedAt, error, upgrade: { command, note, docsUrl } }; available is null when the running build is not a release (from source). The server checks every few hours; refresh: true asks GitHub again now.",
    inputSchema: { refresh: z.boolean().default(false).describe("true = ask GitHub now instead of returning the last answer (at most once a minute)") },
    annotations: { readOnlyHint: true },
  },
  get_instance_settings: {
    title: "Instance settings",
    description:
      "Admins only: the instance settings in force (sign-up mode, email verification, captcha, legal links, quotas, upload limits, retention, stall watchdog, update check, health details) and where each comes from. Returns { values, env, override, source: { KEY: \"env\" | \"db\" }, ignored: { KEY: reason }, groups, help, updatedAt, updatedBy }; secrets are masked.",
    annotations: { readOnlyHint: true },
  },
  list_workers: {
    title: "List workers",
    description:
      "Admins only: every Reelsaw process that has checked in (API, worker, or a combined app), with CPU, memory, disk (free/total MB; -1 free means unmeasurable), GPU, render slots, the queues it listens on, and the jobs it last reported. Returns { items, live, stale }; a process is stale when it has not checked in for 45 seconds. Hosted non-admins are refused.",
    annotations: { readOnlyHint: true },
  },
  get_failure: {
    title: "Get a failed project or clip",
    description:
      "Admins only: one failed project or clip (title, owner email, stage, full recorded reason, when). A clip whose project also failed is not returned — retry the project. Returns the item or null if it is gone (retried, deleted). Hosted non-admins are refused.",
    inputSchema: {
      kind: z.enum(["project", "clip"]).describe("project = the whole pipeline stopped; clip = one clip failed to prepare or render"),
      id: z.string().min(1).max(80).describe("Project id or clip id"),
    },
    annotations: { readOnlyHint: true },
  },
  get_queue: {
    title: "Queue summary",
    description:
      "Admins only: waiting, running and retrying job counts per pipeline stage, plus the jobs currently in flight (project title, attempt, started). Returns { queues, active, truncated, error? }. Failed work is list_failures, not this. Hosted non-admins are refused.",
    annotations: { readOnlyHint: true },
  },
  list_failures: {
    title: "List failed work",
    description:
      "Admins only: failed projects and clips across the instance (owner email, stage, reason, when). A failed project's clips are not listed separately — retry the project. Returns { items, nextCursor, total, limit, truncated }. Filter with q (substring of the error), stage, since (ISO time). Hosted non-admins are refused.",
    inputSchema: {
      q: z.string().max(200).optional().describe("Case-insensitive substring of the recorded error (e.g. disk, encoder, model)"),
      stage: z.enum(["ingest", "transcribe", "refine", "analyze", "render", "prepare"]).optional().describe("Pipeline stage that failed"),
      since: z.string().max(40).optional().describe("ISO timestamp; only failures updated at or after this time"),
      cursor: z.string().max(300).optional().describe("nextCursor from the previous page"),
      limit: z.number().int().min(1).max(50).optional().describe("Page size, default 50"),
    },
    annotations: { readOnlyHint: true },
  },
  retry_failures: {
    title: "Retry failed work",
    description:
      "Admins only: retry matching failed projects and clips through the same lifecycle as retry_project / rerender_clip (never a raw queue poke). Each item is its own transaction so live-job caps still apply. Cap 50 per call. Returns { retried, skipped, nextCursor }. Writes an admin event failures.retried. Hosted non-admins are refused.",
    inputSchema: {
      q: z.string().max(200).optional().describe("Same error substring as list_failures"),
      stage: z.enum(["ingest", "transcribe", "refine", "analyze", "render", "prepare"]).optional().describe("Same stage filter as list_failures"),
      since: z.string().max(40).optional().describe("Same since filter as list_failures"),
      ids: z
        .array(
          z.object({
            kind: z.enum(["project", "clip"]).describe("project = resume the whole project; clip = re-render or re-prepare one clip"),
            id: z.string().min(1).max(80).describe("Project id or clip id"),
          }),
        )
        .max(50)
        .optional()
        .describe("Retry these rows instead of the current filter; omitted = every match of q/stage/since"),
      limit: z.number().int().min(1).max(50).optional().describe("Max items to retry this call, default 50"),
    },
  },
  set_instance_settings: {
    title: "Change instance settings",
    description:
      "Admins only: change instance settings without a restart; every process applies them within seconds and the change is audited. Pass only the keys to change; null returns a key to the environment's value; an empty string clears an optional one (URLs, captcha). Validated as a whole (a captcha provider needs both keys; email verification needs an email driver). Returns the same state as get_instance_settings.",
    inputSchema: settingsPatchSchema.shape,
    annotations: { idempotentHint: true },
  },
  get_billing: {
    title: "Billing",
    description:
      "Hosted instances: your plan and subscription, the billing period, the limits in force with where each comes from (instance, plan, an admin's override), what you have used this period, whether renders carry a watermark, and the plans on offer. Returns { enabled, plan, reason, subscription, period, limits, limitSource, usage, watermark, canManage, plans }. On a self-hosted Reelsaw this answers that billing is not enabled.",
    annotations: { readOnlyHint: true },
  },
  billing_checkout_url: {
    title: "Checkout URL",
    description:
      "Hosted instances: a Stripe Checkout URL for a plan (or, when the account already pays, the Billing Portal page that confirms the plan change). Returns { url, kind: \"checkout\" | \"change\" }; a person must open it in a browser, an agent cannot pay. Plans and intervals come from get_billing.",
    inputSchema: {
      plan: z.string().min(1).max(40).describe("Plan name from get_billing (e.g. creator, pro)"),
      interval: z.enum(["month", "year"]).default("month").describe("Billing interval: month (default) or year"),
    },
  },
};

export type ToolName = keyof typeof TOOLS;
/** Tools that only do something on a hosted instance with billing (ee); elsewhere they answer with a sentence. */
export const EE_TOOLS: ToolName[] = ["get_billing", "billing_checkout_url"];
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];
