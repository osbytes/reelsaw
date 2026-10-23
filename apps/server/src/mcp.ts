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
import { desc, eq } from "drizzle-orm";
import type { Services } from "./services.js";
import type { AuthUser } from "./auth.js";
import { appRouter } from "./trpc/router.js";
import type { Context } from "./trpc/context.js";
import { schema } from "./db/index.js";
import { resolveRequestId, type AppEnv } from "./request-log.js";
import { assetMap, clipBumpersCall, effectiveBumpers, projectBumpersCall, type AssetRef } from "./library/service.js";
import { INSTRUCTIONS, TOOLS, argSummary, fail, text } from "./mcp-tools.js";
import { restorableFor } from "./projects/service.js";
import { fetchSubtitleText } from "./transcript-files.js";
import { reportCapabilities } from "./report/capabilities.js";

function mmss(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, "0")}`;
}

export function createMcpServer(svc: Services, user: AuthUser, req: Request, requestId = resolveRequestId(req.headers.get("x-request-id"))): McpServer {
  const log = svc.log.child({ module: "mcp", userId: user.id, requestId });
  const ctx: Context = { svc, who: { user, via: "apikey", session: null, blocked: null }, req, requestId, log };
  const api = appRouter.createCaller(ctx);
  const db = svc.database.db;
  const abs = (p: string | null) => (p ? new URL(p, svc.config.APP_URL).toString() : null);
  const server = new McpServer({ name: "reelsaw", version: svc.config.REELSAW_VERSION }, { instructions: INSTRUCTIONS });
  // every tool call is logged the same way: one info line (tool, ms, outcome), the argument ids at debug
  const register = server.registerTool.bind(server) as unknown as (name: string, config: unknown, cb: (...a: unknown[]) => unknown) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) =>
    register(name, config, async (...a: unknown[]) => {
      const tlog = log.child({ tool: name });
      tlog.debug({ args: argSummary(a[0]) }, "mcp tool call");
      const res = (await cb(...a)) as { isError?: boolean; content?: Array<{ text?: string }> };
      const code = res?.isError ? /^([A-Z_]{4,}):/.exec(res.content?.[0]?.text ?? "")?.[1] : undefined;
      tlog[res?.isError ? "warn" : "info"]({ ok: !res?.isError, ...(res?.isError ? { code: code ?? "ERROR" } : {}) }, "mcp tool");
      return res;
    });

  /** Run a tool body; tRPC errors become tool errors the model can read instead of protocol failures. */
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return text(await fn());
    } catch (err) {
      if (err instanceof TRPCError) return fail(`${err.code}: ${err.message}`);
      log.error({ err }, "mcp tool failed");
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
    ...(p.deletedAt ? { deletedAt: p.deletedAt } : {}),
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
    const lib = await api.library.list();
    return assetMap([...lib.assets, ...lib.deleted] as AssetRef[]);
  };

  server.registerTool(
    "list_projects",
    TOOLS.list_projects,
    ({ cursor, limit, deleted }) =>
      run(async () => {
        const page = await api.projects.list({ cursor, limit, deleted });
        return { projects: page.items.map(projectSummary), total: page.total, nextCursor: page.nextCursor };
      }),
  );

  server.registerTool(
    "get_project",
    TOOLS.get_project,
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
          transcript,
          clips: clips.map((c) => ({ ...clipSummary(c), bumpers: effectiveBumpers(p.settings, c, assets) })),
        };
      }),
  );

  server.registerTool(
    "create_project",
    TOOLS.create_project,
    ({ sourceUrl, title, settings, introAssetId, outroAssetId, introSec, outroSec }) =>
      run(async () => {
        // the bumper fields are project settings: omitted = snapshot your defaults, null = none, id = that asset (must be yours and not removed, else NOT_FOUND)
        const merged = { ...settings, ...(introAssetId !== undefined ? { introAssetId } : {}), ...(outroAssetId !== undefined ? { outroAssetId } : {}), ...(introSec !== undefined ? { introSec } : {}), ...(outroSec !== undefined ? { outroSec } : {}) };
        return { ...(await api.projects.create({ sourceUrl, title, settings: Object.keys(merged).length ? merged : undefined })), next: "wait_for_project" };
      }),
  );

  server.registerTool(
    "update_project",
    TOOLS.update_project,
    ({ id, title, settings, clear }) => run(() => api.projects.update({ id, title, settings, clear })),
  );

  server.registerTool(
    "wait_for_project",
    TOOLS.wait_for_project,
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
    TOOLS.get_transcript,
    ({ id, fromSec, toSec, maxChars }) =>
      run(async () => {
        const p = await api.projects.get({ id });
        const t = await api.transcripts.get({ projectId: id });
        if (!t) return `No transcript yet (project status: ${p.status}).`;
        const segs = t.segments.filter((s) => (fromSec === undefined || s.end >= fromSec) && (toSec === undefined || s.start <= toSec));
        let out = `# ${p.title} (${t.language ?? "?"}, ${p.durationSec ? mmss(p.durationSec) : "?"})\n`;
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
    "get_clip_captions",
    TOOLS.get_clip_captions,
    ({ id, format, words }) => run(async () => (await api.clips.captions({ id, format, words })).text),
  );

  server.registerTool(
    "get_project_transcript_file",
    TOOLS.get_project_transcript_file,
    ({ id, format, words }) => run(async () => (await api.projects.transcriptFile({ id, format, words })).text),
  );

  server.registerTool(
    "import_transcript",
    TOOLS.import_transcript,
    ({ id, text: body, uploadId, url, format, language }) =>
      run(async () => {
        if ([body, uploadId, url].filter((v) => v !== undefined).length !== 1) throw new TRPCError({ code: "BAD_REQUEST", message: "Give exactly one of text, uploadId or url" });
        // a link is fetched here (public addresses only) and passed on as text, so the procedure has one input path
        return api.projects.importTranscript({ id, text: url ? await fetchSubtitleText(url) : body, uploadId, format, language });
      }),
  );

  server.registerTool(
    "search_clips",
    TOOLS.search_clips,
    ({ q, limit }) =>
      run(async () => {
        const r = await api.search({ q, limit });
        return {
          projects: r.projects.map((p) => ({ id: p.id, title: p.title, status: p.status, clips: `${p.clipsDone}/${p.clipCount} rendered`, updatedAt: p.updatedAt, url: abs(`/p/${p.id}`) })),
          clips: r.clips.map((c) => ({ id: c.id, projectId: c.projectId, project: c.projectTitle, title: c.title, hook: c.hook, caption: c.caption, status: c.status, startSec: c.startSec, endSec: c.endSec, videoUrl: abs(c.videoUrl), editorUrl: abs(`/p/${c.projectId}/clips/${c.id}`) })),
          ...(r.truncated ? { truncated: true, hint: "More matched than shown; use a more specific query." } : {}),
        };
      }),
  );

  server.registerTool(
    "get_project_events",
    TOOLS.get_project_events,
    ({ id, limit }) =>
      run(async () => {
        await api.projects.get({ id }); // ownership
        const rows = await db.query.projectEvents.findMany({ where: eq(schema.projectEvents.projectId, id), orderBy: desc(schema.projectEvents.id), limit });
        return rows.map((e) => ({ at: e.createdAt.toISOString(), type: e.type, ...e.payload }));
      }),
  );

  server.registerTool(
    "get_clip",
    TOOLS.get_clip,
    ({ id }) =>
      run(async () => {
        const c = await db.query.clips.findFirst({ where: eq(schema.clips.id, id), columns: { projectId: true } });
        if (!c) throw new TRPCError({ code: "NOT_FOUND" });
        const p = await api.projects.get({ id: c.projectId });
        const clip = p.clips.find((x) => x.id === id);
        if (!clip) throw new TRPCError({ code: "NOT_FOUND", message: `This clip was deleted or replaced by a re-analyze. restore_clip brings it back (possible ${restorableFor(svc)} after that).` });
        return { ...clip, bumpers: { own: clip.bumpers, effective: effectiveBumpers(p.settings, clip, await assetsById()) }, videoUrl: abs(clip.videoUrl), thumbnailUrl: abs(clip.thumbnailUrl), editorUrl: abs(`/p/${p.id}/clips/${clip.id}`) };
      }),
  );

  server.registerTool(
    "update_clip",
    TOOLS.update_clip,
    (input) => run(async () => clipSummary(await api.clips.update(input))),
  );

  server.registerTool(
    "create_clip",
    TOOLS.create_clip,
    (input) => run(async () => clipSummary(await api.clips.create(input))),
  );

  server.registerTool(
    "delete_clip",
    TOOLS.delete_clip,
    ({ id }) => run(() => api.clips.delete({ id })),
  );

  server.registerTool(
    "rerender_clip",
    TOOLS.rerender_clip,
    ({ id }) => run(() => api.clips.rerender({ id })),
  );

  server.registerTool(
    "rerender_clips",
    TOOLS.rerender_clips,
    (input) => run(() => api.clips.rerenderMany(input)),
  );

  server.registerTool(
    "export_project",
    TOOLS.export_project,
    ({ id, clipIds }) =>
      run(async () => {
        const p = await api.projects.get({ id });
        const done = p.clips.filter((c) => c.status === "done");
        const ids = [...new Set(clipIds ?? [])];
        const known = new Set(p.clips.map((c) => c.id));
        const unknown = ids.filter((x) => !known.has(x));
        if (unknown.length) throw new Error(`Not clips of this project: ${unknown.join(", ")}`);
        const picked = ids.length ? done.filter((c) => ids.includes(c.id)) : done;
        if (!picked.length) throw new Error("No rendered clips to export");
        return { url: abs(`/api/projects/${p.id}/export.zip${ids.length ? `?clips=${ids.join(",")}` : ""}`), clips: picked.length, notRendered: ids.length ? ids.length - picked.length : 0 };
      }),
  );

  server.registerTool(
    "report_issue",
    TOOLS.report_issue,
    ({ description, projectId, clipIds, instance, logs, system, previews, allClips, source }) =>
      run(async () => {
        const caps = reportCapabilities(svc, user);
        if (!caps.zip) throw new TRPCError({ code: "FORBIDDEN", message: "Send feedback from the app instead of downloading a report on this instance." });
        if (instance && !caps.instance) throw new TRPCError({ code: "FORBIDDEN", message: "Instance-wide diagnostics are for admins." });
        if (projectId) await api.projects.get({ id: projectId });
        const q = new URLSearchParams({ description });
        if (instance) q.set("instance", "1");
        if (logs === false) q.set("logs", "0");
        if (system === false) q.set("system", "0");
        if (previews === false) q.set("previews", "0");
        if (allClips) q.set("allClips", "1");
        if (source) q.set("source", "1");
        if (clipIds?.length) q.set("clipIds", clipIds.join(","));
        const path = projectId ? `/api/projects/${projectId}/report` : `/api/report`;
        return { url: abs(`${path}?${q}`), filename: "reelsaw-report.zip" };
      }),
  );

  server.registerTool(
    "retry_project",
    TOOLS.retry_project,
    ({ id }) => run(() => api.projects.retry({ id })),
  );

  server.registerTool(
    "reanalyze_project",
    TOOLS.reanalyze_project,
    ({ id, settings }) => run(() => api.projects.reanalyze({ id, settings })),
  );

  // ── intro / outro library ────────────────────────────────────────────────

  server.registerTool("search_assets", TOOLS.search_assets, (input) => run(() => api.library.search(input)));
  server.registerTool("add_asset", TOOLS.add_asset, (input) => run(async () => ({ ...(await api.library.add(input)), isDefault: input.setDefault ?? null })));
  server.registerTool("update_asset", TOOLS.update_asset, ({ assetId, ...patch }) => run(() => api.library.update({ id: assetId, ...patch })));
  server.registerTool("remove_asset", TOOLS.remove_asset, ({ assetId }) => run(() => api.library.remove({ id: assetId })));
  server.registerTool("restore_asset", TOOLS.restore_asset, ({ assetId }) => run(() => api.library.restore({ id: assetId })));
  server.registerTool("asset_usage", TOOLS.asset_usage, ({ assetId }) => run(() => api.library.usage({ id: assetId })));

  server.registerTool(
    "set_default_bumper",
    TOOLS.set_default_bumper,
    ({ slot, assetId }) => run(() => api.library.setDefault({ slot, assetId })),
  );

  server.registerTool(
    "set_project_bumpers",
    TOOLS.set_project_bumpers,
    (input) => run(() => api.projects.setBumpers(projectBumpersCall(input))),
  );

  server.registerTool(
    "set_clip_bumpers",
    TOOLS.set_clip_bumpers,
    (input) => run(() => api.clips.setBumpersMany(clipBumpersCall(input))),
  );

  server.registerTool(
    "check_for_update",
    TOOLS.check_for_update,
    ({ refresh }) => run(() => (refresh ? api.admin.updates.check() : api.admin.updates.get())),
  );

  server.registerTool(
    "get_instance_settings",
    TOOLS.get_instance_settings,
    () => run(() => api.admin.settings.get()),
  );

  server.registerTool(
    "list_workers",
    TOOLS.list_workers,
    () => run(() => api.admin.workers.list()),
  );

  server.registerTool(
    "get_failure",
    TOOLS.get_failure,
    (input) => run(() => api.admin.failures.get(input)),
  );

  server.registerTool(
    "get_queue",
    TOOLS.get_queue,
    () => run(() => api.admin.queue.summary()),
  );

  server.registerTool(
    "list_failures",
    TOOLS.list_failures,
    (input) => run(() => api.admin.failures.list(input ?? {})),
  );

  server.registerTool(
    "retry_failures",
    TOOLS.retry_failures,
    (input) => run(() => api.admin.failures.retry(input ?? {})),
  );

  server.registerTool(
    "set_instance_settings",
    TOOLS.set_instance_settings,
    (input) => run(() => api.admin.settings.set(input)),
  );

  server.registerTool(
    "get_billing",
    TOOLS.get_billing,
    () => run(() => api.billing.get()),
  );

  server.registerTool(
    "billing_checkout_url",
    TOOLS.billing_checkout_url,
    ({ plan, interval }) => run(() => api.billing.checkout({ plan, interval })),
  );

  server.registerTool(
    "delete_project",
    TOOLS.delete_project,
    ({ id }) => run(() => api.projects.delete({ id })),
  );

  server.registerTool(
    "restore_project",
    TOOLS.restore_project,
    ({ id }) => run(() => api.projects.restore({ id })),
  );

  server.registerTool(
    "restore_clip",
    TOOLS.restore_clip,
    ({ id }) => run(() => api.clips.restore({ id })),
  );

  return server;
}

/** Hono handler for `/api/mcp`: one server and transport per request, no session state. */
export async function handleMcp(c: HonoContext, svc: Services, user: AuthUser): Promise<Response> {
  const server = createMcpServer(svc, user, c.req.raw, (c as HonoContext<AppEnv>).get("requestId"));
  const transport = new StreamableHTTPTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return (await transport.handleRequest(c)) ?? c.text("Not found", 404);
}
