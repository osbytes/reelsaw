import { Hono } from "hono";
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
      allowHeaders: ["Content-Type", "Authorization", "x-filename", "trpc-accept"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  app.get("/api/health", async (c) => c.json({ ok: true, resources: await svc.resources.snapshot() }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  app.use("/api/trpc/*", trpcServer({ router: appRouter, endpoint: "/api/trpc", createContext: contextFactory(svc) }));

  // Raw upload: body is the file, original name in x-filename. Streams to disk, then into storage.
  app.post("/api/upload", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
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
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
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
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
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

  app.get("/media/source/:projectId", async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
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
