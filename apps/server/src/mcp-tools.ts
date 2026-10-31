/**
 * The MCP tool catalogue: names, descriptions and input schemas of every tool Reelsaw exposes.
 * `mcp.ts` binds them to the tRPC procedures for `/api/mcp`; `mcp-stdio.ts` registers the same
 * catalogue over stdio and forwards calls to a running instance. One list, so the two surfaces
 * cannot drift (`test/mcp.test.ts` checks they advertise the same tools and schemas).
 */
import { z } from "zod";
import {
  DECISION_KINDS,
  CLEARABLE_SETTINGS,
  layerTemplateNameSchema,
  layerTemplateLayersSchema,
  projectSettingsPatchSchema,
  userProjectDefaultsSchema,
  reframeModeSchema,
  layoutSectionSchema,
  styleOverrideSchema,
  clipLayerSchema,
  assetTagsSchema,
  MAX_CLIP_LAYERS,
  REFINE_STEPS,
  projectMetadataSchema,
} from "@reelsaw/shared";
import { applyLayerTemplateInput, saveLayerTemplateInput, templateIdSchema } from "./library/templates.js";
import { addAssetInput, bumperNameSchema, setClipBumpersInput, setProjectBumpersInput } from "./library/service.js";
import { templateBumpersSchema } from "@reelsaw/shared";
import { settingsPatchSchema } from "./instance-settings.js";
import { WEBHOOK_DELIVERY_STATUSES, WEBHOOK_EVENT_TYPES } from "./db/schema.js";

export const INSTRUCTIONS = `Reelsaw turns long-form videos into vertical short clips (transcribe → find moments → reframe, caption, render).
Workflow: create_project(sourceUrl, or uploadId from POST /api/upload) → wait_for_project (call again until done; a 30-min video takes several minutes) → get_project for the clips → get_clip for download links.
Which tool when:
- inspect: get_project (state + all clips), get_clip (one clip in full), get_transcript (the words, timed), get_project_events (what happened and why), list_deleted (restorable projects, clips, library, templates), list_releases (GitHub changelog), report_issue (zip of a project, or instance-wide diagnostics for admins); admins: get_failure for one failed project or clip's full reason
- fix the transcript: list_transcript_flags (the automatic and suggested fixes with ids), review_transcript_flags (accept or reject them), add_transcript_correction (captions say other words for a span), add_transcript_cut (drop a span from the video)
- change: update_clip (one clip's text, bounds, framing, style, layers), create_clip (a new moment from a time range), update_project (title and settings, nothing re-run), update_project_style (caption look for every clip, re-renders), set_project_source_text (hide or keep text burned into the source, re-renders), reanalyze_project (pick clips again); get_project_defaults / set_project_defaults (the settings every new project starts with)
- reuse a look: save_layer_template (from a clip) then apply_layer_template (to clips); layerTemplateId in update_project covers future clips only. One framing for the whole video (slides, a fixed camera): set it on one clip with update_clip, then apply_framing
- recover: retry_project (resume a failed project where it stopped) vs reanalyze_project (different clips); render: rerender_clip (one clip) vs rerender_clips (many clips of a project)
Your library (search_assets, add_asset, update_asset, delete_asset, restore_asset, asset_usage) holds videos, images, GIFs, SVGs and sounds. Bumpers are short intro/outro videos or images (max 10 s) from it that are joined around every clip; set one as your default for new projects (set_default_bumper), per project (set_project_bumpers) or per clip (set_clip_bumpers). Bumpers are burned into the rendered video, so a change only shows after a re-render: pass rerender: true to re-render just the affected clips. The same library items go on a clip as layers over a time range: update_clip { layers: [{ kind: "asset", id, assetId, start, end, x, y, w }, { kind: "text", id, text, start, end, x, y, size, color, box }, { kind: "audio", id, assetId, start, end, volume, duck, fade, loop }] } (a sound effect is an audio layer with loop false, duck false, fade 0).
Layer templates (list_layer_templates, save_layer_template, update_layer_template, delete_layer_template, restore_layer_template, apply_layer_template) are sets of layers whose timing fits any clip length (head = first seconds, tail = last seconds, fill = whole clip, relative = fractions of the clip), optionally with an intro and outro: save one from a clip you styled, then apply_layer_template puts it on chosen clips (clips keep their own copy of the layers and get the template's intro / outro as their own choice), and update_project { settings: { layerTemplateId } } gives every clip created afterwards the template.
Deleting is reversible for a while: delete_project, delete_clip / delete_clips and the clips a reanalyze_project replaces can be brought back (restore_project, restore_clip); clips you made or edited survive a re-analyze. list_deleted is the Deleted page: one list of projects, clips of live projects, library items and templates with when they auto-remove. A deleted item still counts toward storage until you purge it (purge_project, purge_clip, purge_asset, purge_layer_template) or the retention sweep does; minutes, hourly creates and first-video-free are never refunded.
Reelsaw learns from what you decide: accepts, rejects, cuts, corrections and clip edits go in your decision log (list_decisions, export_decisions for evals), which outlives deleted projects; forget_decisions or purge_project forgetDecisions: true removes entries, set_learning turns recording off.
You only see and change your own projects and library. Admins may pass instance: true on report_issue to include unfinished work and errors across the instance. All ids are strings. Times are seconds from the start of the source video. Media URLs need the same Authorization header as this server; get_media_links gives share links that need none (for schedulers, Instagram, Zapier).`;

const projectDefaultsShape = userProjectDefaultsSchema.omit({ introAssetId: true, outroAssetId: true }).shape;
const projectDefaultsInput = z
  .object({
    language: projectDefaultsShape.language.describe("Spoken language code, e.g. en"),
    vocabulary: projectDefaultsShape.vocabulary.describe("Names and terms the transcript should spell right"),
    instructions: projectDefaultsShape.instructions.describe("Standing instructions for picking clips"),
    focus: projectDefaultsShape.focus.describe("What to look for in a clip"),
    pauses: projectDefaultsShape.pauses.describe("Pause trimming: off, natural or tight"),
    sourceText: projectDefaultsShape.sourceText.describe("On-screen text in the source: hide, keep or always"),
    minClipSeconds: projectDefaultsShape.minClipSeconds.describe("Shortest clip, seconds (5-180)"),
    maxClipSeconds: projectDefaultsShape.maxClipSeconds.describe("Longest clip, seconds (10-300)"),
    maxClips: projectDefaultsShape.maxClips.describe("Most clips to pick (1-50)"),
    highlightColor: projectDefaultsShape.highlightColor.describe("Caption highlight color, #rrggbb"),
    wordsPerLine: projectDefaultsShape.wordsPerLine.describe("Caption words per line (1-8)"),
    uppercase: projectDefaultsShape.uppercase.describe("Upper-case captions"),
    refineEntities: projectDefaultsShape.refineEntities.describe("Fix misheard names"),
    refineDisfluency: projectDefaultsShape.refineDisfluency.describe("Remove fillers and repetitions"),
    disfluencyLlm: projectDefaultsShape.disfluencyLlm.describe("Use the language model for filler removal"),
    refineScenes: projectDefaultsShape.refineScenes.describe("Scan the video for on-screen text and scene cuts"),
    layerTemplateId: projectDefaultsShape.layerTemplateId.describe("Layer template new clips start with (from list_layer_templates)"),
  })
  .partial();

const settingsInput = projectSettingsPatchSchema.describe(
  "Project settings; omit for the defaults (automatic clip count, 20–60 s clips, natural pauses, name fixes and the on-screen text scan on, filler removal off). Set refineDisfluency / disfluencyLlm true to opt into filler removal, refineEntities / refineScenes false to skip those steps (instance Pipeline gates must be on).",
);

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
const assetIdInput = (from = "search_assets") => z.string().min(1).max(100).describe(`Library asset id (from ${from})`);

export const TOOLS = {
  list_projects: {
    title: "List projects",
    description:
      'Your projects, most recently updated first. Returns { projects: [{ id, title, status, stage, clips: "n/m rendered", url }], total, nextCursor }; pass nextCursor as cursor for the next page. deleted: true lists restorable deletes (storedBytes still count until purge_project). For every kind of restorable delete (projects, clips, library, templates) use list_deleted. Use get_project for one project\'s clips, search_clips to find by words.',
    inputSchema: {
      cursor: z.string().optional().describe("nextCursor from the previous page; omit for the first page"),
      limit: z.number().int().min(1).max(100).default(24).describe("Projects per page (1-100, default 24)"),
      deleted: z.boolean().optional().describe("true = only deleted projects that restore_project can still bring back"),
    },
    annotations: { readOnlyHint: true },
  },
  get_project: {
    title: "Get project",
    description:
      "One of your projects: status, settings, effective intro/outro, transcript summary, and every clip (id, title, hook, bounds, score, status, download links); replacedClips lists deleted or replaced clips for restore_clip. Returns the project object. For one clip's full detail use get_clip, for the words get_transcript, for the pipeline history get_project_events.",
    inputSchema: { id: projectId() },
    annotations: { readOnlyHint: true },
  },
  create_project: {
    title: "Create project",
    description:
      'Start clipping a video from a URL (anything yt-dlp fetches) or a file you uploaded: POST /api/upload with the file as the body, header x-filename and your API key as Authorization: Bearer, then pass the uploadId it returns. Returns { id, title, status: "queued", next } at once; the pipeline (download, transcribe, pick, render) runs in the background for minutes, so follow with wait_for_project(id). Intro/outro default to your library defaults unless introAssetId/outroAssetId say otherwise.',
    inputSchema: {
      sourceUrl: z.url().optional().describe("http(s) URL of the video; give this or uploadId"),
      uploadId: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe("Id returned by POST /api/upload (the file body, x-filename header, API key as Bearer); give this or sourceUrl"),
      title: z.string().min(1).max(200).optional().describe("Project title (default: the video's own title)"),
      metadata: projectMetadataSchema
        .optional()
        .describe('Your own key/value strings (≤20 keys, 1 KB), returned by get_project and sent in every webhook for this project, e.g. { runId: "n8n-123" }'),
      settings: settingsInput.optional(),
      introAssetId: z
        .string()
        .min(1)
        .max(100)
        .nullable()
        .optional()
        .describe("Library asset id (search_assets with source library) for the intro of every clip; null = no intro; omitted = your default intro"),
      outroAssetId: z.string().min(1).max(100).nullable().optional().describe("Same for the outro"),
      introSec: z.number().min(1).max(10).optional().describe("Seconds an intro image shows (1-10)"),
      outroSec: z.number().min(1).max(10).optional().describe("Seconds an outro image shows (1-10)"),
    },
  },
  update_project: {
    title: "Update project",
    description:
      "Rename a project and/or change its saved settings (focus, instructions, clip length, maxClips, caption style, framing, pauses, refineEntities, refineDisfluency, disfluencyLlm, refineScenes); only the fields you pass change. Does not re-pick clips or re-render: reanalyze_project picks again with the new selection settings, refine_project re-runs refine steps, rerender_clips applies style changes. Returns { changed, needsReanalyze, needsRefine, needsRerender, hint }.",
    inputSchema: {
      id: projectId(),
      title: z.string().trim().min(1).max(200).optional().describe("New title"),
      settings: projectSettingsPatchSchema
        .optional()
        .describe("Settings to change; keys left out keep their value. Intro/outro go through set_project_bumpers"),
      clear: z
        .array(z.enum(CLEARABLE_SETTINGS))
        .max(CLEARABLE_SETTINGS.length)
        .optional()
        .describe("Optional settings to reset to their default, e.g. maxClips (back to automatic) or focus"),
      metadata: projectMetadataSchema.optional().describe("Replace the project's metadata (the whole map; {} clears it)"),
    },
    annotations: { idempotentHint: true },
  },
  wait_for_project: {
    title: "Wait for project",
    description:
      'Block until the project is done or failed, or timeoutSeconds pass. Returns { id, status, stage, stageProgress, stageDetail ({ done, total, etaSec } while a stage works in parts, else null), error, clips: [{ id, title, status }] }; on timeout the same with hint "Still running": call it again. Use get_project instead for a non-blocking look with full clip details.',
    inputSchema: {
      id: projectId("create_project or list_projects"),
      timeoutSeconds: z.number().int().min(1).max(120).default(60).describe("Longest to wait, seconds (1-120, default 60)"),
    },
    annotations: { readOnlyHint: true },
  },
  get_transcript: {
    title: "Get transcript",
    description:
      'The project\'s transcript as timed lines "[m:ss] text", optionally only a time range. Returns text; output longer than maxChars is cut with a note saying which fromSec to continue from. Use it to pick your own moments for create_clip.',
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
    description:
      "The captions of a clip's last render as an SRT or WebVTT file: the same lines and times as the video (intro included), even when the style has captions off. Returns the file text; VTT with words: true adds karaoke word timestamps. A clip rendered before caption files existed answers that it needs a re-render (rerender_clip).",
    inputSchema: {
      id: clipId(),
      format: z.enum(["srt", "vtt"]).default("srt").describe("srt (default) or vtt"),
      words: z.boolean().default(false).describe("VTT only: add a <timestamp> before every word after the first in each cue"),
    },
    annotations: { readOnlyHint: true },
  },
  get_project_transcript_file: {
    title: "Get transcript file",
    description:
      "The project transcript as an SRT or WebVTT subtitle file, one cue per transcript segment, in source-video seconds. Returns the file text; VTT with words: true adds word timestamps. Use get_transcript to read it as plain timed lines instead.",
    inputSchema: {
      id: projectId(),
      format: z.enum(["srt", "vtt"]).default("srt").describe("srt (default) or vtt"),
      words: z.boolean().default(false).describe("VTT only: add a <timestamp> before every word after the first in each cue"),
    },
    annotations: { readOnlyHint: true },
  },
  import_transcript: {
    title: "Import transcript",
    description:
      "Use an SRT or WebVTT file as the project's transcript instead of transcribing: right after create_project (only the video is fetched) or on a done or failed project (it then re-cleans the transcript and picks clips again). Give exactly one of text, uploadId or url. Returns { format, cues, words, warnings, message }; follow with wait_for_project.",
    inputSchema: {
      id: projectId(),
      text: z
        .string()
        .max(10 * 1024 * 1024)
        .optional()
        .describe("The contents of the .srt or .vtt file"),
      uploadId: z.string().optional().describe("Upload id of an .srt/.vtt file sent to POST /api/upload"),
      url: z.url().optional().describe("http(s) link to a public .srt/.vtt file"),
      format: z.enum(["auto", "srt", "vtt"]).default("auto").describe("auto (default) decides from the WEBVTT header"),
      language: z.string().min(2).max(12).optional().describe("Language code of the text, e.g. en, es, ja (default: the existing transcript's, else unknown)"),
    },
  },
  search_clips: {
    title: "Search clips",
    description:
      "Find your clips and projects by words in their title, hook or caption (every word must match; case-insensitive, typo-tolerant; best first). Returns { projects (max 8), clips (max limit) with ids, bounds and links, truncated? }. Use list_projects to browse instead.",
    inputSchema: {
      q: z.string().min(1).max(200).describe('Words to find, e.g. "budget tips"'),
      limit: z.number().int().min(1).max(50).default(15).describe("Most clips to return (1-50, default 15)"),
    },
    annotations: { readOnlyHint: true },
  },
  get_project_events: {
    title: "Project activity",
    description:
      "The project's pipeline history, newest first (the same events the Activity panel shows; live progress ticks are not stored): stage starts and completions, clip renders, retries, failures with reasons. Returns [{ at, type, ...details }]. Use it to find out why something failed or is slow; get_project shows the current state.",
    inputSchema: {
      id: projectId(),
      limit: z.number().int().min(1).max(200).default(50).describe("Most events to return (1-200, default 50)"),
    },
    annotations: { readOnlyHint: true },
  },
  get_clip: {
    title: "Get clip",
    description:
      "Everything about one clip: text, bounds, scores, emphasis, layers (assets, text, sounds), render diagnostics, video/thumbnail/editor links, and what the next render will use with where each comes from: style { own, effective, from: clip|project|default }, framing { own, effective: { mode, adjust, sections }, from }, bumpers { own, effective } (intro/outro). Returns the clip object. get_project lists all clips in brief; poll this after an edit to see the render finish (status done).",
    inputSchema: { id: clipId() },
    annotations: { readOnlyHint: true },
  },
  update_clip: {
    title: "Update clip",
    description:
      "Edit one clip (3 s-10 min): only the fields you pass change; style, layoutSections and layers replace the whole value (null = project's / none). Title, caption and hashtags apply at once; bounds, hook, framing, style, emphasis, layers and intro/outro are burned in and re-render (~1 min) unless rerender is false. Returns the clip summary plus { changed, needsRerender, rerendered, hint }; poll get_clip until done.",
    inputSchema: {
      id: clipId(),
      title: z.string().min(1).max(120).optional().describe("Clip title (1-120 chars)"),
      hook: z.string().max(80).optional().describe("On-screen opening line (max 80 chars)"),
      caption: z.string().max(300).optional().describe("Post caption, not burned in (max 300 chars)"),
      hashtags: z.array(z.string().min(1).max(40)).max(20).optional().describe("Hashtags without # (max 20); replaces the list"),
      startSec: z.number().min(0).optional().describe("New start, seconds from the start of the source video"),
      endSec: z.number().min(0).optional().describe("New end, seconds from the start of the source; clip must stay ≥3 s"),
      layoutOverride: reframeModeSchema.nullable().optional().describe("Framing for the whole clip; null = automatic"),
      layoutSections: z
        .array(layoutSectionSchema)
        .max(50)
        .nullable()
        .optional()
        .describe("Framing per time range (max 50), source seconds; replaces all sections; null or [] = automatic"),
      style: styleOverrideSchema
        .nullable()
        .optional()
        .describe("Caption/hook style for this clip on top of the project's; replaces the clip's override; null = follow the project"),
      emphasis: z.array(z.string().min(1).max(40)).max(30).optional().describe("Words the captions colour (max 30); replaces the list"),
      layers: z
        .array(clipLayerSchema)
        .max(MAX_CLIP_LAYERS)
        .nullable()
        .optional()
        .describe(
          `Everything laid over or played under the clip, one list (max ${MAX_CLIP_LAYERS}): kind asset = a library image/GIF/video (search_assets with source library; logos, stickers, b-roll), kind text = a line of text, kind audio = music or a sound effect (a library audio asset with a window in source seconds, volume, ducking, fade, loop). Replaces the whole list; null or [] = none. get_clip returns it`,
        ),
      rerender: z
        .boolean()
        .default(true)
        .describe("Re-render when a burned-in field changed (default true, same as the app); false = keep the old video until rerender_clip"),
    },
  },
  create_clip: {
    title: "Create clip",
    description:
      'Add a clip from a time range of the source (needs a transcript). mode exact keeps your bounds (3 s-10 min); mode ai lets the model pick the best moment inside them (≥8 s). Returns the new clip summary { id, status: "preparing", queued: "prepare", hint }; preparation (title, hook, scores) is queued and the render follows by itself (about a minute), so poll get_clip until done. To change an existing clip use update_clip instead.',
    inputSchema: {
      projectId: projectId(),
      startSec: z.number().min(0).describe("Range start, seconds from the start of the source video"),
      endSec: z.number().min(0).describe("Range end, seconds"),
      mode: z.enum(["exact", "ai"]).default("exact").describe("exact = these bounds (default); ai = best moment inside them"),
    },
  },
  delete_clip: {
    title: "Delete clip",
    description:
      "Delete one clip of a live project; a render in progress stops. It shows up on Deleted (list_deleted). Reversible: restore_clip brings it back for DELETED_RETENTION_DAYS (7 days by default). Storage still counts until purge_clip. For several clips of one project use delete_clips. Returns { changed, stoppedRender (a render in flight was stopped), renderQueued: false, restorable, storedBytes }.",
    inputSchema: { id: clipId() },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  delete_clips: {
    title: "Delete clips",
    description:
      "Delete several clips of one live project in one step (the selection bar's Delete); renders in progress stop. Each shows up on Deleted (list_deleted) and restore_clip brings it back for DELETED_RETENTION_DAYS. Already-deleted ids are skipped. Storage still counts until purge_clip. Returns { deleted, skipped, stoppedRenders, renderQueued: false, restorable, storedBytes }.",
    inputSchema: {
      projectId: projectId(),
      clipIds: z.array(z.string()).min(1).max(200).describe("Clip ids of that project (get_project), 1-200"),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  rerender_clip: {
    title: "Re-render clip",
    description:
      "Queue one clip for rendering again (after rerender: false edits, a failure, or an intro/outro change). Async: the new video replaces the old when done (usually under a minute); poll get_clip. Returns { step: render | prepare, renderQueued, hint } (prepare = it never got its AI title, which runs first and renders afterwards). For several clips of a project use rerender_clips.",
    inputSchema: { id: clipId("Clip id, not a project id") },
    annotations: { idempotentHint: true },
  },
  rerender_clips: {
    title: "Re-render clips",
    description:
      "Queue several clips of one project for rendering again in one step (after edits or failures). Finished and failed clips are queued, clips still rendering are skipped; each new video replaces the old when done. Returns { requested, rerendered, skipped, renderQueued, hint }; poll get_project or wait_for_project. For a single clip rerender_clip is enough.",
    inputSchema: {
      projectId: projectId(),
      clipIds: z.array(z.string()).min(1).max(200).describe("Clip ids of that project (get_project), 1-200"),
    },
    annotations: { idempotentHint: true },
  },
  get_media_links: {
    title: "Get share links",
    description:
      "Links anyone can download without an Authorization header, for a scheduler (Buffer, Metricool), Instagram's video_url, Zapier/Make or a person. Returns { clips: [{ clipId, links: { clip, thumb, srt, vtt } }], export } with each link's { linkId, url, expiresAt }; unrendered clips say why. The active link is reused unless label or ttlDays ask for a separate one. A link serves the current render until it expires or revoke_media_link turns it off.",
    inputSchema: {
      projectId: projectId(),
      clipIds: z.array(z.string()).max(50).optional().describe("Only these clips; omitted = every rendered clip"),
      kinds: z
        .array(z.enum(["clip", "thumb", "srt", "vtt"]))
        .max(4)
        .optional()
        .describe("Which files (default: clip): clip = the MP4, thumb = its JPEG, srt / vtt = its captions"),
      export: z.boolean().optional().describe("Also a link to the zip of these clips with YouTube/TikTok metadata"),
      ttlDays: z
        .number()
        .int()
        .min(1)
        .max(3650)
        .nullable()
        .optional()
        .describe("Days the links last (capped by the instance); null = never expires where allowed"),
      label: z.string().trim().max(120).optional().describe('A name for a separate link you can revoke on its own, e.g. "Buffer queue"'),
    },
  },
  list_media_links: {
    title: "List share links",
    description:
      "Your share links, newest first. Returns { items: [{ id, kind, projectId, clipId, title, url (masked), label, source, state (active | expired | revoked), expiresAt, lastUsedAt, useCount }], nextCursor, total }. Use get_media_links for a full URL.",
    inputSchema: {
      projectId: z.string().optional().describe("Only this project's links"),
      clipId: z.string().optional().describe("Only this clip's links"),
      active: z.boolean().optional().describe("Only links that still work"),
      cursor: z.string().optional().describe("nextCursor from the previous page"),
      limit: z.number().int().min(1).max(100).default(50).describe("Links per page (1-100)"),
    },
    annotations: { readOnlyHint: true },
  },
  revoke_media_link: {
    title: "Revoke share links",
    description:
      "Turn share links off now: one (linkId), a clip's (clipId), a project's (projectId) or all of yours (all: true). Give exactly one. Returns { revoked, message }. Anyone holding a revoked link gets a 404 from then on.",
    inputSchema: {
      linkId: z.string().optional().describe("Link id (from get_media_links or list_media_links)"),
      clipId: z.string().optional().describe("Every link to this clip"),
      projectId: z.string().optional().describe("Every link to this project's clips and zip"),
      all: z.literal(true).optional().describe("Every share link you have"),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  list_webhooks: {
    title: "List webhooks",
    description:
      "Your webhook endpoints. Returns [{ id, url (masked), description, events, status (active | failing | off), disabledReason, failingSince, lastDelivery }]. Reelsaw POSTs signed JSON (Standard Webhooks headers webhook-id, webhook-timestamp, webhook-signature) to each when a subscribed event happens.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  create_webhook: {
    title: "Create webhook",
    description:
      "Subscribe a URL to events: project.created, project.done (with every clip, share links and the zip), project.failed, clip.done (also re-renders), clip.failed. This is how a Zapier or Make app subscribes (delete_webhook unsubscribes). Returns { endpoint, secret }: the whsec_ signing secret is shown only here; verify deliveries with any Standard Webhooks library. The URL must be public https unless the admin allows private networks.",
    inputSchema: {
      url: z.string().min(1).max(2000).describe("Where to POST (https)"),
      events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).describe("Events to send"),
      description: z.string().trim().max(120).optional().describe('Your label, e.g. "n8n clips workflow"'),
    },
  },
  update_webhook: {
    title: "Update webhook",
    description:
      "Change a webhook's url, events or description, or turn it on or off (enabled). Turning it on clears a failure streak; turning it off cancels deliveries waiting to be sent (resend_webhook_delivery brings them back). Returns { endpoint, changed, message }.",
    inputSchema: {
      id: z.string().describe("Webhook id (from list_webhooks)"),
      url: z.string().min(1).max(2000).optional().describe("New URL to POST to (https)"),
      events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).optional().describe("Replace the events it gets"),
      description: z.string().trim().max(120).nullable().optional().describe("New label; null clears it"),
      enabled: z.boolean().optional().describe("Turn it on (true) or off (false)"),
    },
    annotations: { idempotentHint: true },
  },
  delete_webhook: {
    title: "Delete webhook",
    description: "Remove a webhook (unsubscribe); nothing more is sent to it and its delivery log goes with it. Returns { ok, message }.",
    inputSchema: { id: z.string().describe("Webhook id (from list_webhooks)") },
    annotations: { destructiveHint: true },
  },
  rotate_webhook_secret: {
    title: "Rotate webhook secret",
    description:
      "A new signing secret for a webhook. Deliveries are signed with both the new and the old one for 24 h, so the receiver can switch. Returns { secret, previousStopsAt, message }.",
    inputSchema: { id: z.string().describe("Webhook id (from list_webhooks)") },
  },
  test_webhook: {
    title: "Test webhook",
    description: "Send a webhook.test delivery now and wait for the answer. Returns { ok, code, message, response (first 2 KB of what the receiver said) }.",
    inputSchema: { id: z.string().describe("Webhook id (from list_webhooks)") },
  },
  list_webhook_deliveries: {
    title: "List webhook deliveries",
    description:
      "The delivery log, newest first. Returns { items: [{ id, endpointId, eventId, type, projectId, status (pending | sending | delivered | failed | cancelled), attempt, lastStatusCode, lastError, nextAttemptAt, deliveredAt }], nextCursor, total }. Failed deliveries were retried 8 times over about 22 h.",
    inputSchema: {
      endpointId: z.string().optional().describe("Only this webhook's deliveries (from list_webhooks)"),
      status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional().describe("Only deliveries in this state"),
      projectId: z.string().optional().describe("Only deliveries about this project"),
      cursor: z.number().int().positive().optional().describe("nextCursor from the previous page"),
      limit: z.number().int().min(1).max(100).default(50).describe("Deliveries per page (1-100)"),
    },
    annotations: { readOnlyHint: true },
  },
  resend_webhook_delivery: {
    title: "Resend webhook delivery",
    description:
      "Send a delivery again (a new series of attempts, same webhook-id and body, signed afresh). The webhook must be on. Returns { ok, deliveryId, message }.",
    inputSchema: { deliveryId: z.number().int().positive().describe("Delivery id (from list_webhook_deliveries)") },
  },
  export_project: {
    title: "Export clips",
    description:
      "A download link for a zip of the project's rendered clips with YouTube/TikTok metadata. Same conditions as the app's Export: the project must be live and at least one picked clip rendered, else the answer says why (not found, or nothing rendered yet). Returns { url, clips (rendered, in the zip), notRendered (picked but not finished, left out) }; the link needs the same Authorization header as this server.",
    inputSchema: {
      id: projectId(),
      clipIds: z
        .array(z.string())
        .max(200)
        .optional()
        .describe("Only these clips (max 200; must be rendered clips of the project); omitted = every rendered clip"),
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
      system: z
        .boolean()
        .default(true)
        .describe("Include versions, machine resources, queue counts and recent errors (default true; ignored when not allowed)"),
      previews: z.boolean().default(true).describe("Include thumbnails and the selected clips' videos (default true)"),
      allClips: z.boolean().default(false).describe("Include every rendered clip (default false)"),
      source: z.boolean().default(false).describe("Include the source video file (default false)"),
    },
    annotations: { readOnlyHint: true },
  },
  retry_project: {
    title: "Retry project",
    description:
      "Resume a failed or stuck project from its furthest completed stage: re-render unfinished clips if there are clips, else pick clips, refine or transcribe again. Finished clips, the transcript and the source are kept. Returns { queue } (the stage restarted); then wait_for_project. To pick different clips use reanalyze_project instead.",
    inputSchema: { id: projectId() },
  },
  refine_project: {
    title: "Refine project",
    description:
      "Re-run refine steps on the existing transcript: entities (name spelling), disfluency (filler and repeat cuts), scenes (shot cuts); all three when steps is omitted. Optionally set the vocabulary (names and terms, comma separated; empty string clears it) first. Fixes you accepted or rejected may be replaced. Clips re-render afterwards. Returns { ok, steps }; then wait_for_project.",
    inputSchema: {
      id: projectId(),
      steps: z.array(z.enum(REFINE_STEPS)).min(1).optional().describe("Which refine steps to re-run; default all"),
      vocabulary: z.string().max(1000).optional().describe("Names and terms the transcript should spell this way; empty string clears it"),
    },
  },
  reanalyze_project: {
    title: "Re-analyze project",
    description:
      "Pick clips again from the existing transcript (needs one), optionally with new settings. Clips you created or edited are kept; untouched AI picks are replaced and restorable with restore_clip for a while. Returns { kept, replaced } at once; the picking runs in the background, so follow with wait_for_project. To only save settings use update_project; to resume a failure use retry_project.",
    inputSchema: { id: projectId(), settings: settingsInput.optional() },
  },

  // ── intro / outro library ────────────────────────────────────────────────

  search_assets: {
    title: "Search library, catalog and providers",
    description:
      'Find assets. source "library" = your own uploads (name and tags; empty q lists all); omitted or "catalog" = the Reelsaw catalog (CC0, works offline); or a provider an admin enabled. Returns { provider, items: [{ provider, externalId, name, kind, license, durationSec }], nextCursor }. Adds nothing: a catalog / provider hit\'s provider + externalId go to add_asset.',
    inputSchema: {
      q: z.string().max(200).default("").describe('What to look for, e.g. "whoosh", "arrow", "city at night"; empty lists everything in the source'),
      source: z.string().min(1).max(40).optional().describe("library, catalog (default), pexels, pixabay, freesound, iconify, openverse, giphy or klipy"),
      kind: z.enum(["video", "image", "audio"]).optional().describe("Only this kind of result"),
      cursor: z.string().max(200).optional().describe("nextCursor from the previous page; omit for the first page"),
      limit: z.number().int().min(1).max(60).default(24).describe("Results per page (1-60, default 24)"),
      license: z.enum(["cc0", "by"]).optional().describe("freesound only: cc0 (default) or by (CC0 and CC-BY, attribution is stored)"),
      deleted: z.boolean().optional().describe("library only: list your deleted items instead (their ids go to restore_asset)"),
    },
    annotations: { readOnlyHint: true },
  },
  add_asset: {
    title: "Add library asset",
    description:
      "Add from exactly one source: a public url or an uploadId (video, image, GIF, SVG or sound) becomes one of your library uploads; a search_assets catalog / provider hit (provider + externalId) materializes one instance-shared copy (checksum verified, license recorded; not listed in your library). Returns { id, name, kind, mime, durationSec, duplicate, restored, owner } (the same file twice returns the existing item). setDefault on an upload makes it your default intro/outro for NEW projects only.",
    inputSchema: addAssetInput,
  },
  update_asset: {
    title: "Update library asset",
    description:
      "Rename one of your own library items, replace its tags, or change how long a still image shows (deleted items too; shared catalog and provider items cannot be changed). Only labels change; nothing re-renders, except that a new image length applies on each project's next render. Returns { id, name, tags, durationSec, previousName }.",
    inputSchema: {
      assetId: assetIdInput(),
      name: bumperNameSchema.optional().describe("New name (1-120 chars)"),
      tags: assetTagsSchema.optional().describe("Replaces the tags (lowercase words; max 20); [] clears them"),
      imageSeconds: z.number().min(1).max(10).optional().describe("Seconds a still image shows as an intro/outro (1-10); images only"),
    },
    annotations: { idempotentHint: true },
  },
  delete_asset: {
    title: "Delete library asset",
    description:
      "Delete one of your uploads: it leaves the library and your defaults and goes to Deleted. Projects and clips already using it keep rendering with it. Undo with restore_asset (list_deleted says how long it is kept); check asset_usage first. Returns { ok }.",
    inputSchema: { assetId: assetIdInput() },
    annotations: { destructiveHint: true },
  },

  restore_asset: {
    title: "Restore library asset",
    description:
      "Bring one of your deleted library items back (the id from delete_asset or list_deleted); restoring an item that is not deleted changes nothing. It does not become a default again. Returns { ok }.",
    inputSchema: { assetId: assetIdInput("delete_asset") },
    annotations: { idempotentHint: true },
  },
  asset_usage: {
    title: "Where a library asset is used",
    description:
      "Where a library item is used: as intro, outro, overlay or music on projects and clips (replaced clips left out), and in layer templates. Returns { projects: [{ id, title, slots, clips: [{ id, index, title, slots, via, overlays, music }] }], templates: [{ id, name, layers }] }. A deleted asset's layer is skipped when a template is applied. Check before deleting one.",
    inputSchema: { assetId: assetIdInput() },
    annotations: { readOnlyHint: true },
  },
  set_default_bumper: {
    title: "Set default intro/outro",
    description:
      "Make a library item your default intro or outro for projects you create from now on (assetId null clears it). Existing projects keep theirs; to change one use set_project_bumpers. Returns { ok }.",
    inputSchema: {
      slot: z.enum(["intro", "outro"]).describe("Which default to set"),
      assetId: z.string().min(1).max(100).nullable().describe("Library asset id (search_assets with source library), or null for no default"),
    },
    annotations: { idempotentHint: true },
  },
  set_project_bumpers: {
    title: "Set a project's intro/outro",
    description:
      'Set one project\'s intro and/or outro: "default" (your current default), "none", or a library asset id; a slot left out is untouched, and introSec/outroSec are saved with the project. Clips with their own choice (set_clip_bumpers) keep it. Applies on each clip\'s next render; rerender: true re-renders finished clips now. Returns { rerendered }. set_default_bumper changes future projects instead.',
    inputSchema: setProjectBumpersInput,
  },
  set_clip_bumpers: {
    title: "Set clips' intro/outro",
    description:
      'Override the intro and/or outro of up to 200 clips of one project: "inherit" (follow the project), "none", or a library asset id; a slot left out is untouched. rerender: true re-renders only these clips. Returns { updated, rerendered }.',
    inputSchema: setClipBumpersInput,
  },
  list_layer_templates: {
    title: "List layer templates",
    description:
      "Your layer templates (layers that fit any clip length, plus an optional intro / outro), newest first. Returns { items: [{ id, name, layerCount, layers, bumpers, updatedAt }], nextCursor, total, deleted } (nextCursor goes in cursor; deleted = restorable). A layer has the clip-layer fields plus timing { mode, start, end, minSec, maxSec }: head = seconds after the start; tail = seconds before the end (end 0 = the very end); fill = whole clip; relative = fractions 0-1 of the length, held between minSec and maxSec",
    inputSchema: {
      cursor: z.string().max(300).optional().describe("nextCursor from the previous page; omit for the first page"),
      limit: z.number().int().min(1).max(500).default(100).describe("Templates per page (1-500, default 100)"),
    },
    annotations: { readOnlyHint: true },
  },
  save_layer_template: {
    title: "Save layer template",
    description:
      "Create a template from exactly one of clipId (that clip's layers: spanning = fill, touching the start = head, touching the end = tail, else anchored to the nearer edge; plus the intro and outro the clip renders with) or layers (each with a timing, see list_layer_templates; [] with bumpers = an intro / outro only template). Returns the template { id, name, layerCount, layers, bumpers }. Use apply_layer_template to put it on clips",
    inputSchema: saveLayerTemplateInput,
  },
  update_layer_template: {
    title: "Update layer template",
    description:
      "Rename a layer template, replace its layers (the whole list, each with a timing) and/or replace its intro / outro (bumpers; null = it sets neither); a field left out is untouched. Clips that already got the template keep what they have; apply_layer_template again to refresh them. Returns the template.",
    inputSchema: {
      templateId: templateIdSchema,
      name: layerTemplateNameSchema.optional(),
      layers: layerTemplateLayersSchema.optional(),
      bumpers: templateBumpersSchema.nullable().optional(),
    },
    annotations: { idempotentHint: true },
  },
  delete_layer_template: {
    title: "Delete layer template",
    description:
      "Delete a template (it goes to Deleted) and drop it from your project defaults; clips that already got its layers keep them. Undo with restore_layer_template (list_deleted says how long it is kept). Returns { ok, clearedDefault } (it was your default and no longer is)",
    inputSchema: { templateId: templateIdSchema },
    annotations: { destructiveHint: true, idempotentHint: true },
  },

  restore_layer_template: {
    title: "Restore layer template",
    description:
      "Bring back a deleted layer template (the id from list_layer_templates deleted or list_deleted). It does not become a default again. Returns the template.",
    inputSchema: { templateId: templateIdSchema },
    annotations: { idempotentHint: true },
  },
  apply_framing: {
    title: "Apply framing to the project",
    description:
      "Make one clip's framing the whole project's, for a recording whose layout never changes (a slide deck with a webcam tile, a fixed camera): the clip's section at `at` (else its first framed section) gives the mode and its nudge / subject / crop, which become the project's reframe and reframeAdjust; every clip's own sections are cleared (unless keepOverrides) and the finished clips re-render. New clips get it too. Returns { reframe, adjust, cleared, rerendered }.",
    inputSchema: {
      clipId: clipId("Clip whose framing to copy"),
      at: z
        .number()
        .min(0)
        .optional()
        .describe("Seconds from the start of the source: which section of the clip to copy (default: its first section that is not plain automatic)"),
      keepOverrides: z
        .boolean()
        .optional()
        .describe("Leave other clips' own sections in place; they still win over the project's framing (default false: clear them)"),
      rerender: z.boolean().optional().describe("Re-render the finished clips now (default true)"),
    },
  },
  apply_layer_template: {
    title: "Apply layer template to clips",
    description:
      "Write a template onto clips of one project (up to 200 clipIds, or all): its layers fitted to each clip's length, and the intro / outro it sets as each clip's own. Not linked afterwards. mode replace (default) swaps the clips' layers, add keeps them and adds. rerender true re-renders finished clips now, else the next render shows them. update_project settings.layerTemplateId only affects clips created later. Returns { updated, rerendered, skipped: [{ clipId, reason }], layersSkipped, bumpers: slots set }",
    inputSchema: applyLayerTemplateInput,
  },
  delete_project: {
    title: "Delete project",
    description:
      "Delete one of your projects and all its clips; work in progress stops. Reversible: restore_project brings it back for DELETED_RETENTION_DAYS (7 days by default). Storage still counts until purge_project (or the retention sweep) removes it for good; minutes already used stay counted. Returns { changed, restorable, storedBytes, forgetDecisions, message }.",
    inputSchema: {
      id: projectId(),
      forgetDecisions: z
        .boolean()
        .default(false)
        .describe(
          "Forget what Reelsaw learned from it (its decision log entries) when it is deleted for good, by purge_project or the retention sweep; restoring it cancels that. Default false keeps them",
        ),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  purge_project: {
    title: "Delete project forever",
    description:
      "Permanently remove a deleted project and its files so the storage is freed (find it with list_deleted or list_projects deleted: true). Minutes, hourly creates and first-video-free are not refunded. A project that is not deleted is refused: call delete_project first. What you decided about it (accepted and rejected fixes, clip edits) stays in your decision log so Reelsaw keeps learning from it, unless forgetDecisions is true. Returns { storedBytes, forgottenDecisions, message }.",
    inputSchema: {
      id: projectId("list_projects with deleted: true"),
      forgetDecisions: z
        .boolean()
        .default(false)
        .describe("Also forget what Reelsaw learned from this project (its entries in the decision log); default false keeps them"),
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  restore_project: {
    title: "Restore project",
    description:
      "Bring back a deleted project with its clips and files (find it with list_deleted or list_projects deleted: true); restoring a project that is not deleted changes nothing. Refused if the account is already at its live project cap. A project that was processing comes back failed: retry_project resumes it. Returns { changed, status }.",
    inputSchema: { id: projectId("list_projects with deleted: true") },
    annotations: { idempotentHint: true },
  },
  restore_clip: {
    title: "Restore clip",
    description:
      "Bring back a deleted clip or one a re-analyze replaced (list_deleted or get_project → replacedClips); it goes to the end of the project's clips. Returns { changed, status, needsRerender }; needsRerender means it never finished, so call rerender_clip.",
    inputSchema: { id: z.string().describe("Clip id (from list_deleted or get_project → replacedClips)") },
    annotations: { idempotentHint: true },
  },
  list_deleted: {
    title: "List deleted items",
    description:
      "Restorable deletes (the Deleted page): one newest-first list of projects, clips of live projects, library items and templates. Returns { items: [{ kind, id, title, deletedAt, purgeAt, storedBytes, canPurge, … }], total, truncated } (max 200) plus keepDays / libraryDays / templateDays. purgeAt null = kept until deleted forever. restore_project / restore_clip / restore_asset / restore_layer_template bring them back; purge_project / purge_clip / purge_asset / purge_layer_template remove them for good.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  purge_clip: {
    title: "Delete clip forever",
    description:
      "Permanently remove a deleted clip of a live project and its rendered file so the storage is freed (find it with list_deleted). A clip that is not deleted is refused: call delete_clip first. Clips of a deleted project go with purge_project. Returns { storedBytes, message }.",
    inputSchema: { id: z.string().describe("Clip id (from list_deleted)") },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  purge_asset: {
    title: "Delete library item forever",
    description:
      "Permanently remove an already-deleted library upload and its files so the storage is freed (find it with list_deleted). Refused while a project, clip or live template still names it. An item that is not deleted is refused: call delete_asset first. Returns { storedBytes, message }.",
    inputSchema: { assetId: assetIdInput("list_deleted") },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  purge_layer_template: {
    title: "Delete layer template forever",
    description:
      "Permanently remove an already-deleted layer template (find it with list_deleted). Templates hold no media files; this only drops the row. A template that is not deleted is refused: call delete_layer_template first. Returns { ok, message }.",
    inputSchema: { templateId: templateIdSchema },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  check_for_update: {
    title: "Check for update",
    description:
      "Admins only: is a newer Reelsaw published? Returns { current, latest: { version, url, publishedAt }, available, checkedAt, error, upgrade: { command, note, docsUrl } }; available is null when the running build is not a release (from source). The server checks every few hours; refresh: true asks GitHub again now.",
    inputSchema: { refresh: z.boolean().default(false).describe("true = ask GitHub now instead of returning the last answer (at most once a minute)") },
    annotations: { readOnlyHint: true },
  },
  list_releases: {
    title: "List releases",
    description:
      "Published Reelsaw versions from GitHub (reelsaw.com/releases): tag, date, a short summary and the change notes. Returns { releases, total, windowDays, commits, commitDays, releaseDays, truncated, fetchedAt, sourceUrl, error }; pass tag for one version. Cached for an hour.",
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(20).describe("How many releases to return (1-100, default 20, newest first)"),
      tag: z.string().min(1).max(40).optional().describe("Only this tag or version (v0.19.1 or 0.19.1)"),
    },
    annotations: { readOnlyHint: true },
  },
  get_instance_settings: {
    title: "Instance settings",
    description:
      'Admins only: the instance settings in force (sign-up mode, email verification, captcha, legal links, quotas, upload limits, retention, stall watchdog, update check, health details) and where each comes from. Returns { values, env, override, source: { KEY: "env" | "db" }, ignored: { KEY: reason }, groups, help, updatedAt, updatedBy }; secrets are masked.',
    annotations: { readOnlyHint: true },
  },
  list_workers: {
    title: "List workers",
    description:
      "Admins only: every Reelsaw process that has checked in (API, worker, combined app): CPU, memory, disk (free/total MB, -1 = unmeasurable; diskLeasedMB = free space jobs in flight have claimed on its volume), GPU, render slots, the queues it listens on, and its jobs. A worker short of disk with nothing left to evict drops the media queues from `queues` until its disk recovers; other workers take them. Returns { items, live, stale }; stale = no check-in for 45 seconds. Hosted non-admins are refused.",
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
      'Hosted instances: a Stripe Checkout URL for a plan (or, when the account already pays, the Billing Portal page that confirms the plan change). Returns { url, kind: "checkout" | "change" }; a person must open it in a browser, an agent cannot pay. Plans and intervals come from get_billing.',
    inputSchema: {
      plan: z.string().min(1).max(40).describe("Plan name from get_billing (e.g. creator, pro)"),
      interval: z.enum(["month", "year"]).default("month").describe("Billing interval: month (default) or year"),
    },
  },
  list_transcript_flags: {
    title: "List transcript fixes",
    description:
      "The fixes Reelsaw made or suggests in a project's transcript: misheard names, fillers and repetitions to cut, and your own cuts and corrections. Returns { total, flags: [{ id, kind, subkind, status, start, end, heard, suggested, replacement, confidence }] }; status pending waits for your decision. Use the ids with review_transcript_flags.",
    inputSchema: {
      id: projectId(),
      status: z
        .enum(["pending", "auto", "accepted", "rejected"])
        .optional()
        .describe("Only fixes in this state; omitted = all (pending = waiting for review, auto = applied automatically)"),
      limit: z.number().int().min(1).max(500).default(100).describe("Most fixes to return (1-500, default 100)"),
    },
    annotations: { readOnlyHint: true },
  },
  review_transcript_flags: {
    title: "Review transcript fixes",
    description:
      "Accept or reject suggested transcript fixes (ids from list_transcript_flags), optionally with your own replacement text for an accepted name fix. The transcript is rebuilt; with rerender true (default) clips whose captions overlap a change are re-rendered. Returns { changed, rerendered, needsRerender, flags: [{ id, status, replacement }], hint }.",
    inputSchema: {
      id: projectId(),
      decisions: z
        .array(
          z.object({
            flagId: z.string().min(1).describe("Fix id from list_transcript_flags"),
            status: z.enum(["accepted", "rejected"]).describe("accepted applies the fix, rejected keeps the words as heard"),
            replacement: z.string().max(80).optional().describe("Text to use instead of the suggestion (accepted fixes only)"),
          }),
        )
        .min(1)
        .max(200)
        .describe("One decision per fix"),
      rerender: z
        .boolean()
        .default(true)
        .describe("Re-render the finished clips whose captions overlap a change (default true); false only saves, re-render later with rerender_clips"),
    },
  },
  add_transcript_correction: {
    title: "Correct transcript words",
    description:
      'Make captions show "text" instead of the words spoken between startSec and endSec (a misheard name, say); the span must cover whole words. Returns { ok, flagId, rerendered, hint }. Undo it by passing the flagId to review_transcript_flags with status rejected.',
    inputSchema: {
      id: projectId(),
      startSec: z.number().min(0).describe("Start of the words to correct, seconds from the start of the source video"),
      endSec: z.number().min(0).describe("End of the words to correct, seconds"),
      text: z.string().trim().min(1).max(200).describe("What the captions should say for that span"),
      rerender: z.boolean().default(true).describe("Re-render finished clips whose captions overlap the span (default true)"),
    },
  },
  add_transcript_cut: {
    title: "Cut transcript words",
    description:
      "Remove the words spoken between startSec and endSec from the transcript, so captions and the rendered video skip them; the span must cover whole words. Returns { ok, flagId, rerendered, hint }. Undo it by passing the flagId to review_transcript_flags with status rejected.",
    inputSchema: {
      id: projectId(),
      startSec: z.number().min(0).describe("Start of the words to cut, seconds from the start of the source video"),
      endSec: z.number().min(0).describe("End of the words to cut, seconds"),
      rerender: z.boolean().default(true).describe("Re-render finished clips whose captions overlap the span (default true)"),
    },
  },
  get_project_defaults: {
    title: "Get project defaults",
    description:
      "The settings every new project starts with (Settings, Project defaults): language, vocabulary, instructions, focus, clip lengths, pauses, caption look and refine steps. Returns { projectDefaults }; keys you never set are absent and use the built-in value. Change them with set_project_defaults.",
    annotations: { readOnlyHint: true },
  },
  set_project_defaults: {
    title: "Set project defaults",
    description:
      "Replace the settings every new project starts with; existing projects keep theirs. Send the whole set you want: keys left out are cleared, {} clears all (read get_project_defaults first). Intro and outro change through set_default_bumper. Returns { ok, projectDefaults, hint }.",
    inputSchema: {
      defaults: projectDefaultsInput.describe('The complete set of defaults, e.g. { language: "en", maxClips: 5, pauses: "tight" }'),
    },
    annotations: { idempotentHint: true },
  },
  set_project_source_text: {
    title: "Set source text handling",
    description:
      "Hide or keep text burned into the source video (captions, logos) for the whole project: hide covers it, keep leaves it, always shows it. Re-renders every finished clip so the set agrees. Returns { changed, needsRerender, rerendered, skipped, hint }; rerendered is how many clips were queued, so follow with wait_for_project; skipped clips were still preparing or rendering and need rerender_clips once done (needsRerender is true).",
    inputSchema: {
      id: projectId(),
      sourceText: z.enum(["hide", "keep", "always"]).describe("hide = cover on-screen text in the source, keep = leave it, always = always show it"),
    },
    annotations: { idempotentHint: true },
  },
  update_project_style: {
    title: "Update project style",
    description:
      "Change the caption/hook look for the whole project (font, colors, size, position, words per line). Clears per-clip style overrides unless keepOverrides, and re-renders every finished clip unless rerender is false. Returns { changed, needsRerender, rerendered, skipped, hint }; rerendered is how many clips were queued, skipped how many were still preparing or rendering (they need rerender_clips once done). For one clip use update_clip { style }.",
    inputSchema: {
      id: projectId(),
      style: styleOverrideSchema.describe("The style fields to change; fields left out keep their value"),
      keepOverrides: z.boolean().optional().describe("Keep clips' own style overrides instead of clearing them (default false)"),
      rerender: z.boolean().default(true).describe("Re-render finished clips now (default true); false saves the style and the next render shows it"),
    },
    annotations: { idempotentHint: true },
  },
  list_decisions: {
    title: "List decisions",
    description:
      "Your decision log: what you accepted, rejected, cut, corrected, edited, deleted or restored, newest first, kept after a project is deleted so Reelsaw learns from it. Returns { summary: { enabled, total, projects, byKind }, items: [{ id, kind, explicit, projectId, clipId, before, after, context, models, source, createdAt }], nextCursor, total }. kinds are fix.* (transcript fixes) and clip.*; clip.replaced (explicit false) is a pick a re-analyze replaced.",
    inputSchema: {
      kind: z.enum(DECISION_KINDS).optional().describe("Only this kind of decision"),
      projectId: z.string().max(100).optional().describe("Only decisions about this project (it may already be deleted)"),
      cursor: z.number().int().positive().optional().describe("nextCursor from the previous page"),
      limit: z.number().int().min(1).max(200).default(50).describe("Page size (1-200, default 50)"),
    },
    annotations: { readOnlyHint: true },
  },
  export_decisions: {
    title: "Export decisions",
    description:
      "A page of your decision log in export form, oldest first, for evals. Returns { items (one decision each, the same objects `reelsaw decisions export` writes as JSON lines), cases: { disfluency: [eval cases in eval/fixtures/disfluency/cases.json shape, split dev/heldout by project] }, nextCursor }. Pass nextCursor back until it is null.",
    inputSchema: {
      kind: z.enum(DECISION_KINDS).optional().describe("Only this kind of decision"),
      since: z.string().datetime({ offset: true }).optional().describe("Only decisions made at or after this ISO time"),
      cursor: z.number().int().positive().optional().describe("nextCursor from the previous page"),
      limit: z.number().int().min(1).max(1000).default(200).describe("Page size (1-1000, default 200)"),
    },
    annotations: { readOnlyHint: true },
  },
  forget_decisions: {
    title: "Forget decisions",
    description:
      "Delete entries from your decision log so Reelsaw stops learning from them: one project's (projectId, live or already deleted forever) or, without projectId, all of them. Cannot be undone. Returns { forgotten, message }.",
    inputSchema: { projectId: z.string().min(1).max(100).optional().describe("Only this project's decisions; omitted = everything") },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  set_learning: {
    title: "Turn learning on or off",
    description:
      "Whether Reelsaw records your decisions (accepts, rejects, cuts, clip edits) to learn from (Settings → Learning, on by default). Off stops recording; what is already kept stays until forget_decisions. Returns { enabled }.",
    inputSchema: { enabled: z.boolean().describe("true records decisions, false stops") },
    annotations: { idempotentHint: true },
  },
  billing_portal_url: {
    title: "Billing portal URL",
    description:
      "Hosted instances: a Stripe Billing Portal URL to see invoices, change the card or cancel at period end. Returns { url }; a person must open it in a browser. On a self-hosted Reelsaw this answers that billing is not enabled.",
  },
};

export type ToolName = keyof typeof TOOLS;
/** Tools that only do something on a hosted instance with billing (ee); elsewhere they answer with a sentence. */
export const EE_TOOLS: ToolName[] = ["get_billing", "billing_checkout_url", "billing_portal_url"];
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];
