/**
 * MCP server (Model Context Protocol): lets an agent (Claude Code, Claude Desktop, Cursor, …)
 * drive Reelsaw over `POST /api/mcp` with an API key. Tools are thin wrappers over the tRPC
 * procedures, called through `appRouter.createCaller`, so ownership checks, validation and the
 * unit-of-work rules are the same as for the web app. One stateless server per request: there is
 * no session to keep, the database holds all state.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import type { Context as HonoContext } from "hono";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { projectSettingsPatchSchema, reframeModeSchema, layoutSectionSchema, styleOverrideSchema } from "@reelsaw/shared";
import type { Services } from "./services.js";
import type { AuthUser } from "./auth.js";
import { appRouter } from "./trpc/router.js";
import type { Context } from "./trpc/context.js";
import { schema } from "./db/index.js";
import { addBumperInput, assetMap, clipBumpersCall, downloadAsUpload, effectiveBumpers, libraryView, projectBumpersCall, requireOneSource, setClipBumpersInput, setProjectBumpersInput, type AssetRef } from "./bumpers/service.js";

const INSTRUCTIONS = `Reelsaw turns long-form videos into vertical short clips (transcribe → find moments → reframe, caption, render).
Workflow: create_project(sourceUrl) → wait_for_project (poll until done; a 30-min video takes several minutes) → get_project for the clips → get_clip for download links.
Clips can be edited (update_clip: title, hook, caption, hashtags, bounds, framing) and re-rendered. get_transcript gives the timed transcript for picking your own moments with create_clip.
Bumpers are short intro/outro videos or images (max 10 s) from your library (list_bumpers, add_bumper) that are joined around every clip; set one as your default for new projects (set_default_bumper), per project (set_project_bumpers) or per clip (set_clip_bumpers). get_project and get_clip show the effective intro/outro and where it comes from. Bumpers are burned into the rendered video, so a change only shows after a re-render: pass rerender: true to re-render just the affected clips.
All ids are strings. Times are seconds from the start of the source video. Media URLs need the same Authorization header as this server.`;

const settingsInput = projectSettingsPatchSchema.describe("Project settings; omit for the defaults (automatic clip count, 20–60 s clips, natural pauses).");

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function fail(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}
function mmss(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, "0")}`;
}

export function createMcpServer(svc: Services, user: AuthUser, req: Request): McpServer {
  const ctx: Context = { svc, who: { user, via: "apikey", session: null, blocked: null }, req };
  const api = appRouter.createCaller(ctx);
  const db = svc.database.db;
  const abs = (p: string | null) => (p ? new URL(p, svc.config.APP_URL).toString() : null);
  const server = new McpServer({ name: "reelsaw", version: svc.config.REELSAW_VERSION }, { instructions: INSTRUCTIONS });

  /** Run a tool body; tRPC errors become tool errors the model can read instead of protocol failures. */
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return text(await fn());
    } catch (err) {
      if (err instanceof TRPCError) return fail(`${err.code}: ${err.message}`);
      svc.log.error({ err, userId: user.id }, "mcp tool failed");
      return fail(err instanceof Error ? err.message : String(err));
    }
  };

  const projectSummary = (p: Awaited<ReturnType<typeof api.projects.list>>["items"][number]) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    stage: p.stage,
    stageProgress: p.stageProgress,
    error: p.error,
    sourceUrl: p.sourceUrl,
    durationSec: p.durationSec,
    clips: `${p.clipsDone}/${p.clipCount} rendered`,
    createdAt: p.createdAt,
    url: abs(`/p/${p.id}`),
  });
  const clipSummary = (c: Awaited<ReturnType<typeof api.projects.get>>["clips"][number]) => ({
    id: c.id,
    index: c.index,
    title: c.title,
    hook: c.hook,
    startSec: c.startSec,
    endSec: c.endSec,
    durationSec: Number((c.endSec - c.startSec).toFixed(1)),
    score: c.score,
    status: c.status,
    error: c.error,
    layout: c.layout,
    videoUrl: abs(c.videoUrl),
    thumbnailUrl: abs(c.thumbnailUrl),
  });

  /** Names and lengths of every library asset (removed ones too: clips that still use them keep rendering with them). */
  const assetsById = async () => {
    const lib = await api.bumpers.list();
    return assetMap([...lib.assets, ...lib.deleted] as AssetRef[]);
  };

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "Your projects, most recently updated first, with pipeline status and how many clips are rendered. Returns up to `limit` (default 24, max 100) plus `total`; when `nextCursor` is not null, pass it as `cursor` to get the next page.",
      inputSchema: { cursor: z.string().optional(), limit: z.number().int().min(1).max(100).default(24) },
      annotations: { readOnlyHint: true },
    },
    ({ cursor, limit }) =>
      run(async () => {
        const page = await api.projects.list({ cursor, limit });
        return { projects: page.items.map(projectSummary), total: page.total, nextCursor: page.nextCursor };
      }),
  );

  server.registerTool(
    "get_project",
    { title: "Get project", description: "A project with its clips (title, hook, bounds, score, status, download links) and settings. Use get_transcript for the transcript.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    ({ id }) =>
      run(async () => {
        const p = await api.projects.get({ id });
        const { clips, transcript, ...rest } = p;
        const assets = await assetsById();
        return {
          ...rest,
          bumpers: effectiveBumpers(p.settings, {}, assets),
          url: abs(`/p/${p.id}`),
          sourceVideoUrl: abs(p.sourceVideoUrl),
          exportZipUrl: abs(`/api/projects/${p.id}/export.zip`),
          transcript: transcript ? { language: transcript.language, words: transcript.words.length, pendingFlags: transcript.flags.filter((f) => f.status === "pending").length } : null,
          clips: clips.map((c) => ({ ...clipSummary(c), bumpers: effectiveBumpers(p.settings, c, assets) })),
        };
      }),
  );

  server.registerTool(
    "create_project",
    {
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
    ({ sourceUrl, title, settings, introAssetId, outroAssetId, introSec, outroSec }) =>
      run(async () => {
        // the bumper fields are project settings: omitted = snapshot your defaults, null = none, id = that asset (must be yours and not removed, else NOT_FOUND)
        const merged = { ...settings, ...(introAssetId !== undefined ? { introAssetId } : {}), ...(outroAssetId !== undefined ? { outroAssetId } : {}), ...(introSec !== undefined ? { introSec } : {}), ...(outroSec !== undefined ? { outroSec } : {}) };
        return { ...(await api.projects.create({ sourceUrl, title, settings: Object.keys(merged).length ? merged : undefined })), next: "wait_for_project" };
      }),
  );

  server.registerTool(
    "wait_for_project",
    {
      title: "Wait for project",
      description: "Block until the project is done or failed, or until timeoutSeconds (max 120) pass. Call again while status is not done/failed.",
      inputSchema: { id: z.string(), timeoutSeconds: z.number().int().min(1).max(120).default(60) },
      annotations: { readOnlyHint: true },
    },
    ({ id, timeoutSeconds }, extra) =>
      run(async () => {
        const deadline = Date.now() + timeoutSeconds * 1000;
        for (;;) {
          const p = await api.projects.get({ id });
          const finished = p.status === "done" || p.status === "failed";
          const timedOut = Date.now() >= deadline;
          if (finished || timedOut || extra.signal.aborted) {
            return {
              id: p.id,
              status: p.status,
              stage: p.stage,
              stageProgress: p.stageProgress,
              error: p.error,
              clips: p.clips.map((c) => ({ id: c.id, title: c.title, status: c.status })),
              ...(finished ? {} : { hint: "Still running. Call wait_for_project again." }),
            };
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }),
  );

  server.registerTool(
    "get_transcript",
    {
      title: "Get transcript",
      description: "The project's transcript as timed sentences ([m:ss] text), optionally limited to a time range. Large transcripts are cut at maxChars; narrow the range to read the rest.",
      inputSchema: { id: z.string(), fromSec: z.number().min(0).optional(), toSec: z.number().min(0).optional(), maxChars: z.number().int().min(1000).max(200_000).default(60_000) },
      annotations: { readOnlyHint: true },
    },
    ({ id, fromSec, toSec, maxChars }) =>
      run(async () => {
        const p = await api.projects.get({ id });
        if (!p.transcript) return `No transcript yet (project status: ${p.status}).`;
        const segs = p.transcript.segments.filter((s) => (fromSec === undefined || s.end >= fromSec) && (toSec === undefined || s.start <= toSec));
        let out = `# ${p.title} (${p.transcript.language ?? "?"}, ${p.durationSec ? mmss(p.durationSec) : "?"})\n`;
        let truncated = false;
        for (const s of segs) {
          const line = `[${mmss(s.start)}] ${s.text}\n`;
          if (out.length + line.length > maxChars) {
            truncated = true;
            out += `\n… truncated at ${mmss(s.start)}; call again with fromSec=${Math.floor(s.start)}.`;
            break;
          }
          out += line;
        }
        return truncated || segs.length ? out : out + "(empty)";
      }),
  );

  server.registerTool(
    "get_project_events",
    { title: "Project activity", description: "Recent pipeline events for a project (stage starts/completions, clip renders, failures with reasons). Newest first.", inputSchema: { id: z.string(), limit: z.number().int().min(1).max(200).default(50) }, annotations: { readOnlyHint: true } },
    ({ id, limit }) =>
      run(async () => {
        await api.projects.get({ id }); // ownership
        const rows = await db.query.projectEvents.findMany({ where: eq(schema.projectEvents.projectId, id), orderBy: desc(schema.projectEvents.id), limit });
        return rows.map((e) => ({ at: e.createdAt.toISOString(), type: e.type, ...e.payload }));
      }),
  );

  server.registerTool(
    "get_clip",
    { title: "Get clip", description: "Everything about one clip: metadata, bounds, scores, framing decisions, caption style, diagnostics and download links.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    ({ id }) =>
      run(async () => {
        const c = await db.query.clips.findFirst({ where: eq(schema.clips.id, id), columns: { projectId: true } });
        if (!c) throw new TRPCError({ code: "NOT_FOUND" });
        const p = await api.projects.get({ id: c.projectId });
        const clip = p.clips.find((x) => x.id === id)!;
        return { ...clip, bumpers: { own: clip.bumpers, effective: effectiveBumpers(p.settings, clip, await assetsById()) }, videoUrl: abs(clip.videoUrl), thumbnailUrl: abs(clip.thumbnailUrl), editorUrl: abs(`/p/${p.id}/clips/${clip.id}`) };
      }),
  );

  server.registerTool(
    "update_clip",
    {
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
    (input) => run(async () => clipSummary(await api.clips.update(input))),
  );

  server.registerTool(
    "create_clip",
    {
      title: "Create clip",
      description: "Add a clip from a time range of the source. mode 'exact' keeps the bounds (3 s–10 min); mode 'ai' lets the model pick the best moment inside the range (≥8 s). The clip is prepared and rendered in the background.",
      inputSchema: { projectId: z.string(), startSec: z.number().min(0), endSec: z.number().min(0), mode: z.enum(["exact", "ai"]).default("exact") },
    },
    (input) => run(async () => clipSummary(await api.clips.create(input))),
  );

  server.registerTool(
    "rerender_clip",
    { title: "Re-render clip", description: "Render a clip again (after edits, or when it failed).", inputSchema: { id: z.string() } },
    ({ id }) => run(() => api.clips.rerender({ id })),
  );

  server.registerTool(
    "retry_project",
    { title: "Retry project", description: "Resume a failed project from its furthest completed stage.", inputSchema: { id: z.string() } },
    ({ id }) => run(() => api.projects.retry({ id })),
  );

  server.registerTool(
    "reanalyze_project",
    { title: "Re-analyze project", description: "Keep the transcript, pick clips again, optionally with new settings (focus topic, instructions, clip length, maxClips).", inputSchema: { id: z.string(), settings: settingsInput.optional() } },
    ({ id, settings }) => run(() => api.projects.reanalyze({ id, settings })),
  );

  // ── intro / outro library ────────────────────────────────────────────────

  server.registerTool(
    "list_bumpers",
    { title: "List intros and outros", description: "Your intro/outro library: id, name, kind (video/image), length, size, whether each is your default intro or outro, how many projects use it, thumbnail. Removed items (restorable for 30 days) are listed separately.", annotations: { readOnlyHint: true } },
    () => run(() => libraryView(svc, api, user.id, (p) => abs(p)!)),
  );

  server.registerTool(
    "add_bumper",
    {
      title: "Add intro/outro",
      description: "Add a video (MP4/MOV/WebM, at most 10 s, 50 MB) or image (PNG/JPG, at most 20 MB) to your library, from a public http(s) url the server downloads, or from an existing uploadId. Images show for imageSeconds (default per server, 1-10 s). setDefault also makes it your default intro or outro for NEW projects; existing projects are unchanged until set_project_bumpers. name applies to url downloads.",
      inputSchema: addBumperInput,
    },
    (input) =>
      run(async () => {
        requireOneSource(input);
        if (input.uploadId && input.name) throw new Error("name can only be set together with url");
        const uploadId = input.uploadId ?? (await downloadAsUpload(svc, user.id, input.url!, { name: input.name })).uploadId;
        const created = await api.bumpers.create({ uploadId, imageSeconds: input.imageSeconds, setDefault: input.setDefault });
        return { ...created, isDefault: input.setDefault ?? null };
      }),
  );

  server.registerTool(
    "set_default_bumper",
    { title: "Set default intro/outro", description: "Make a library item your default intro or outro for new projects (assetId null clears the default). Existing projects keep what they have.", inputSchema: { slot: z.enum(["intro", "outro"]), assetId: z.string().min(1).max(100).nullable() } },
    ({ slot, assetId }) => run(() => api.bumpers.setDefault({ slot, assetId })),
  );

  server.registerTool(
    "remove_bumper",
    { title: "Remove intro/outro", description: "Remove an item from your library and clear it from your defaults. Projects and clips already using it keep rendering with it. Undo with restore_bumper within 30 days.", inputSchema: { assetId: z.string().min(1).max(100) }, annotations: { destructiveHint: true } },
    ({ assetId }) => run(() => api.bumpers.delete({ id: assetId })),
  );

  server.registerTool(
    "restore_bumper",
    { title: "Restore intro/outro", description: "Bring a removed intro/outro back into the library.", inputSchema: { assetId: z.string().min(1).max(100) } },
    ({ assetId }) => run(() => api.bumpers.restore({ id: assetId })),
  );

  server.registerTool(
    "bumper_usage",
    { title: "Where an intro/outro is used", description: "The projects and clips that use a library item, and whether through the project's setting or the clip's own choice. Check before removing one.", inputSchema: { assetId: z.string().min(1).max(100) }, annotations: { readOnlyHint: true } },
    ({ assetId }) => run(() => api.bumpers.usage({ id: assetId })),
  );

  server.registerTool(
    "set_project_bumpers",
    {
      title: "Set a project's intro/outro",
      description: "Choose the intro and/or outro for a project: \"default\" (your current default), \"none\", or a library asset id; a slot left out is untouched. introSec/outroSec set how long an image shows. Takes effect on the next render of each clip; rerender: true re-renders the project's finished clips now (clips with their own choice for a slot keep it).",
      inputSchema: setProjectBumpersInput,
    },
    (input) => run(() => api.projects.setBumpers(projectBumpersCall(input))),
  );

  server.registerTool(
    "set_clip_bumpers",
    {
      title: "Set clips' intro/outro",
      description: "Override the intro and/or outro of one or many clips of a project: \"inherit\" (follow the project), \"none\", or a library asset id; a slot left out is untouched. rerender: true re-renders only these clips now.",
      inputSchema: setClipBumpersInput,
    },
    (input) => run(() => api.clips.setBumpersMany(clipBumpersCall(input))),
  );

  server.registerTool(
    "delete_project",
    { title: "Delete project", description: "Delete a project and all its clips. Cannot be undone.", inputSchema: { id: z.string() }, annotations: { destructiveHint: true } },
    ({ id }) => run(() => api.projects.delete({ id })),
  );

  return server;
}

/** Hono handler for `/api/mcp`: one server and transport per request, no session state. */
export async function handleMcp(c: HonoContext, svc: Services, user: AuthUser): Promise<Response> {
  const server = createMcpServer(svc, user, c.req.raw);
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? c.text("Not found", 404);
}
