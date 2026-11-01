/**
 * SRT / VTT in and out. The captions a clip was rendered with and a project's transcript leave as
 * files; a transcript made elsewhere (a subtitle export, a caption service) comes in and replaces
 * transcribing. The tRPC procedures (`clips.captions`, `projects.transcriptFile`,
 * `projects.importTranscript`), the download routes, the MCP tools and the CLI all call these functions.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { cuesToTranscript, linesFromTranscript, parseCaptions, toSrt, toVtt, type CaptionLine } from "@reelsaw/shared";
import { schema } from "./db/index.js";
import type { Services } from "./services.js";
import { slugify } from "./export.js";
import { stageSeqOf, startRun } from "./pipeline/lifecycle.js";
import { enqueueRefine } from "./pipeline/refine.js";
import { releaseUpload } from "./storage/uploads.js";
import { bodyChunks, fetchPublic, TooManyRedirectsError, UnsafeUrlError } from "./lib/safe-url.js";
import type { Actor } from "./projects/service.js";

export type CaptionFormat = "srt" | "vtt";

export interface CaptionFile {
  format: CaptionFormat;
  text: string;
  filename: string;
  /** cues in the file */
  lines: number;
}

/** The biggest subtitle file taken in, uploaded or fetched. Two hours of cues are well under 1 MB. */
export const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;
const SUBTITLE_EXTS = [".srt", ".vtt", ".txt"];

function render(lines: CaptionLine[], format: CaptionFormat, words: boolean) {
  const text = format === "srt" ? toSrt(lines) : toVtt(lines, { wordTimes: words });
  return { text, lines: lines.filter((l) => (l.text ?? (l.words ?? []).map((w) => w.text).join(" ")).trim()).length };
}

/** The project as `actor` may see it (the owner, an admin, or the operator CLI with null). */
async function projectOf(svc: Services, actor: Actor, projectId: string) {
  const p = await svc.database.db.query.projects.findFirst({
    where: and(eq(schema.projects.id, projectId), actor && !actor.admin ? eq(schema.projects.userId, actor.id) : undefined, isNull(schema.projects.deletedAt)),
    columns: { id: true, title: true },
  });
  if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No such project" });
  return p;
}

/** The captions of a clip's last render as a file: exactly the lines and times that were burned in (or would have been, with captions off). */
export async function clipCaptionsFile(
  svc: Services,
  actor: Actor,
  clipId: string,
  o: { format: CaptionFormat; words?: boolean | undefined },
): Promise<CaptionFile> {
  const clip = await svc.database.db.query.clips.findFirst({
    where: and(eq(schema.clips.id, clipId), isNull(schema.clips.deletedAt)),
    columns: { projectId: true, index: true, title: true, captions: true },
  });
  if (!clip) throw new TRPCError({ code: "NOT_FOUND", message: "No such clip" });
  await projectOf(svc, actor, clip.projectId);
  if (!clip.captions)
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "This clip has not been rendered since caption files were added. Re-render it, then export its captions.",
    });
  const out = render(clip.captions.lines, o.format, !!o.words);
  return { format: o.format, ...out, filename: `${String(clip.index + 1).padStart(2, "0")}-${slugify(clip.title)}.${o.format}` };
}

/** The project transcript as a file: one cue per transcript segment (VTT can carry the word times). */
export async function projectTranscriptFile(
  svc: Services,
  actor: Actor,
  projectId: string,
  o: { format: CaptionFormat; words?: boolean | undefined },
): Promise<CaptionFile> {
  const project = await projectOf(svc, actor, projectId);
  const t = await svc.database.db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId), columns: { segments: true, words: true } });
  if (!t) throw new TRPCError({ code: "NOT_FOUND", message: "This project has no transcript yet. Export it once the project has been transcribed." });
  const out = render(linesFromTranscript(t.segments, t.words), o.format, !!o.words);
  return { format: o.format, ...out, filename: `${slugify(project.title, 80)}-transcript.${o.format}` };
}

// ---------- import ----------

/** The text of an uploaded subtitle file. The upload must be the caller's. */
async function uploadText(svc: Services, actor: Actor, uploadId: string): Promise<string> {
  const row = await svc.database.db.query.uploads.findFirst({
    where: and(eq(schema.uploads.id, uploadId), actor ? eq(schema.uploads.userId, actor.id) : undefined),
  });
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Upload not found" });
  if (!SUBTITLE_EXTS.includes(path.extname(row.filename).toLowerCase())) throw new TRPCError({ code: "BAD_REQUEST", message: "Upload an .srt or .vtt file." });
  if (row.sizeBytes > MAX_SUBTITLE_BYTES)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `That file is ${Math.ceil(row.sizeBytes / 1024 / 1024)} MB; subtitle files are read up to ${MAX_SUBTITLE_BYTES / 1024 / 1024} MB.`,
    });
  const loc = await svc.storage.resolve(row.storageKey);
  if ("file" in loc) return fs.readFile(loc.file, "utf8");
  const tmp = path.join(svc.paths.tmp, `subtitle-${randomUUID()}`);
  try {
    await svc.storage.ensureLocal(row.storageKey, tmp);
    return await fs.readFile(tmp, "utf8");
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

/** A subtitle file from a public link (MCP `import_transcript { url }`): http(s) only, never an address inside this network, 3 redirects, 10 MB, 30 s. */
export async function fetchSubtitleText(
  url: string,
  deps: { fetch?: typeof fetch; lookup?: (host: string) => Promise<Array<{ address: string }>> } = {},
): Promise<string> {
  const signal = AbortSignal.timeout(30_000);
  try {
    // resolved once, checked, and connected to at that address, hop by hop (lib/safe-url.ts)
    const { res } = await fetchPublic(url, { lookup: deps.lookup, maxRedirects: 3, signal, fetch: deps.fetch ? (u, init) => deps.fetch!(u, init) : undefined });
    if (!res.ok || !res.body) throw new TRPCError({ code: "BAD_REQUEST", message: `Download failed (HTTP ${res.status})` });
    const chunks: Buffer[] = [];
    let seen = 0;
    for await (const chunk of bodyChunks(res)) {
      seen += chunk.length;
      if (seen > MAX_SUBTITLE_BYTES) throw new TRPCError({ code: "BAD_REQUEST", message: `The file is larger than ${MAX_SUBTITLE_BYTES / 1024 / 1024} MB` });
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (err) {
    if (err instanceof UnsafeUrlError || err instanceof TooManyRedirectsError) throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    throw err;
  }
}

export interface ImportTranscriptInput {
  text?: string | undefined;
  uploadId?: string | undefined;
  format?: "auto" | CaptionFormat;
  language?: string | undefined;
}

export interface ImportTranscriptResult {
  ok: true;
  format: CaptionFormat;
  cues: number;
  words: number;
  language: string | null;
  warnings: string[];
  /** what happens next, in the words the UI uses */
  message: string;
}

/**
 * Use an SRT / VTT file as the project's transcript. The project must be idle (done or failed), or just
 * created and not yet transcribing: then the transcribe stage finds the transcript and moves on to refine,
 * and the video is only downloaded. Otherwise the run restarts at refine, which goes on to pick moments.
 * The transcript, its event and the run start commit together. The words are spread over each cue
 * (see `cuesToTranscript`); refine and the render's forced alignment work from those.
 */
export async function importTranscript(svc: Services, actor: Actor, projectId: string, input: ImportTranscriptInput): Promise<ImportTranscriptResult> {
  if (!!input.text === !!input.uploadId) throw new TRPCError({ code: "BAD_REQUEST", message: "Give exactly one of text or uploadId" });
  await projectOf(svc, actor, projectId);
  const raw = input.text ?? (await uploadText(svc, actor, input.uploadId!));
  if (Buffer.byteLength(raw) > MAX_SUBTITLE_BYTES)
    throw new TRPCError({ code: "BAD_REQUEST", message: `Subtitle files are read up to ${MAX_SUBTITLE_BYTES / 1024 / 1024} MB.` });
  let parsed: ReturnType<typeof parseCaptions>;
  try {
    parsed = parseCaptions(raw, input.format ?? "auto");
  } catch (err) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err instanceof Error ? err.message : "Could not read that subtitle file" });
  }
  const language = input.language?.trim().toLowerCase() || undefined;
  const { words, segments } = cuesToTranscript(parsed.cues, { language });
  if (!words.length) throw new TRPCError({ code: "BAD_REQUEST", message: parsed.warnings[0] ?? "That file has no text to use as a transcript." });
  const log = svc.log.child({ module: "transcript", projectId });

  const restarted = await svc.tx(async (u) => {
    const [p] = await u.db
      .select({ status: schema.projects.status })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "No such project" });
    const idle = p.status === "done" || p.status === "failed";
    const fresh = p.status === "queued" || p.status === "ingesting";
    if (!idle && !fresh)
      throw new TRPCError({
        code: "CONFLICT",
        message: `The project is ${p.status} right now. Import a transcript when it is done or failed, or right after you create it.`,
      });
    // transcript first, then the project row (lock order)
    const [prev] = await u.db
      .select({ language: schema.transcripts.language })
      .from(schema.transcripts)
      .where(eq(schema.transcripts.projectId, projectId))
      .for("update");
    const values = {
      language: language ?? prev?.language ?? null,
      text: segments.map((s) => s.text).join(" "),
      words,
      rawWords: words,
      flags: [],
      deletedFlags: [],
      entities: [],
      refine: {},
      segments,
      textProfile: null,
    };
    // sceneCuts and the on-screen text overlays describe the video, not the words: an upsert leaves them as they are
    await u.db
      .insert(schema.transcripts)
      .values({ projectId, ...values, sceneCuts: null })
      .onConflictDoUpdate({ target: schema.transcripts.projectId, set: values });
    if (idle && (await startRun(u, projectId, { reason: "refine", status: "refining", stage: "refine" })) === null)
      throw new TRPCError({ code: "CONFLICT", message: "The project started working again. Try once more when it is done." });
    await u.emit(projectId, "transcript.imported", {
      ...(input.uploadId ? { uploadId: input.uploadId } : {}),
      format: parsed.format,
      cues: parsed.cues.length,
      words: words.length,
      ...(values.language ? { language: values.language } : {}),
      warnings: parsed.warnings.length,
    });
    if (idle) await enqueueRefine(svc, projectId, await stageSeqOf(u.db, projectId), undefined, u);
    await releaseUpload(svc, u, projectId, input.uploadId); // the subtitle file is not needed once its text is the transcript
    u.afterCommit(() =>
      log.info(
        {
          format: parsed.format,
          cues: parsed.cues.length,
          words: words.length,
          warnings: parsed.warnings,
          restarted: idle,
          previousLanguage: prev?.language ?? null,
        },
        "transcript imported",
      ),
    );
    return idle;
  });

  return {
    ok: true,
    format: parsed.format,
    cues: parsed.cues.length,
    words: words.length,
    language: language ?? null,
    warnings: parsed.warnings,
    message: restarted
      ? "Transcript imported. The project is cleaning it up and picking clips again."
      : "Transcript imported. The video is still being fetched; transcription is skipped.",
  };
}
