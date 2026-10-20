/**
 * `reelsaw import-report <zip>`: rehydrate an issue report into this (dev) instance.
 *
 * Reports come from trusted testers, but their content is not trusted: transcripts of arbitrary
 * videos, titles, model output and logs can carry text aimed at whoever reads them. So:
 *  - nothing from the zip is executed: every file is validated (allow-listed names, size caps,
 *    sha256 against the manifest, zod shapes) and inserted through the ORM;
 *  - the source video is downloaded only from http(s) links on known video hosts (or with
 *    --allow-any-url), and the link is passed to yt-dlp after `--`;
 *  - imported projects never start background work on their own (non-terminal states become
 *    "failed", clips without their render become "failed" with a note);
 *  - instruction-like text is reported as warnings, naming the field; content is never rewritten.
 * Released images refuse to import unless --allow-on-release (imports belong in dev checkouts).
 */
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { REPORT_FORMAT, projectSettingsSchema, styleOverrideSchema } from "@reelsaw/shared";
import { schema } from "../db/index.js";
import { keys } from "../storage/index.js";
import type { Services } from "../services.js";

const NAME = /^(README\.md|report\.md|manifest\.json|config\.json|client\.json|project\.json|transcript\.json|clips\.json|artifacts\.json|events\.jsonl|logs\.jsonl|system\.json|queue\.json|usage\.json|errors\.jsonl|stuck\.json|projects\.json|media\/thumbnails\/[\w.-]{1,120}\.jpg|media\/clips\/[\w.-]{1,120}\.mp4|media\/source\.[a-z0-9]{1,5})$/; // source: any upload extension, only ever handed to storage + ffmpeg
const MAX_DATA_FILE = 512 * 1024 * 1024; // uncompressed, per non-media file
const MAX_TOTAL = 64 * 1024 * 1024 * 1024;
const MAX_RATIO = 400; // uncompressed / compressed, for non-media files over 16 MB (zip-bomb guard)
export const VIDEO_HOSTS = ["youtube.com", "youtu.be", "vimeo.com", "x.com", "twitter.com", "tiktok.com", "instagram.com", "twitch.tv", "facebook.com", "fb.watch", "rumble.com", "dailymotion.com", "loom.com"];

export class ImportError extends Error {}

const manifestSchema = z.object({
  format: z.number().int().positive(),
  app: z.object({ version: z.string(), commit: z.string(), builtAt: z.string() }),
  createdAt: z.string(),
  kind: z.enum(["project", "account"]),
  projectId: z.string().nullable(),
  clipIds: z.array(z.string()).default([]),
  files: z.array(z.object({ path: z.string(), bytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
  notes: z.array(z.string()).default([]),
});
const word = z.object({ text: z.string(), start: z.number(), end: z.number() }).passthrough();
const projectSchema = z
  .object({
    id: z.string().uuid(), // ids are remapped by string replacement: they must be distinctive
    title: z.string().max(500),
    sourceType: z.enum(["url", "upload"]),
    sourceUrl: z.string().max(4000).nullable(),
    sourceMeta: z.record(z.string(), z.unknown()).nullable(),
    durationSec: z.number().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    status: z.string(),
    stage: z.string().nullable(),
    error: z.string().nullable(),
    // must be settings the app would accept (re-renders run with them); stored as they came
    settings: z.record(z.string(), z.unknown()).refine((v) => projectSettingsSchema.safeParse(v).success, "settings are not valid project settings"),
  })
  .passthrough();
const transcriptSchema = z
  .object({
    language: z.string().nullable(),
    text: z.string(),
    words: z.array(word),
    rawWords: z.array(word).nullable(),
    flags: z.array(z.record(z.string(), z.unknown())),
    deletedFlags: z.array(z.record(z.string(), z.unknown())).default([]),
    entities: z.array(z.string()).default([]),
    refine: z.record(z.string(), z.unknown()).default({}),
    segments: z.array(z.record(z.string(), z.unknown())),
    sceneCuts: z.array(z.number()).nullable().default(null),
    overlays: z.array(z.record(z.string(), z.unknown())).nullable().default(null),
    textProfile: z.record(z.string(), z.unknown()).nullable().default(null),
    chunks: z.array(z.object({ index: z.number().int(), offsetSec: z.number(), language: z.string().nullable(), text: z.string(), segments: z.array(z.record(z.string(), z.unknown())) }).passthrough()).default([]),
  })
  .passthrough();
const clipSchema = z
  .object({
    id: z.string().uuid(),
    index: z.number().int(),
    title: z.string(),
    hook: z.string(),
    startSec: z.number(),
    endSec: z.number(),
    score: z.number(),
    reasoning: z.string(),
    caption: z.string().default(""),
    hashtags: z.array(z.string()),
    status: z.string(),
    error: z.string().nullable().default(null),
    style: z.unknown().refine((v) => v == null || styleOverrideSchema.safeParse(v).success, "clip style is not a valid style override").optional(),
  })
  .passthrough();
const eventSchema = z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()), createdAt: z.string() }).passthrough();
const artifactSchema = z.object({ stage: z.string(), kind: z.string(), models: z.record(z.string(), z.string()).default({}), data: z.unknown(), createdAt: z.string() }).passthrough();

/** Instruction-like text in report content: warn, never rewrite. */
const INJECTION: Array<[RegExp, string]> = [
  [/\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all)\b[^.\n]{0,20}\b(instructions?|prompts?|rules?)\b/i, "asks to ignore instructions"],
  [/\b(you are now|act as|pretend to be)\b[^.\n]{0,40}\b(assistant|agent|ai|model|developer|admin)\b/i, "tries to change the reader's role"],
  [/\bsystem prompt\b/i, "mentions a system prompt"],
  [/\b(run|execute)\b[^.\n]{0,30}\b(this|the following|these)\b[^.\n]{0,15}\b(commands?|scripts?|code)\b/i, "asks to run commands"],
  [/\b(curl|wget)\b[^\n]{0,200}\|\s*(ba|z)?sh\b/i, "pipes a download into a shell"],
  [/\brm\s+-rf\b|\bchmod\s+\+x\b|\bsudo\b/i, "contains a shell command"],
  [/```|~~~/, "contains a fenced code block"],
];

export interface ImportOptions {
  /** local user to own the project (default: the oldest account) */
  userEmail?: string;
  /** use this file as the source video instead of downloading it */
  sourceFile?: string;
  allowAnyUrl?: boolean;
  noDownload?: boolean;
  allowOnRelease?: boolean;
}

export interface ImportSummary {
  projectId: string | null;
  url: string | null;
  title: string | null;
  original: { projectId: string | null; clipIds: string[]; app: string; createdAt: string };
  status: string | null;
  error: string | null;
  failedStage: string | null;
  clips: Record<string, number>;
  flags: Record<string, number>;
  models: Record<string, unknown>;
  media: string[];
  notes: string[];
  warnings: string[];
  description: string;
  next: string[];
}

const sha = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });

/** Open, check and extract the zip into `dir`; returns the verified manifest. */
async function extract(zipPath: string, dir: string): Promise<z.infer<typeof manifestSchema>> {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) => yauzl.open(zipPath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (e, z) => (e ? rej(new ImportError(`not a readable zip: ${e.message}`)) : res(z!))));
  let total = 0;
  const seen = new Set<string>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", (e: Error) => reject(new ImportError(`zip error: ${e.message}`)));
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (name.endsWith("/")) return zip.readEntry(); // directory entries
        if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\\")) return reject(new ImportError(`unsafe path in zip: ${JSON.stringify(name)}`));
        if (!NAME.test(name)) return reject(new ImportError(`unexpected file in zip: ${JSON.stringify(name)}`));
        if (seen.has(name)) return reject(new ImportError(`duplicate entry: ${name}`));
        seen.add(name);
        const media = name.startsWith("media/");
        total += entry.uncompressedSize;
        if (total > MAX_TOTAL) return reject(new ImportError("zip is larger than the import limit"));
        if (!media && entry.uncompressedSize > MAX_DATA_FILE) return reject(new ImportError(`${name} is too large (${entry.uncompressedSize} bytes)`));
        if (!media && entry.uncompressedSize > 16 * 1024 * 1024 && entry.uncompressedSize / Math.max(1, entry.compressedSize) > MAX_RATIO) return reject(new ImportError(`${name} has a suspicious compression ratio`));
        zip.openReadStream(entry, (err, stream) => {
          if (err) return reject(new ImportError(`cannot read ${name}: ${err.message}`));
          const dest = path.join(dir, name);
          if (!dest.startsWith(dir + path.sep)) return reject(new ImportError(`unsafe path in zip: ${name}`));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          pipeline(stream!, fs.createWriteStream(dest, { flags: "wx" })).then(() => zip.readEntry(), (e) => reject(new ImportError(`cannot extract ${name}: ${(e as Error).message}`)));
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  if (!seen.has("manifest.json")) throw new ImportError("manifest.json is missing: not a Reelsaw report");
  const raw = JSON.parse(await fsp.readFile(path.join(dir, "manifest.json"), "utf8")) as { format?: unknown };
  if (typeof raw.format === "number" && raw.format > REPORT_FORMAT) throw new ImportError(`report format ${raw.format} is newer than this app understands (${REPORT_FORMAT}); update Reelsaw`);
  const manifest = manifestSchema.parse(raw);
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  for (const name of seen) {
    if (name === "manifest.json") continue;
    const f = listed.get(name);
    if (!f) throw new ImportError(`${name} is not listed in the manifest`);
    if ((await sha(path.join(dir, name))) !== f.sha256) throw new ImportError(`${name} does not match its checksum in the manifest`);
  }
  for (const f of manifest.files) if (!seen.has(f.path)) throw new ImportError(`manifest lists ${f.path} but the zip doesn't contain it`);
  return manifest;
}

export function scanForInjection(fields: Array<[string, string | null | undefined]>): string[] {
  const out: string[] = [];
  for (const [field, text] of fields) {
    if (!text) continue;
    for (const [re, why] of INJECTION) {
      const m = re.exec(text);
      if (!m) continue;
      const at = Math.max(0, m.index - 30);
      out.push(`${field}: ${why}: “${text.slice(at, m.index + m[0].length + 30).replace(/\s+/g, " ").trim()}”`);
    }
  }
  return out;
}

export function allowedSourceUrl(url: string | null, allowAny: boolean): { ok: true; url: string } | { ok: false; why: string } {
  if (!url) return { ok: false, why: "no source link" };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, why: "source link is not a URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, why: `refusing to download a ${u.protocol} link` };
  const host = u.hostname.replace(/^www\.|^m\./, "");
  if (!allowAny && !VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return { ok: false, why: `${u.hostname} is not a known video host (use --allow-any-url)` };
  return { ok: true, url: u.toString() };
}

async function readJson<T>(dir: string, name: string, parse: (v: unknown) => T): Promise<T | null> {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return null;
  try {
    return parse(JSON.parse(await fsp.readFile(file, "utf8")));
  } catch (err) {
    throw new ImportError(`${name} is not valid: ${(err as Error).message.slice(0, 300)}`);
  }
}
async function readJsonl<T>(dir: string, name: string, parse: (v: unknown) => T): Promise<T[]> {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const [i, line] of (await fsp.readFile(file, "utf8")).split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      out.push(parse(JSON.parse(line)));
    } catch (err) {
      throw new ImportError(`${name} line ${i + 1} is not valid: ${(err as Error).message.slice(0, 200)}`);
    }
  }
  return out;
}

const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

export async function importReport(svc: Services, zipPath: string, opts: ImportOptions = {}): Promise<ImportSummary> {
  if (svc.config.REELSAW_VERSION !== "dev" && !opts.allowOnRelease)
    throw new ImportError(`this is a released Reelsaw (${svc.config.REELSAW_VERSION}); import reports in a dev checkout, or pass --allow-on-release`);
  const db = svc.database.db;
  const dir = path.join(svc.paths.tmp, `import-${randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const manifest = await extract(path.resolve(zipPath), dir);
    const description = (await fsp.readFile(path.join(dir, "report.md"), "utf8").catch(() => "")).split(/^~{8}$/m)[1]?.trim() ?? "";
    const config = (await readJson(dir, "config.json", (v) => z.record(z.string(), z.unknown()).parse(v))) ?? {};
    const summary: ImportSummary = {
      projectId: null,
      url: null,
      title: null,
      original: { projectId: manifest.projectId, clipIds: manifest.clipIds, app: `${manifest.app.version} (${manifest.app.commit})`, createdAt: manifest.createdAt },
      status: null,
      error: null,
      failedStage: null,
      clips: {},
      flags: {},
      models: { AI_MODEL: svc.models.get().language, TRANSCRIPTION_MODEL: svc.models.get().transcription, TRANSCRIPT_ALIGN_MODEL: svc.models.get().align, env: { AI_MODEL: config.AI_MODEL, TRANSCRIPTION_MODEL: config.TRANSCRIPTION_MODEL, TRANSCRIPT_ALIGN_MODEL: config.TRANSCRIPT_ALIGN_MODEL } },
      media: [],
      notes: manifest.notes,
      warnings: [],
      description,
      next: [],
    };
    if (manifest.kind === "account") {
      summary.warnings = scanForInjection([["report.md (user description)", description]]);
      summary.next = ["Account-level report: read projects.json, events.jsonl and errors.jsonl; nothing to import."];
      return summary;
    }

    const project = await readJson(dir, "project.json", (v) => projectSchema.parse(v));
    if (!project) throw new ImportError("project.json is missing");
    const transcript = await readJson(dir, "transcript.json", (v) => (v === null ? null : transcriptSchema.parse(v)));
    const clips = (await readJson(dir, "clips.json", (v) => z.array(clipSchema).parse(v))) ?? [];
    const events = await readJsonl(dir, "events.jsonl", (v) => eventSchema.parse(v));
    const artifacts = (await readJson(dir, "artifacts.json", (v) => z.array(artifactSchema).parse(v))) ?? [];

    summary.warnings = scanForInjection([
      ["report.md (user description)", description],
      ["project title", project.title],
      ["source description", typeof project.sourceMeta?.description === "string" ? project.sourceMeta.description : null],
      ["transcript", transcript?.text ?? null],
      ...clips.flatMap((c): Array<[string, string]> => [[`clip ${c.index + 1} title`, c.title], [`clip ${c.index + 1} hook`, c.hook], [`clip ${c.index + 1} reasoning`, c.reasoning], [`clip ${c.index + 1} caption`, c.caption]]),
    ]);

    // owner
    const owner = opts.userEmail
      ? await db.query.user.findFirst({ where: eq(schema.user.email, opts.userEmail) })
      : await db.query.user.findFirst({ orderBy: asc(schema.user.createdAt) });
    if (!owner) throw new ImportError(opts.userEmail ? `no local user ${opts.userEmail}` : "no local users: sign up in the app first");

    // fresh ids; references to old ids inside event payloads and artifacts follow them
    const projectId = randomUUID();
    const clipIds = new Map(clips.map((c) => [c.id, randomUUID()]));
    const remap = <T>(v: T): T => {
      let s = JSON.stringify(v);
      s = s.split(project.id).join(projectId);
      for (const [a, b] of clipIds) s = s.split(a).join(b);
      return JSON.parse(s) as T;
    };
    const mediaDir = path.join(dir, "media");
    const clipFile = (c: { id: string; index: number }, ext: "mp4" | "jpg") => {
      const sub = ext === "mp4" ? "clips" : "thumbnails";
      const f = path.join(mediaDir, sub, `${String(c.index + 1).padStart(2, "0")}-${c.id}.${ext}`);
      return fs.existsSync(f) ? f : null;
    };

    // media first (files under the new ids), rows after: a failed insert leaves only orphan files
    const sourceInZip = fs.existsSync(mediaDir) ? (await fsp.readdir(mediaDir)).find((f) => f.startsWith("source.")) : undefined;
    let sourceKey: string | null = null;
    let sourcePath: string | null = sourceInZip ? path.join(mediaDir, sourceInZip) : opts.sourceFile ? path.resolve(opts.sourceFile) : null;
    if (!sourcePath && !opts.noDownload && project.sourceType === "url") {
      const allowed = allowedSourceUrl(project.sourceUrl, !!opts.allowAnyUrl);
      if (!allowed.ok) summary.notes.push(`Source not downloaded: ${allowed.why}.`);
      else {
        const out = path.join(dir, "download");
        await fsp.mkdir(out);
        await svc.media.ytdlp(["--no-playlist", "--no-warnings", "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b", "--merge-output-format", "mp4", "-o", path.join(out, "source.%(ext)s"), "--", allowed.url], {});
        const f = (await fsp.readdir(out)).find((x) => x.startsWith("source."));
        if (f) sourcePath = path.join(out, f);
        else summary.notes.push("Source download produced no file.");
      }
    }
    if (sourcePath) {
      sourceKey = keys.source(projectId, path.extname(sourcePath) || ".mp4");
      await svc.storage.putFile(sourceKey, sourcePath);
      summary.media.push(`source video (${sourceInZip ? "from the report" : opts.sourceFile ? "--source" : "downloaded"})`);
    } else if (!summary.notes.some((n) => n.startsWith("Source not downloaded"))) summary.notes.push("No source video: re-renders need one (--source <file>).");

    const clipRows: Array<Record<string, unknown>> = [];
    for (const c of clips) {
      const id = clipIds.get(c.id)!;
      const mp4 = clipFile(c, "mp4");
      const jpg = clipFile(c, "jpg");
      const outputKey = mp4 ? keys.clip(projectId, id) : null;
      const thumbnailKey = jpg ? keys.thumb(projectId, id) : null;
      if (mp4) await svc.storage.putFile(outputKey!, mp4);
      if (jpg) await svc.storage.putFile(thumbnailKey!, jpg);
      const rendered = !!mp4 && c.status === "done";
      const { id: _old, projectId: _p, createdAt: _c, updatedAt: _u, renderGen: _g, outputKey: _o, thumbnailKey: _t, ...rest } = c as Record<string, unknown> & typeof c;
      clipRows.push({
        ...(remap(rest) as typeof rest),
        id,
        projectId,
        renderGen: 0,
        outputKey,
        thumbnailKey,
        // never leave work queued: only clips whose render came along stay "done"
        status: (rendered ? "done" : "failed") as "done" | "failed",
        error: rendered ? null : c.status === "failed" ? c.error : "Render not included in the report: re-render to reproduce",
      });
    }
    summary.media.push(`${clipRows.filter((c) => c.outputKey).length}/${clips.length} clip renders, ${clipRows.filter((c) => c.thumbnailKey).length} thumbnails`);

    const terminal = project.status === "done" || project.status === "failed";
    const day = manifest.createdAt.slice(0, 10);
    await svc.tx(async (u) => {
      const { id: _id, ownerHash: _o, createdAt: _c, updatedAt: _u, sourceKey: _k, stageProgress: _sp, ...p } = project as Record<string, unknown> & typeof project;
      await u.db.insert(schema.projects).values({
        ...(p as typeof project),
        id: projectId,
        userId: owner.id,
        title: `${project.title} (report ${day})`.slice(0, 500),
        sourceKey,
        sourceMeta: { ...(project.sourceMeta ?? {}), report: { projectId: project.id, reportedClipIds: manifest.clipIds, clipIds: Object.fromEntries(clipIds), app: manifest.app, createdAt: manifest.createdAt } },
        status: (terminal ? project.status : "failed") as "done" | "failed",
        error: terminal ? project.error : `Imported mid-run (was ${project.status})`,
        settings: project.settings as never,
      } as never);
      if (transcript) {
        const { chunks, projectId: _tp, createdAt: _tc, ...t } = transcript as Record<string, unknown> & typeof transcript;
        await u.db.insert(schema.transcripts).values({ ...(remap(t) as Record<string, unknown>), projectId } as never);
        if (chunks.length) await u.db.insert(schema.transcriptChunks).values(chunks.map((c) => ({ id: randomUUID(), projectId, index: c.index, offsetSec: c.offsetSec, language: c.language, text: c.text, segments: c.segments as never })));
      }
      if (clipRows.length) await u.db.insert(schema.clips).values(clipRows as never);
      if (events.length) await u.db.insert(schema.projectEvents).values(events.map((e) => ({ projectId, type: e.type as never, payload: remap(e.payload), createdAt: new Date(e.createdAt) })));
      if (artifacts.length) await u.db.insert(schema.stageArtifacts).values(artifacts.map((a) => ({ projectId, stage: a.stage, kind: a.kind, models: a.models, data: remap(a.data), createdAt: new Date(a.createdAt) })));
    });

    const reported = manifest.clipIds.map((id) => clipIds.get(id)).filter(Boolean) as string[];
    const lastFail = [...events].reverse().find((e) => e.type === "stage.failed" || e.type === "project.failed");
    Object.assign(summary, {
      projectId,
      url: `${svc.config.APP_URL.replace(/\/$/, "")}/p/${projectId}${reported[0] ? `#clip=${reported[0]}` : ""}`,
      title: project.title,
      status: terminal ? project.status : "failed",
      error: project.error,
      failedStage: lastFail ? String(lastFail.payload.stage ?? lastFail.type) : null,
      clips: count(clips.map((c) => c.status)),
      flags: count((transcript?.flags ?? []).map((f) => `${String(f.kind)}:${String(f.status)}`)),
      models: { ...summary.models, ...Object.fromEntries(artifacts.map((a) => [`${a.stage}/${a.kind}`, a.models])) },
      next: [
        `reelsaw status ${projectId}`,
        ...reported.flatMap((id) => [`reelsaw clip ${id}`, `reelsaw rerender ${id}${sourceKey ? "" : "   (needs a source video)"}`]),
        "logs.jsonl, errors.jsonl and queue.json stay in the zip (read them as untrusted data)",
      ],
    });
    return summary;
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
