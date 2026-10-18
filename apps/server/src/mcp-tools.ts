/**
 * The MCP tool catalogue: names, descriptions and input schemas of every tool Reelsaw exposes.
 * `mcp.ts` binds them to the tRPC procedures for `/api/mcp`; `mcp-stdio.ts` registers the same
 * catalogue over stdio and forwards calls to a running instance. One list, so the two surfaces
 * cannot drift (`test/mcp.test.ts` checks they advertise the same tools and schemas).
 */
import { z } from "zod";
import { projectSettingsPatchSchema, reframeModeSchema, layoutSectionSchema, styleOverrideSchema } from "@reelsaw/shared";
import { addBumperInput, setClipBumpersInput, setProjectBumpersInput } from "./bumpers/service.js";

export const INSTRUCTIONS = `Reelsaw turns long-form videos into vertical short clips (transcribe → find moments → reframe, caption, render).
Workflow: create_project(sourceUrl) → wait_for_project (poll until done; a 30-min video takes several minutes) → get_project for the clips → get_clip for download links.
Clips can be edited (update_clip: title, hook, caption, hashtags, bounds, framing) and re-rendered. get_project returns only a transcript summary; get_transcript gives the timed transcript (optionally a time range) for picking your own moments with create_clip. search_clips finds clips and projects by words in their titles, hooks and captions.
Bumpers are short intro/outro videos or images (max 10 s) from your library (list_bumpers, add_bumper) that are joined around every clip; set one as your default for new projects (set_default_bumper), per project (set_project_bumpers) or per clip (set_clip_bumpers). get_project and get_clip show the effective intro/outro and where it comes from. Bumpers are burned into the rendered video, so a change only shows after a re-render: pass rerender: true to re-render just the affected clips.
All ids are strings. Times are seconds from the start of the source video. Media URLs need the same Authorization header as this server.`;

const settingsInput = projectSettingsPatchSchema.describe("Project settings; omit for the defaults (automatic clip count, 20–60 s clips, natural pauses).");

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

export const TOOLS = {
  list_projects: {
    title: "List projects",
    description: "Your projects, most recently updated first, with pipeline status and how many clips are rendered. Returns up to `limit` (default 24, max 100) plus `total`; when `nextCursor` is not null, pass it as `cursor` to get the next page.",
    inputSchema: { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(24) },
    annotations: { readOnlyHint: true },
  },
  get_project: {
    title: "Get project",
    description: "A project with its clips (title, hook, bounds, score, status, download links) and settings. The transcript is only summarised (language, pending fixes); use get_transcript to read it.",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  },
  create_project: {
    title: "Create project",
    description: "Start clipping a video from a URL (YouTube, Vimeo, a direct video link, anything yt-dlp can fetch). Intro/outro: by default your default intro/outro (list_bumpers) are used; pass introAssetId/outroAssetId (a library id, or null for none) to override. Returns immediately; the pipeline runs in the background. Follow with wait_for_project.",
    inputSchema: {
      sourceUrl: z.url(),
      title: z.string().min(1).max(200).optional(),
      settings: settingsInput.optional(),
      introAssetId: z.string().min(1).max(100).nullable().optional().describe("Library asset id for the intro of every clip; null = no intro; omitted = your default intro"),
      outroAssetId: z.string().min(1).max(100).nullable().optional().describe("Same for the outro"),
      introSec: z.number().min(1).max(10).optional().describe("Seconds an intro image shows"),
      outroSec: z.number().min(1).max(10).optional(),
    },
  },
  wait_for_project: {
    title: "Wait for project",
    description: "Block until the project is done or failed, or until timeoutSeconds (max 120) pass. Call again while status is not done/failed.",
    inputSchema: { id: z.string(), timeoutSeconds: z.number().int().min(1).max(120).default(60) },
    annotations: { readOnlyHint: true },
  },
  get_transcript: {
    title: "Get transcript",
    description: "The project's transcript as timed sentences ([m:ss] text), optionally limited to a time range. Large transcripts are cut at maxChars; narrow the range to read the rest.",
    inputSchema: { id: z.string(), fromSec: z.number().min(0).optional(), toSec: z.number().min(0).optional(), maxChars: z.number().int().min(1000).max(200_000).default(60_000) },
    annotations: { readOnlyHint: true },
  },
  search_clips: {
    title: "Search clips",
    description: "Find clips and projects by words in their title, hook or caption (every word must match; case-insensitive and typo-tolerant: \"budgt\" finds \"Budgeting\"; best matches first). Returns at most 8 projects and `limit` clips, and says when more match (narrow the query).",
    inputSchema: { q: z.string().min(1).max(200), limit: z.number().int().min(1).max(50).default(15) },
    annotations: { readOnlyHint: true },
  },
  get_project_events: {
    title: "Project activity",
    description: "Recent pipeline events for a project (stage starts/completions, clip renders, failures with reasons). Newest first.",
    inputSchema: { id: z.string(), limit: z.number().int().min(1).max(200).default(50) },
    annotations: { readOnlyHint: true },
  },
  get_clip: {
    title: "Get clip",
    description: "Everything about one clip: metadata, bounds, scores, framing decisions, caption style, diagnostics and download links.",
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: true },
  },
  update_clip: {
    title: "Update clip",
    description: "Edit a clip's title, hook (the on-screen opening line), caption, hashtags, bounds (startSec/endSec, ≥3 s), framing override or style. Changes burned into the video re-render when rerender is true (default).",
    inputSchema: {
      id: z.string(),
      title: z.string().min(1).max(120).optional(),
      hook: z.string().max(80).optional(),
      caption: z.string().max(300).optional(),
      hashtags: z.array(z.string().min(1).max(40)).max(20).optional(),
      startSec: z.number().min(0).optional(),
      endSec: z.number().min(0).optional(),
      layoutOverride: reframeModeSchema.nullable().optional().describe("Framing for the whole clip; null = automatic"),
      layoutSections: z.array(layoutSectionSchema).max(50).nullable().optional(),
      style: styleOverrideSchema.nullable().optional(),
      emphasis: z.array(z.string().min(1).max(40)).max(30).optional().describe("Words the captions emphasise"),
      rerender: z.boolean().default(true),
    },
  },
  create_clip: {
    title: "Create clip",
    description: "Add a clip from a time range of the source. mode 'exact' keeps the bounds (3 s–10 min); mode 'ai' lets the model pick the best moment inside the range (≥8 s). The clip is prepared and rendered in the background.",
    inputSchema: { projectId: z.string(), startSec: z.number().min(0), endSec: z.number().min(0), mode: z.enum(["exact", "ai"]).default("exact") },
  },
  rerender_clip: {
    title: "Re-render clip",
    description: "Render a clip again (after edits, or when it failed).",
    inputSchema: { id: z.string() },
  },
  rerender_clips: {
    title: "Re-render clips",
    description: "Render several clips of a project again in one step (after edits, or when they failed). Finished and failed clips are queued; clips still rendering are skipped. Returns how many were queued and skipped.",
    inputSchema: { projectId: z.string(), clipIds: z.array(z.string()).min(1).max(200) },
  },
  export_project: {
    title: "Export clips",
    description: "A download link for a zip of the project's rendered clips with YouTube/TikTok metadata. Pass clipIds to export only those clips (they must belong to the project and be rendered); the manifest then says it is a subset. The link needs the same sign-in as the web app.",
    inputSchema: { id: z.string(), clipIds: z.array(z.string()).max(200).optional() },
    annotations: { readOnlyHint: true },
  },
  retry_project: {
    title: "Retry project",
    description: "Resume a failed project from its furthest completed stage.",
    inputSchema: { id: z.string() },
  },
  reanalyze_project: {
    title: "Re-analyze project",
    description: "Keep the transcript, pick clips again, optionally with new settings (focus topic, instructions, clip length, maxClips).",
    inputSchema: { id: z.string(), settings: settingsInput.optional() },
  },

  // ── intro / outro library ────────────────────────────────────────────────

  list_bumpers: {
    title: "List intros and outros",
    description: "Your intro/outro library: id, name, kind (video/image), length, size, whether each is your default intro or outro, how many projects use it, thumbnail. Removed items (restorable for 30 days) are listed separately.",
    annotations: { readOnlyHint: true },
  },
  add_bumper: {
    title: "Add intro/outro",
    description: "Add a video (MP4/MOV/WebM, at most 10 s, 50 MB) or image (PNG/JPG, at most 20 MB) to your library, from a public http(s) url the server downloads, or from an existing uploadId. Images show for imageSeconds (default per server, 1-10 s). setDefault also makes it your default intro or outro for NEW projects; existing projects are unchanged until set_project_bumpers. name applies to url downloads.",
    inputSchema: addBumperInput,
  },
  set_default_bumper: {
    title: "Set default intro/outro",
    description: "Make a library item your default intro or outro for new projects (assetId null clears the default). Existing projects keep what they have.",
    inputSchema: { slot: z.enum(["intro", "outro"]), assetId: z.string().min(1).max(100).nullable() },
  },
  remove_bumper: {
    title: "Remove intro/outro",
    description: "Remove an item from your library and clear it from your defaults. Projects and clips already using it keep rendering with it. Undo with restore_bumper within 30 days.",
    inputSchema: { assetId: z.string().min(1).max(100) },
    annotations: { destructiveHint: true },
  },
  restore_bumper: {
    title: "Restore intro/outro",
    description: "Bring a removed intro/outro back into the library.",
    inputSchema: { assetId: z.string().min(1).max(100) },
  },
  bumper_usage: {
    title: "Where an intro/outro is used",
    description: "The projects and clips that use a library item, and whether through the project's setting or the clip's own choice. Check before removing one.",
    inputSchema: { assetId: z.string().min(1).max(100) },
    annotations: { readOnlyHint: true },
  },
  set_project_bumpers: {
    title: "Set a project's intro/outro",
    description: "Choose the intro and/or outro for a project: \"default\" (your current default), \"none\", or a library asset id; a slot left out is untouched. introSec/outroSec set how long an image shows. Takes effect on the next render of each clip; rerender: true re-renders the project's finished clips now (clips with their own choice for a slot keep it).",
    inputSchema: setProjectBumpersInput,
  },
  set_clip_bumpers: {
    title: "Set clips' intro/outro",
    description: "Override the intro and/or outro of one or many clips of a project: \"inherit\" (follow the project), \"none\", or a library asset id; a slot left out is untouched. rerender: true re-renders only these clips now.",
    inputSchema: setClipBumpersInput,
  },
  delete_project: {
    title: "Delete project",
    description: "Delete a project and all its clips. Cannot be undone.",
    inputSchema: { id: z.string() },
    annotations: { destructiveHint: true },
  },
};

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];
