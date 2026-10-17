import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { trpcServer } from "@hono/trpc-server";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import type { Services } from "./services.js";
import { appRouter } from "./trpc/router.js";
import { contextFactory } from "./trpc/context.js";
import { schema } from "./db/index.js";
import { keys, contentTypeFor } from "./storage/index.js";
import { createExportZip } from "./export.js";
import { requester, activeRequester, bearerToken, blockedReason, mcpResource, API_KEY_PREFIX } from "./auth.js";
import { requireMcpAuth } from "@better-auth/mcp";
import { handleMcp } from "./mcp.js";
import { createReportZip, reportPreview } from "./report/bundle.js";
import { reportRequestSchema } from "@reelsaw/shared";
import { planCutPreview, cutPreviewAudio } from "./pipeline/cutpreview.js";

/** Range-capable file response for video playback. */
async function sendFile(req: Request, file: string, downloadName?: string): Promise<Response> {
  let st: fs.Stats;
  try {
    st = await fsp.stat(file);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const headers: Record<string, string> = { "Content-Type": contentTypeFor(file), "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600" };
  if (downloadName) headers["Content-Disposition"] = `attachment; filename="${downloadName.replace(/"/g, "")}"`;
  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "");
  if (m) {
    if (m[1]) start = Number(m[1]);
    if (m[2]) end = Number(m[2]);
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

export function createApp(svc: Services) {
  const { config, auth, storage, paths } = svc;
  const db = svc.database.db;
  const app = new Hono();
  // structured access log; health checks and static assets only at debug
  const httpLog = svc.log.child({ module: "http" });
  app.use(async (c, next) => {
    const t0 = performance.now();
    await next();
    const path = c.req.path;
    const quiet = path === "/api/health" || path.startsWith("/assets/") || c.req.method === "OPTIONS";
    const entry = { method: c.req.method, path, status: c.res.status, ms: Math.round(performance.now() - t0) };
    if (c.res.status >= 500) httpLog.error(entry, "request failed");
    else if (quiet) httpLog.debug(entry, "request");
    else httpLog.info(entry, "request");
  });
  app.use(
    "/api/*",
    cors({
      origin: [config.APP_URL, "http://localhost:5173"],
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization", "x-api-key", "x-filename", "trpc-accept", "mcp-session-id", "mcp-protocol-version"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  const version = { version: svc.config.REELSAW_VERSION, commit: svc.config.REELSAW_COMMIT, builtAt: svc.config.REELSAW_BUILT_AT };
  // liveness for anyone; machine numbers for admins (or HEALTH_DETAILS=true on a private network)
  app.get("/api/health", async (c) => {
    const who = config.HEALTH_DETAILS ? null : await activeRequester(auth, db, c.req.raw.headers);
    const details = config.HEALTH_DETAILS || who?.user.role === "admin";
    return c.json({ ok: true, ...version, ...(details ? { resources: await svc.resources.snapshot() } : {}) });
  });
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  // OAuth discovery lives at the origin root (RFC 8414 / 9728). The plugin matches the request's
  // own pathname (root well-known paths, with the resource path suffix), so the raw request goes through.
  if (config.MCP_OAUTH) app.get("/.well-known/*", (c) => auth.handler(c.req.raw));
  app.use("/api/trpc/*", trpcServer({ router: appRouter, endpoint: "/api/trpc", createContext: contextFactory(svc) }));

  // MCP (agents): API key in the Authorization header; see README "MCP" and src/mcp.ts
  const mcpUnauthorized = (c: Context) =>
    c.json({ error: "unauthorized", hint: "Send an API key from Settings as `Authorization: Bearer rs_…`" }, 401, {
      "WWW-Authenticate": config.MCP_OAUTH ? `Bearer realm="reelsaw", resource_metadata="${new URL("/.well-known/oauth-protected-resource/api/mcp", config.APP_URL)}"` : 'Bearer realm="reelsaw"',
    });
  app.all("/api/mcp", async (c) => {
    const token = bearerToken(c.req.raw.headers);
    // an OAuth access token (not one of our rs_ keys): the plugin verifies it and names the user in `sub`
    if (config.MCP_OAUTH && token && !token.startsWith(API_KEY_PREFIX)) {
      const guarded = requireMcpAuth(
        auth,
        async (_req, claims) => {
        const user = claims.sub ? await db.query.user.findFirst({ where: eq(schema.user.id, claims.sub) }) : undefined;
        if (!user) return c.json({ error: "unauthorized" }, 401);
        const blocked = blockedReason(user);
        if (blocked) return c.json({ error: "forbidden", message: blocked.reason }, 403);
          return handleMcp(c, svc, user);
        },
        // the JWKS is served by this very process: fetch it over loopback, not through APP_URL (which may not resolve from inside a container)
        { resource: mcpResource(config), jwksUrl: `http://127.0.0.1:${config.PORT}/api/auth/jwks` },
      );
      return guarded(c.req.raw);
    }
    const who = await requester(auth, db, c.req.raw.headers);
    if (!who) return mcpUnauthorized(c);
    if (who.blocked) return c.json({ error: "forbidden", message: who.blocked.reason }, 403);
    return handleMcp(c, svc, who.user);
  });

  // Raw upload: body is the file, original name in x-filename. Streams to disk, then into storage.
  app.post("/api/upload", async (c) => {
    const session = await activeRequester(auth, db, c.req.raw.headers);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const filename = decodeURIComponent(c.req.header("x-filename") ?? "upload.mp4").replace(/[\\/]/g, "_").slice(0, 200);
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > config.MAX_UPLOAD_MB * 1024 * 1024) return c.json({ error: `file exceeds ${config.MAX_UPLOAD_MB} MB` }, 413);
    if (!c.req.raw.body) return c.json({ error: "empty body" }, 400);
    const id = randomUUID();
    const ext = path.extname(filename).toLowerCase() || ".mp4";
    const dest = path.join(paths.uploads, `${id}${ext}`);
    try {
      await pipeline(Readable.fromWeb(c.req.raw.body as never), fs.createWriteStream(dest));
      const st = await fsp.stat(dest);
      if (st.size === 0) throw new Error("empty file");
      const storageKey = keys.upload(id, ext);
      await storage.putFile(storageKey, dest);
      await db.insert(schema.uploads).values({ id, userId: session.user.id, filename, storageKey, sizeBytes: st.size });
      return c.json({ uploadId: id, filename, sizeBytes: st.size });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    } finally {
      await fsp.rm(dest, { force: true });
    }
  });

  app.get("/media/clips/:projectId/:file", async (c) => {
    const session = await activeRequester(auth, db, c.req.raw.headers);
    if (!session) return c.text("unauthorized", 401);
    const { projectId, file } = c.req.param();
    const clipId = file.replace(/\.(mp4|jpg)$/, "");
    const clip = await db.query.clips.findFirst({ where: and(eq(schema.clips.id, clipId), eq(schema.clips.projectId, projectId)) });
    const project = clip && (await db.query.projects.findFirst({ where: and(eq(schema.projects.id, projectId), eq(schema.projects.userId, session.user.id)) }));
    if (!clip || !project) return c.text("not found", 404);
    const key = file.endsWith(".jpg") ? clip.thumbnailKey : clip.outputKey;
    if (!key) return c.text("not ready", 404);
    const download = c.req.query("download") !== undefined;
    const name = `${String(clip.index + 1).padStart(2, "0")}-${clip.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60)}.mp4`;
    const loc = await storage.resolve(key, { downloadName: download ? name : undefined });
    if ("url" in loc) return c.redirect(loc.url, 302);
    return sendFile(c.req.raw, loc.file, download ? name : undefined);
  });

  // Bulk export: zip of all rendered clips + YouTube/TikTok metadata
  app.get("/api/projects/:projectId/export.zip", async (c) => {
    const session = await activeRequester(auth, db, c.req.raw.headers);
    if (!session) return c.text("unauthorized", 401);
    const projectId = c.req.param("projectId");
    const project = await db.query.projects.findFirst({ where: and(eq(schema.projects.id, projectId), eq(schema.projects.userId, session.user.id)) });
    if (!project) return c.text("not found", 404);
    const [clips, transcript] = await Promise.all([
      db.query.clips.findMany({ where: eq(schema.clips.projectId, projectId) }),
      db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId), columns: { language: true } }),
    ]);
    if (!clips.some((cl) => cl.status === "done" && cl.outputKey)) return c.text("no rendered clips yet", 409);
    const { stream, filename } = await createExportZip({ storage, paths }, { project, clips, language: transcript?.language ?? null });
    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    c.header("Cache-Control", "no-store");
    return c.body(Readable.toWeb(stream) as ReadableStream);
  });

  // "Report an issue": zip of the project's (or account's) data for local reproduction; owner only
  app.get("/api/projects/:projectId/report/preview", async (c) => {
    const session = await activeRequester(auth, db, c.req.raw.headers);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const info = await reportPreview(svc, session.user.id, c.req.param("projectId"));
    return info ? c.json(info) : c.json({ error: "not found" }, 404);
  });
  const sendReport = async (c: Context, projectId: string | null) => {
    const session = await activeRequester(auth, db, c.req.raw.headers);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const parsed = reportRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid report" }, 400);
    const zip = await createReportZip(svc, session.user.id, projectId, parsed.data);
    if (!zip) return c.json({ error: "not found" }, 404);
    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", `attachment; filename="${zip.filename}"`);
    c.header("Cache-Control", "no-store");
    return c.body(Readable.toWeb(zip.stream) as ReadableStream);
  };
  app.post("/api/projects/:projectId/report", (c) => sendReport(c, c.req.param("projectId")));
  app.post("/api/report", (c) => sendReport(c, null));

  // A/B preview of a disfluency cut (transcript popover): plan = which boundaries, audio = mp3 of the window
  app.get("/api/projects/:projectId/flags/:flagId/cut-plan", async (c) => {
    const session = await activeRequester(auth, db, c.req.raw.headers);
    if (!session) return c.text("unauthorized", 401);
    const { projectId, flagId } = c.req.param();
    const plan = await planCutPreview(svc, session.user.id, projectId, flagId, { exact: c.req.query("exact") === "1", signal: c.req.raw.signal });
    return plan ? c.json(plan) : c.text("not found", 404);
  });
  app.get("/api/projects/:projectId/flags/:flagId/preview.mp3", async (c) => {
    const session = await activeRequester(auth, db, c.req.raw.headers);
    if (!session) return c.text("unauthorized", 401);
    const { projectId, flagId } = c.req.param();
    const num = (k: string) => {
      const v = c.req.query(k);
      return v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v);
    };
    const cs = num("cutStart");
    const ce = num("cutEnd");
    const audio = await cutPreviewAudio(svc, session.user.id, projectId, flagId, { pad: num("pad") ?? 2, cut: cs !== undefined && ce !== undefined && ce > cs ? { start: cs, end: ce } : undefined, signal: c.req.raw.signal });
    if (!audio) return c.text("not found", 404);
    c.header("Content-Type", "audio/mpeg");
    c.header("Cache-Control", "private, max-age=3600");
    return c.body(new Uint8Array(audio));
  });

  app.get("/media/source/:projectId", async (c) => {
    const session = await activeRequester(auth, db, c.req.raw.headers);
    if (!session) return c.text("unauthorized", 401);
    const project = await db.query.projects.findFirst({ where: and(eq(schema.projects.id, c.req.param("projectId")), eq(schema.projects.userId, session.user.id)) });
    if (!project?.sourceKey) return c.text("not found", 404);
    const loc = await storage.resolve(project.sourceKey);
    if ("url" in loc) return c.redirect(loc.url, 302);
    return sendFile(c.req.raw, loc.file);
  });

  // Static SPA (production build of apps/web) with history fallback
  if (config.WEB_DIST && fs.existsSync(config.WEB_DIST)) {
    const index = fs.readFileSync(path.join(config.WEB_DIST, "index.html"), "utf8");
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), config.WEB_DIST) || "." }));
    app.get("*", (c) => (c.req.path.startsWith("/api/") || c.req.path.startsWith("/media/") ? c.notFound() : c.html(index)));
  }

  return app;
}
