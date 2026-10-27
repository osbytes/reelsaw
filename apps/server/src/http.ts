import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { serveStatic } from "@hono/node-server/serve-static";
import { trpcServer } from "@hono/trpc-server";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { and, eq, isNull } from "drizzle-orm";
import type { Services } from "./services.js";
import { injectOtelBoot } from "./otel-config.js";
import { isSpaIndexPath } from "./spa-index.js";
import { appRouter } from "./trpc/router.js";
import { contextFactory, type Context as Ctx } from "./trpc/context.js";
import { schema } from "./db/index.js";
import { checkStorageQuota, QuotaError } from "./quota.js";
import { keys } from "./storage/index.js";
import { sendFile } from "./send-file.js";
import { ensureBumperThumb } from "./pipeline/bumpers.js";
import { DEFAULT_BUNDLED_DIR } from "./library/catalog.js";
import { createExportZip, parseClipIds, pickExportClips } from "./export.js";
import { requester, activeRequester, bearerToken, cannotUseApp, mcpResource, API_KEY_PREFIX } from "./auth.js";
import { gateEmailVerification } from "./email-verify.js";
import { requireMcpAuth } from "@better-auth/mcp";
import { handleMcp } from "./mcp.js";
import { createReportZip, reportCapabilities, reportPreview } from "./report/bundle.js";
import { reportRequestSchema, TEXT_FONTS } from "@reelsaw/shared";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assetVisibleTo } from "./library/visible.js";
const execFileAsync = promisify(execFile);
import { requestLogger, logTrpcError, type AppEnv } from "./request-log.js";
import { z } from "zod";
import { runHealthChecks } from "./health.js";
import { planCutPreview, cutPreviewAudio } from "./pipeline/cutpreview.js";
import { TRPCError } from "@trpc/server";
import { clipCaptionsFile, projectTranscriptFile, type CaptionFile, type CaptionFormat } from "./transcript-files.js";

/** What the browser may report: trimmed so a loop of errors cannot fill the log. */
const clientLogSchema = z.object({
  kind: z.enum(["render", "error", "unhandledrejection", "network"]).default("error"),
  message: z.string().max(1000).transform((s) => s.slice(0, 500)),
  stack: z.string().optional().transform((s) => s?.slice(0, 2048)),
  route: z.string().max(300).optional(),
});

class UploadTooLarge extends Error {}

/**
 * Headers set after the handler ran. A Response.redirect() (or one passed through from fetch) has
 * immutable headers: such a response goes out without these rather than failing.
 */
function afterHeaders(c: Context<AppEnv>, headers: Record<string, string>) {
  try {
    for (const [k, v] of Object.entries(headers)) if (!c.res.headers.has(k)) c.res.headers.set(k, v);
  } catch {
    // immutable headers
  }
}

export function createApp(svc: Services) {
  const { config, auth, storage, paths } = svc;
  const db = svc.database.db;
  const app = new Hono<AppEnv>();
  // request id + access log (request-log.ts); every handler logs through c.get("log")
  app.use(requestLogger(svc.log));
  // The built SPA's id (hash of its index.html). Every API response carries it, and the page carries
  // the one it was served from, so a tab left open across a deploy notices and reloads on its next
  // route change instead of asking for chunks that are gone (apps/web/src/lib/stale-chunk.ts).
  const webIndex = config.WEB_DIST && fs.existsSync(path.join(config.WEB_DIST, "index.html")) ? fs.readFileSync(path.join(config.WEB_DIST, "index.html"), "utf8") : null;
  const webBuild = webIndex ? createHash("sha256").update(webIndex).digest("hex").slice(0, 12) : null;
  if (webBuild) {
    app.use("/api/*", async (c, next) => {
      await next();
      afterHeaders(c, { "X-Reelsaw-Build": webBuild });
    });
  }
  // an exception in a handler: the access line above logs it with `err`; the client gets the request id to quote
  app.onError((err, c) => (err instanceof HTTPException ? err.getResponse() : c.json({ error: "internal error", requestId: c.get("requestId") }, 500)));
  /** the signed-in, allowed account behind a request; also stamps the user on the access line */
  const actor = async (c: Context<AppEnv>) => {
    const who = await activeRequester(auth, db, c.req.raw.headers);
    if (who) c.set("userId", who.user.id);
    return who;
  };
  // No page of this app is meant to be framed (the OAuth consent screen least of all), no response
  // is meant to be sniffed into another type, and links out don't need the full URL.
  app.use(async (c, next) => {
    await next();
    afterHeaders(c, { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY" });
  });
  app.use(
    "/api/*",
    cors({
      // the Vite dev server only outside production: any local process on :5173 could otherwise call in with the user's cookie
      origin: config.NODE_ENV === "production" ? [config.APP_URL] : [config.APP_URL, "http://localhost:5173"],
      credentials: true,
      allowHeaders: ["Content-Type", "Authorization", "x-api-key", "x-filename", "trpc-accept", "mcp-session-id", "mcp-protocol-version", "traceparent", "tracestate", "baggage", "last-event-id"],
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    }),
  );

  const version = { version: svc.config.REELSAW_VERSION, commit: svc.config.REELSAW_COMMIT, builtAt: svc.config.REELSAW_BUILT_AT };
  // Public OTLP config for the browser. The production HTML embeds the same object so the SDK
  // starts before the first API call; Vite dev has no embed and fetches this instead.
  app.get("/api/otel", (c) => c.json(svc.otel.public));
  // readiness for anyone: 200 when the database, event listener, job queue and (with workers) this process's heartbeat all
  // answer within 2 s each, else 503 with the same `checks` map saying which did not (health.ts). Machine numbers for
  // admins (or HEALTH_DETAILS=true on a private network).
  app.get("/api/health", async (c) => {
    const open = svc.settings.get().HEALTH_DETAILS;
    const who = open ? null : await activeRequester(auth, db, c.req.raw.headers);
    const details = open || who?.user.role === "admin";
    const { ok, checks } = await runHealthChecks(svc);
    return c.json({ ok, checks, ...version, ...(details ? { resources: await svc.resources.snapshot() } : {}) }, ok ? 200 : 503);
  });
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    if (c.req.method === "GET" && c.req.path === "/api/auth/verify-email") {
      const gate = await gateEmailVerification(db, c.req.query("token") ?? "");
      if (!gate.ok) {
        const to = new URL("/login", config.APP_URL);
        to.searchParams.set("error", gate.error);
        if (gate.email) to.searchParams.set("email", gate.email);
        c.get("log").info({ error: gate.error }, "verify-email refused");
        return c.redirect(`${to.pathname}${to.search}`);
      }
    }
    const res = await auth.handler(c.req.raw);
    logAuth(c, res.status);
    return res;
  });
  /** sign-in, sign-up and API key actions: who did what, and why a sign-in failed (never the password) */
  const AUTH_ACTIONS: Record<string, string> = { "/sign-in/email": "sign-in", "/sign-up/email": "sign-up", "/sign-out": "sign-out", "/request-password-reset": "password reset requested", "/reset-password": "password reset", "/send-verification-email": "verification email requested", "/api-key/create": "api key created", "/api-key/delete": "api key revoked", "/api-key/update": "api key updated" };
  const logAuth = (c: Context<AppEnv>, status: number) => {
    const action = AUTH_ACTIONS[c.req.path.replace(/^\/api\/auth/, "")];
    if (!action || c.req.method !== "POST") return;
    const log = c.get("log");
    if (status < 400) {
      if (action === "sign-in" || action === "sign-up" || action === "password reset") return; // logged with the user id in auth.ts
      void auth.api.getSession({ headers: c.req.raw.headers }).then((s) => log.info({ action, status, userId: s?.user.id }, "auth"), () => log.info({ action, status }, "auth"));
    } else log[status >= 500 ? "error" : "warn"]({ action, status, reason: status === 401 ? "bad credentials or unknown account" : status === 403 ? "not allowed (unverified email, waiting for approval, captcha or suspended)" : status === 422 ? "sign-up refused" : status === 429 ? "rate limited" : "rejected" }, "auth failed");
  };
  // OAuth discovery lives at the origin root (RFC 8414 / 9728). The plugin matches the request's
  // own pathname (root well-known paths, with the resource path suffix), so the raw request goes through.
  if (config.MCP_OAUTH) app.get("/.well-known/*", (c) => auth.handler(c.req.raw));
  // Stripe webhooks (ee): raw body (bounded: events are a few hundred KB at most, and the signature is checked only after
  // the body is read), 2xx only once the event and its sync job committed
  if (svc.ee) app.post("/api/billing/webhook", bodyLimit({ maxSize: 1024 * 1024 }), (c) => svc.ee!.webhook(c));
  app.use("/api/trpc/*", trpcServer({ router: appRouter, endpoint: "/api/trpc", createContext: contextFactory(svc),
      onError: ({ error, path, type, ctx }) => {
        const c = ctx as Ctx | undefined;
        logTrpcError(c?.log ?? svc.log.child({ module: "http" }), { path, type, code: error.code, requestId: c?.requestId, userId: c?.who?.user.id, err: error });
        if (error.code === "INTERNAL_SERVER_ERROR") svc.telemetry.captureException(error.cause ?? error, { procedure: path, type, requestId: c?.requestId, userId: c?.who?.user.id });
      },
    }));

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
        const why = cannotUseApp(user, "oauth");
        if (why) return c.json({ error: "forbidden", message: why }, 403);
          return handleMcp(c, svc, user);
        },
        // the JWKS is served by this very process: fetch it over loopback, not through APP_URL (which may not resolve from inside a container)
        { resource: mcpResource(config), jwksUrl: `http://127.0.0.1:${config.PORT}/api/auth/jwks` },
      );
      return guarded(c.req.raw);
    }
    const who = await requester(auth, db, c.req.raw.headers);
    if (!who) return mcpUnauthorized(c);
    const why = cannotUseApp(who.user, who.via);
    if (why) return c.json({ error: "forbidden", message: why }, 403);
    return handleMcp(c, svc, who.user);
  });

  // Raw upload: body is the file, original name in x-filename. Streams to disk, then into storage.
  app.post("/api/upload", async (c) => {
    const session = await actor(c);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const filename = decodeURIComponent(c.req.header("x-filename") ?? "upload.mp4").replace(/[\\/]/g, "_").slice(0, 200);
    const length = Number(c.req.header("content-length") ?? 0);
    const maxUploadMb = svc.settings.get().MAX_UPLOAD_MB;
    if (length > maxUploadMb * 1024 * 1024) {
      c.get("log").warn({ bytes: length, maxMb: maxUploadMb }, "upload rejected: too large");
      return c.json({ error: `file exceeds ${maxUploadMb} MB` }, 413);
    }
    try {
      await checkStorageQuota(db, svc.settings.get(), session.user.id, length, svc.entitlements);
    } catch (err) {
      c.get("log").warn({ bytes: length, reason: (err as Error).message }, "upload rejected: storage limit");
      const quota = err instanceof QuotaError ? err.quota : undefined;
      return c.json({ error: (err as Error).message, ...(quota ? { quota } : {}) }, 429);
    }
    // refuse before writing a byte rather than fill the disk the pipeline needs (a read, not a lease: the file is gone after the copy to the store)
    const freeMB = (await svc.resources.snapshot()).diskFreeMB;
    const needMB = svc.config.MIN_FREE_DISK_MB + Math.ceil(length / 1048576);
    if (freeMB >= 0 && freeMB < needMB) {
      c.get("log").warn({ bytes: length, freeMB, needMB }, "upload rejected: not enough disk");
      return c.json({ error: "This server is low on disk space right now. Try again later, or ask the administrator to free some space." }, 507);
    }
    if (!c.req.raw.body) return c.json({ error: "empty body" }, 400);
    const id = randomUUID();
    const ext = path.extname(filename).toLowerCase() || ".mp4";
    const dest = path.join(paths.uploads, `${id}${ext}`);
    // chunked bodies carry no content-length: count the bytes as they stream and stop at the cap
    const maxBytes = maxUploadMb * 1024 * 1024;
    let received = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        cb(received > maxBytes ? new UploadTooLarge() : null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(c.req.raw.body as never), cap, fs.createWriteStream(dest));
      const st = await fsp.stat(dest);
      if (st.size === 0) throw new Error("empty file");
      const storageKey = keys.upload(id, ext);
      await storage.putFile(storageKey, dest);
      try {
        await db.insert(schema.uploads).values({ id, userId: session.user.id, filename, storageKey, sizeBytes: st.size });
      } catch (err) {
        // put first (the row must never point at a missing object), so a failed insert leaves an orphan: remove it
        await storage.delete(storageKey).catch((e) => c.get("log").warn({ err: e, storageKey }, "could not remove the orphaned upload object"));
        throw err;
      }
      c.get("log").info({ uploadId: id, bytes: st.size }, "upload stored");
      return c.json({ uploadId: id, filename, sizeBytes: st.size });
    } catch (err) {
      if (err instanceof UploadTooLarge) {
        c.get("log").warn({ bytes: received, maxMb: maxUploadMb }, "upload rejected: too large");
        return c.json({ error: `file exceeds ${maxUploadMb} MB` }, 413);
      }
      c.get("log").error({ err, uploadId: id }, "upload failed");
      return c.json({ error: (err as Error).message }, 500);
    } finally {
      await fsp.rm(dest, { force: true });
    }
  });

  // A user's own intro/outro, for the Settings preview. Owner only; soft-deleted assets stay readable by their owner.
  // The font files text overlays can use, from the image's own fontconfig, so the editor preview draws
  // exactly what libass will. Public: a font file is not user data. Long cache: the files never change.
  app.get("/api/fonts/:family", async (c) => {
    const family = TEXT_FONTS.find((f) => f.family === c.req.param("family"))?.family;
    if (!family) return c.text("unknown font", 404);
    try {
      const { stdout } = await execFileAsync("fc-match", ["-f", "%{file}|%{family}", family]);
      const [file, matched] = stdout.trim().split("|");
      // fc-match falls back to any font when the family is missing: refuse that instead of serving the wrong face
      if (!file || !matched || !matched.split(",").some((m) => m.trim().toLowerCase() === family.toLowerCase())) return c.text("font not installed", 404);
      c.header("Cache-Control", "public, max-age=604800, immutable");
      return sendFile(c.req.raw, file);
    } catch (err) {
      c.get("log").warn({ err, family }, "font lookup failed");
      return c.text("font not available", 404);
    }
  });

  // The starter pack bundled with the install (assets/catalog/files): public, nothing user-specific, content-addressed by id.
  app.get("/media/catalog/:file", async (c) => {
    const name = c.req.param("file");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) return c.text("not found", 404);
    const file = path.join(DEFAULT_BUNDLED_DIR, "files", name);
    if (!(await fsp.stat(file).then((s) => s.isFile(), () => false))) return c.text("not found", 404);
    const res = await sendFile(c.req.raw, file);
    res.headers.set("Cache-Control", "public, max-age=86400");
    // static pack files only; the extension decides the type (the shared map has no svg until the library widens it)
    if (name.endsWith(".svg")) res.headers.set("Content-Type", "image/svg+xml");
    // a bundled SVG is ours, but never let a catalog file run script in the app's origin
    res.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return res;
  });

  // `/media/bumpers/...` is the old spelling: rendered pages and MCP results carried it for a release
  app.on("GET", ["/media/assets/:id", "/media/bumpers/:id"], async (c) => {
    const session = await actor(c);
    if (!session) return c.text("unauthorized", 401);
    const asset = await db.query.assets.findFirst({ where: and(eq(schema.assets.id, c.req.param("id")), assetVisibleTo(session.user.id)) });
    if (!asset) return c.text("not found", 404);
    const loc = await storage.resolve(asset.sourceKey);
    if ("url" in loc) return c.redirect(loc.url, 302);
    const res = await sendFile(c.req.raw, loc.file);
    // an uploaded SVG is a document: never let one run script or load anything in the app's origin
    if (asset.mime === "image/svg+xml" || asset.sourceKey.endsWith(".svg")) res.headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return res;
  });

  // Picker thumbnail. Older assets get theirs on first request.
  app.on("GET", ["/media/assets/:id/thumb.jpg", "/media/bumpers/:id/thumb.jpg"], async (c) => {
    const session = await actor(c);
    if (!session) return c.text("unauthorized", 401);
    const asset = await db.query.assets.findFirst({ where: and(eq(schema.assets.id, c.req.param("id")), assetVisibleTo(session.user.id)) });
    if (!asset) return c.text("not found", 404);
    let key = asset.thumbnailKey ?? keys.assetThumb(asset.sourceKey);
    if (!asset.thumbnailKey || !(await storage.exists(key))) {
      try {
        key = await ensureBumperThumb({ ffmpeg: (a) => svc.media.ffmpeg(a), storage, dir: paths.tmp }, asset, undefined);
        await db.update(schema.assets).set({ thumbnailKey: key }).where(eq(schema.assets.id, asset.id));
      } catch (err) {
        c.get("log").warn({ err, bumperId: asset.id }, "bumper thumbnail failed");
        return c.text("no thumbnail", 404);
      }
    }
    const loc = await storage.resolve(key);
    if ("url" in loc) return c.redirect(loc.url, 302);
    return sendFile(c.req.raw, loc.file);
  });

  app.get("/media/clips/:projectId/:file", async (c) => {
    const session = await actor(c);
    if (!session) return c.text("unauthorized", 401);
    const { projectId, file } = c.req.param();
    const clipId = file.replace(/\.(mp4|jpg)$/, "");
    const clip = await db.query.clips.findFirst({ where: and(eq(schema.clips.id, clipId), eq(schema.clips.projectId, projectId)) });
    // a replaced clip's files still play (to decide whether to restore it); a deleted project's do not
    const project = clip && (await db.query.projects.findFirst({ where: and(eq(schema.projects.id, projectId), eq(schema.projects.userId, session.user.id), isNull(schema.projects.deletedAt)) }));
    if (!clip || !project) return c.text("not found", 404);
    const key = file.endsWith(".jpg") ? clip.thumbnailKey : clip.outputKey;
    if (!key) return c.text("not ready", 404);
    const download = c.req.query("download") !== undefined;
    const name = `${String(clip.index + 1).padStart(2, "0")}-${clip.title.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60)}.mp4`;
    const loc = await storage.resolve(key, { downloadName: download ? name : undefined });
    if ("url" in loc) return c.redirect(loc.url, 302);
    return sendFile(c.req.raw, loc.file, download ? name : undefined, { revalidate: true });
  });

  // Bulk export: zip of all rendered clips + YouTube/TikTok metadata
  app.get("/api/projects/:projectId/export.zip", async (c) => {
    const session = await actor(c);
    if (!session) return c.text("unauthorized", 401);
    const projectId = c.req.param("projectId");
    const project = await db.query.projects.findFirst({ where: and(eq(schema.projects.id, projectId), eq(schema.projects.userId, session.user.id), isNull(schema.projects.deletedAt)) });
    if (!project) return c.text("not found", 404);
    const [clips, transcript] = await Promise.all([
      db.query.clips.findMany({ where: and(eq(schema.clips.projectId, projectId), isNull(schema.clips.deletedAt)) }),
      db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId), columns: { language: true } }),
    ]);
    const ids = parseClipIds(c.req.query("clips"));
    if (!ids) return c.text("bad clips list", 400);
    const picked = pickExportClips(clips, ids);
    if (picked.unknown.length) return c.text("some of those clips are not in this project", 404);
    if (!picked.clips.some((cl) => cl.status === "done" && cl.outputKey)) return c.text("no rendered clips yet", 409);
    const { stream, filename } = await createExportZip({ storage, paths, log: c.get("log") }, { project, clips: picked.clips, language: transcript?.language ?? null, subset: picked.subset });
    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    c.header("Cache-Control", "no-store");
    return c.body(Readable.toWeb(stream) as ReadableStream);
  });

  // SRT / VTT downloads: a clip's burned-in captions and a project's transcript. Owner only; `?words=1` adds word times to VTT.
  const sendCaptionFile = async (c: Context<AppEnv>, make: (who: { id: string; admin: false }, format: CaptionFormat, words: boolean) => Promise<CaptionFile>, ext: string) => {
    const session = await actor(c);
    if (!session) return c.text("unauthorized", 401);
    const format = ext === "vtt" ? "vtt" : "srt";
    try {
      const file = await make({ id: session.user.id, admin: false }, format, boolQuery(c.req.query("words"), false));
      c.header("Content-Type", format === "vtt" ? "text/vtt; charset=utf-8" : "application/x-subrip; charset=utf-8");
      c.header("Content-Disposition", `attachment; filename="${file.filename.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
      c.header("Cache-Control", "no-store");
      return c.body(file.text);
    } catch (err) {
      if (err instanceof TRPCError && err.code === "NOT_FOUND") return c.text(err.message || "not found", 404);
      throw err;
    }
  };
  app.get("/api/clips/:id/:file{captions\\.(srt|vtt)}", (c) =>
    sendCaptionFile(c, (who, format, words) => clipCaptionsFile(svc, who, c.req.param("id"), { format, words }), c.req.param("file").slice(-3)),
  );
  app.get("/api/projects/:projectId/:file{transcript\\.(srt|vtt)}", (c) =>
    sendCaptionFile(c, (who, format, words) => projectTranscriptFile(svc, who, c.req.param("projectId"), { format, words }), c.req.param("file").slice(-3)),
  );

  // "Report an issue": zip of the project's (or account's) data for local reproduction; owner only.
  // Hosted non-admins with telemetry use Sentry/PostHog feedback instead (reportCapabilities).
  app.get("/api/projects/:projectId/report/preview", async (c) => {
    const session = await actor(c);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const caps = reportCapabilities(svc, session.user);
    if (!caps.zip) return c.json({ error: "Send feedback from the app instead of downloading a report on this instance." }, 403);
    const info = await reportPreview(svc, session.user.id, c.req.param("projectId"));
    return info ? c.json(info) : c.json({ error: "not found" }, 404);
  });
  const boolQuery = (v: string | undefined, fallback: boolean) => (v === undefined ? fallback : v === "1" || v === "true");
  const reportFromQuery = (c: Context) => {
    const clipIds = (c.req.query("clipIds") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return reportRequestSchema.safeParse({
      description: c.req.query("description") ?? "",
      clipIds,
      include: {
        logs: boolQuery(c.req.query("logs"), true),
        system: boolQuery(c.req.query("system"), true),
        instance: boolQuery(c.req.query("instance"), false),
        previews: boolQuery(c.req.query("previews"), true),
        allClips: boolQuery(c.req.query("allClips"), false),
        source: boolQuery(c.req.query("source"), false),
      },
      client: { route: c.req.query("route") ?? "mcp" },
    });
  };
  const sendReport = async (c: Context, projectId: string | null) => {
    const session = await actor(c);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const caps = reportCapabilities(svc, session.user);
    if (!caps.zip) return c.json({ error: "Send feedback from the app instead of downloading a report on this instance." }, 403);
    const parsed = c.req.method === "GET" ? reportFromQuery(c) : reportRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid report" }, 400);
    const zip = await createReportZip(svc, session.user, projectId, parsed.data);
    if (!zip) return c.json({ error: "not found" }, 404);
    c.header("Content-Type", "application/zip");
    c.header("Content-Disposition", `attachment; filename="${zip.filename}"`);
    c.header("Cache-Control", "no-store");
    return c.body(Readable.toWeb(zip.stream) as ReadableStream);
  };
  app.on(["GET", "POST"], "/api/projects/:projectId/report", (c) => sendReport(c, c.req.param("projectId")));
  app.on(["GET", "POST"], "/api/report", (c) => sendReport(c, null));

  // The browser reports an error it caught (ErrorBoundary, window handlers); logged as a warn with the user and route.
  const clientLogHits = new Map<string, number[]>();
  app.post("/api/client-log", async (c) => {
    const session = await actor(c);
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const now = Date.now();
    const hits = (clientLogHits.get(session.user.id) ?? []).filter((t) => now - t < 60_000);
    if (hits.length >= 10) return c.json({ error: "slow down" }, 429);
    hits.push(now);
    clientLogHits.set(session.user.id, hits);
    if (clientLogHits.size > 1000) for (const [k, v] of clientLogHits) if (!v.some((t) => now - t < 60_000)) clientLogHits.delete(k);
    const parsed = clientLogSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid" }, 400);
    c.get("log").child({ module: "web" }).warn({ route: parsed.data.route, kind: parsed.data.kind, clientMessage: parsed.data.message, stack: parsed.data.stack, userAgent: c.req.header("user-agent")?.slice(0, 200) }, "client error");
    return c.body(null, 204);
  });

  // A/B preview of a disfluency cut (transcript popover): plan = which boundaries, audio = mp3 of the window
  app.get("/api/projects/:projectId/flags/:flagId/cut-plan", async (c) => {
    const session = await actor(c);
    if (!session) return c.text("unauthorized", 401);
    const { projectId, flagId } = c.req.param();
    const plan = await planCutPreview(svc, session.user.id, projectId, flagId, { exact: c.req.query("exact") === "1", signal: c.req.raw.signal });
    return plan ? c.json(plan) : c.text("not found", 404);
  });
  app.get("/api/projects/:projectId/flags/:flagId/preview.mp3", async (c) => {
    const session = await actor(c);
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
    const session = await actor(c);
    if (!session) return c.text("unauthorized", 401);
    const project = await db.query.projects.findFirst({ where: and(eq(schema.projects.id, c.req.param("projectId")), eq(schema.projects.userId, session.user.id), isNull(schema.projects.deletedAt)) });
    if (!project?.sourceKey) return c.text("not found", 404);
    const loc = await storage.resolve(project.sourceKey);
    if ("url" in loc) return c.redirect(loc.url, 302);
    return sendFile(c.req.raw, loc.file);
  });

  // Static SPA (production build of apps/web) with history fallback.
  // Client routes have no file extension (`/signup`). A missing `/favicon.ico` (or .png, .txt, …)
  // must 404, not return this HTML: crawlers request /favicon.ico by convention, and serving the
  // shell there is why app.reelsaw.com showed a generic globe in Google Search.
  // Hashed files under /assets/ never change, so they cache for a year; the HTML must revalidate
  // every load or a tab boots an old chunk map after a deploy.
  if (config.WEB_DIST && webIndex && webBuild) {
    const index = injectOtelBoot(webIndex, svc.otel.public).replace("</head>", `<meta name="reelsaw-build" content="${webBuild}" /></head>`);
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
    });
    const shell = (c: Context<AppEnv>) => {
      c.header("Cache-Control", "no-cache");
      c.header("Content-Security-Policy", "frame-ancestors 'none'");
      return c.html(index);
    };
    // before serveStatic, which would send the raw dist/index.html (no build id, no OTEL config) for these
    app.get("/", shell);
    app.get("/index.html", shell);
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), config.WEB_DIST) || "." }));
    app.get("*", (c) => (isSpaIndexPath(c.req.path) ? shell(c) : c.notFound()));
  }

  return app;
}
