import path from "node:path";
import fs from "node:fs/promises";
import { eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import { keys } from "../storage/index.js";
import { QUEUES } from "../queue/boss.js";
import { StageContext, exists } from "./common.js";

export async function ingest(ctx: StageContext) {
  const { svc, projectId } = ctx;
  const project = await ctx.project();
  const dir = await ctx.dir();
  await ctx.start("ingesting");
  await svc.resources.acquire({ kind: "ingest", needDiskMB: 2048, signal: ctx.signal, onWait: (r) => void ctx.progress(0, `Waiting for resources: ${r}`).catch(() => {}) });

  let meta: Record<string, unknown> = project.sourceMeta ?? {};
  let sourcePath: string | undefined;
  let sourceKey = project.sourceKey ?? undefined;

  if (sourceKey && (await svc.storage.exists(sourceKey))) {
    sourcePath = await svc.storage.ensureLocal(sourceKey, path.join(dir, path.posix.basename(sourceKey)));
  } else {
    if (project.sourceType === "url") {
      const { stdout } = await svc.media.ytdlp(
        [
          "--no-playlist",
          "--no-warnings",
          "--newline",
          "--print-json",
          // prefer H.264: decodes everywhere (browser preview, Safari) and renders 3-5x faster than AV1/VP9 on CPU
          "-f",
          "bv*[vcodec^=avc1][height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b",
          "--merge-output-format",
          "mp4",
          "-o",
          path.join(dir, "source.%(ext)s"),
          project.sourceUrl!,
        ],
        {
          signal: ctx.signal,
          onStderr: (line) => {
            const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line);
            if (m) void ctx.progress((Number(m[1]) / 100) * 0.6, "Downloading").catch(() => {});
          },
        },
      );
      const jsonLine = stdout.split("\n").reverse().find((l) => l.trim().startsWith("{"));
      if (jsonLine) {
        const info = JSON.parse(jsonLine) as Record<string, unknown>;
        meta = {
          ...meta,
          title: info.title,
          uploader: info.uploader ?? info.channel ?? meta.uploader,
          duration: info.duration,
          webpage_url: info.webpage_url,
          thumbnail: meta.thumbnail ?? info.thumbnail,
          ext: info.ext,
          description: typeof info.description === "string" ? info.description.slice(0, 4000) : undefined,
          tags: Array.isArray(info.tags) ? info.tags.slice(0, 40) : undefined,
          chapters: Array.isArray(info.chapters) ? (info.chapters as Array<{ title?: string }>).map((c) => c.title).filter(Boolean).slice(0, 40) : undefined,
        };
      }
      const files = (await fs.readdir(dir)).filter((f) => f.startsWith("source."));
      const chosen = files.find((f) => f.endsWith(".mp4")) ?? files[0];
      if (!chosen) throw new Error("yt-dlp finished but no source file was produced");
      sourcePath = path.join(dir, chosen);
    } else {
      const upload = await ctx.db.query.uploads.findFirst({ where: eq(schema.uploads.id, String(project.sourceMeta?.uploadId ?? "")) });
      if (!upload) throw new Error("Uploaded source file is missing");
      const ext = path.extname(upload.storageKey) || ".mp4";
      sourcePath = path.join(dir, `source${ext}`);
      await ctx.progress(0.3, "Fetching upload");
      await svc.storage.ensureLocal(upload.storageKey, sourcePath);
    }
    sourceKey = keys.source(projectId, path.extname(sourcePath) || ".mp4");
    await ctx.progress(0.7, "Storing source");
    await svc.storage.putFile(sourceKey, sourcePath);
  }
  if (!sourcePath || !(await exists(sourcePath))) throw new Error("Source file missing after ingest");

  await ctx.progress(0.9, "Probing media");
  const probe = await svc.media.ffprobe(sourcePath);
  if (!probe.hasAudio) throw new Error("Source has no audio track; nothing to transcribe");

  const generic = !project.title || project.title === "Untitled" || /^[\w.-]+\.[a-z]{2,}$/i.test(project.title); // "Untitled" or a bare hostname
  const title = generic ? ((meta.title as string | undefined) ?? project.title) : project.title;
  await ctx.db
    .update(schema.projects)
    .set({ sourceKey, sourceMeta: meta, durationSec: probe.durationSec, width: probe.width ?? null, height: probe.height ?? null, title, updatedAt: new Date() })
    .where(eq(schema.projects.id, projectId));

  await ctx.complete({ durationSec: probe.durationSec, title });
  await svc.queue.enqueue(QUEUES.transcribe, { projectId });
}
