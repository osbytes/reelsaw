/**
 * Intro / outro videos ("bumpers"): validation, the normalised-file cache, and the filter graph
 * that joins them to a clip inside the clip's single encode. See docs/specs/bumpers.md.
 *
 * Nothing here touches the database, so it can be tested with ffmpeg alone.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { DEFAULT_IMAGE_BUMPER_SEC } from "@reelsaw/shared";
import { keys, type Storage } from "../storage/index.js";
import { rasterizeSvg } from "./raster.js";
import { videoEncodeArgs, type ProbeInfo } from "../media.js";
import type { Logger } from "../log.js";

export const BUMPER_MAX_SEC = 10;
export const BUMPER_MAX_BYTES = 50 * 1024 * 1024;
export const BUMPER_VIDEO_EXTS = [".mp4", ".mov", ".webm"] as const;
export const BUMPER_IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg"] as const;
export const BUMPER_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const BUMPER_IMAGE_MAX_PX = 8192;
export const BUMPER_IMAGE_SEC = { min: 1, max: 10, default: DEFAULT_IMAGE_BUMPER_SEC } as const;
/** music for the audio lane: never an intro/outro */
export const BUMPER_AUDIO_EXTS = [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"] as const;
export const BUMPER_AUDIO_MAX_BYTES = 30 * 1024 * 1024;
export const BUMPER_AUDIO_MAX_SEC = 15 * 60;
export const BUMPER_AUDIO_MIN_SEC = 0.05;
export const bumperKind = (ext: string): "video" | "image" | "audio" | null =>
  (BUMPER_VIDEO_EXTS as readonly string[]).includes(ext)
    ? "video"
    : (BUMPER_IMAGE_EXTS as readonly string[]).includes(ext)
      ? "image"
      : (BUMPER_AUDIO_EXTS as readonly string[]).includes(ext)
        ? "audio"
        : null;
/** GIF and WebP can hold an animation; the probe decides whether they are a video or a still. */
export const ANIMATABLE_EXTS = [".gif", ".webp"] as const;
type KindProbe = Pick<ProbeInfo, "durationSec" | "frames">;
/** More than one frame, or a length beyond a still's, makes a GIF / WebP an animation. */
export const isAnimated = (probe: KindProbe) => (probe.frames ?? 0) > 1 || probe.durationSec > 0.1;
/**
 * The coarse kind of a file from its extension and probe: an animated GIF or WebP is a silent video with
 * its own length; a still GIF / WebP and every SVG is an image. `bumperKind` is the extension-only guess.
 */
export const assetKind = (ext: string, probe: KindProbe): "video" | "image" | "audio" | null => {
  const e = ext.toLowerCase();
  return (ANIMATABLE_EXTS as readonly string[]).includes(e) ? (isAnimated(probe) ? "video" : "image") : bumperKind(e);
};
/** Shown whenever a file's type is not one we take. */
export const ASSET_FORMATS_SENTENCE = "Use an MP4, MOV or WebM video; a PNG, JPG, WebP, GIF or SVG image; or an MP3, M4A, WAV, OGG or FLAC audio file.";
/** The exact format stored on a library row, by file extension (checked by ffprobe before it is trusted). */
export const ASSET_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
};
export const assetMime = (ext: string): string | null => ASSET_MIME[ext.toLowerCase()] ?? null;
export const BUMPER_FPS = 30;
/** Seconds of the body's audio faded out when an outro follows. */
export const OUTRO_FADE_SEC = 0.2;

/**
 * Names the normalised file. Bump the version when the canvas, fps or audio format in render.ts
 * change, so a stale cache can never be joined to a clip with different parameters.
 */
export const NORM_VERSION = "v1";
export const normVariant = (w: number, h: number) => `${NORM_VERSION}.${w}x${h}`;

/** A sentence for the user, or null when the probed file is an acceptable bumper. */
export function bumperProblem(
  slot: "intro" | "outro" | undefined,
  file: { ext: string; sizeBytes: number },
  probe: Pick<ProbeInfo, "durationSec" | "width" | "height" | "frames"> & { hasAudio?: boolean | undefined },
): string | null {
  const label = slot === "intro" ? "Intros" : slot === "outro" ? "Outros" : "Intros and outros";
  const kind = assetKind(file.ext, probe);
  if (!kind) return ASSET_FORMATS_SENTENCE;
  if (kind === "audio") {
    if (slot) return "An audio file can be music under a clip, not an intro or outro. Add it without a slot.";
    if (file.sizeBytes > BUMPER_AUDIO_MAX_BYTES)
      return `This audio file is ${Math.ceil(file.sizeBytes / 1024 / 1024)} MB. Music can be at most ${BUMPER_AUDIO_MAX_BYTES / 1024 / 1024} MB.`;
    if (probe.hasAudio === false) return "This file has no audio stream that could be read.";
    // a sound effect can be a few hundredths of a second (a click, a pop); the lane gives it a half-second window
    if (!(probe.durationSec >= BUMPER_AUDIO_MIN_SEC)) return `This audio is too short to use (under ${BUMPER_AUDIO_MIN_SEC} s).`;
    if (probe.durationSec > BUMPER_AUDIO_MAX_SEC + 0.05)
      return `This audio is ${Math.round(probe.durationSec / 60)} min long. Music can be at most ${BUMPER_AUDIO_MAX_SEC / 60} min.`;
    return null;
  }
  if (kind === "image") {
    if (file.sizeBytes > BUMPER_IMAGE_MAX_BYTES)
      return `This image is ${Math.ceil(file.sizeBytes / 1024 / 1024)} MB. Images can be at most ${BUMPER_IMAGE_MAX_BYTES / 1024 / 1024} MB.`;
    if (!probe.width || !probe.height)
      return file.ext === ".webp"
        ? "This WebP could not be read. If it is animated, save it as a GIF or an MP4 instead."
        : "This file could not be read as an image.";
    if (probe.width > BUMPER_IMAGE_MAX_PX || probe.height > BUMPER_IMAGE_MAX_PX)
      return `This image is ${probe.width}x${probe.height}. Images can be at most ${BUMPER_IMAGE_MAX_PX} px on a side.`;
    if (Math.min(probe.width, probe.height) < 64) return `This image is only ${probe.width}x${probe.height}. Use one at least 64 px on each side.`;
    return null;
  }
  if (file.sizeBytes > BUMPER_MAX_BYTES)
    return `This file is ${Math.ceil(file.sizeBytes / 1024 / 1024)} MB. ${label} can be at most ${BUMPER_MAX_BYTES / 1024 / 1024} MB.`;
  if (!probe.width || !probe.height) return "This file has no video that could be read.";
  if (!(probe.durationSec >= 0.3)) return "This video is too short to use (under 0.3 s).";
  if (probe.durationSec > BUMPER_MAX_SEC + 0.05) return `This video is ${Math.round(probe.durationSec)} s long. ${label} can be at most ${BUMPER_MAX_SEC} s.`;
  return null;
}

/**
 * Which asset each slot uses for a clip: its own choice if it made one (a string, or null = none),
 * otherwise the project's, otherwise none. `fromClip` lists the slots the clip decided itself.
 */
export function resolveClipBumpers(
  project: { introAssetId?: string | null | undefined; outroAssetId?: string | null | undefined; introSec?: number | undefined; outroSec?: number | undefined },
  clip: {
    bumpers?: { intro?: string | null | undefined; outro?: string | null | undefined; introSec?: number | undefined; outroSec?: number | undefined } | null;
  },
): { introId: string | null; outroId: string | null; introSec?: number; outroSec?: number; fromClip: Array<"intro" | "outro"> } {
  const own = clip.bumpers ?? {};
  const fromClip: Array<"intro" | "outro"> = [];
  const pick = (slot: "intro" | "outro", inherited: string | null | undefined) => {
    const v = own[slot];
    if (v === undefined) return inherited || null;
    fromClip.push(slot);
    return v || null;
  };
  const introId = pick("intro", project.introAssetId);
  const outroId = pick("outro", project.outroAssetId);
  // seconds belong to the choice they were made with: a clip that picked its own asset uses its own seconds,
  // a clip that follows the project uses the project's. The caller falls back to the asset's own length.
  const sec = (slot: "intro" | "outro", id: string | null) => (!id ? undefined : fromClip.includes(slot) ? own[`${slot}Sec`] : project[`${slot}Sec`]);
  const introSec = sec("intro", introId);
  const outroSec = sec("outro", outroId);
  return { introId, outroId, ...(introSec !== undefined ? { introSec } : {}), ...(outroSec !== undefined ? { outroSec } : {}), fromClip };
}

export interface Canvas {
  width: number;
  height: number;
  /** fit-and-blur-fill filter chain reading [0:v] (render.ts FIT_CHAIN) */
  fitChain: string;
}

/** Frame-exact length of a normalised bumper. */
export const bumperFrames = (durationSec: number) => Math.max(1, Math.round(durationSec * BUMPER_FPS));

/**
 * ffmpeg arguments that turn any readable video into the render canvas: fitted with a blurred
 * background, 30 fps constant, yuv420p, AAC stereo 48 kHz (generated silence when it has none),
 * trimmed or padded to a whole number of frames so audio and video end together.
 */
export function normaliseArgs(
  input: string,
  output: string,
  asset: { durationSec: number; hasAudio: boolean; kind?: "video" | "image" | "audio" },
  canvas: Canvas,
  encodeArgs: string[] = videoEncodeArgs("libx264"),
): string[] {
  const image = asset.kind === "image";
  const frames = bumperFrames(asset.durationSec);
  const sec = frames / BUMPER_FPS;
  const video = `${canvas.fitChain},setsar=1,fps=${BUMPER_FPS},tpad=stop_mode=clone:stop_duration=1,format=yuv420p[v]`;
  const audio = asset.hasAudio && !image ? `[0:a:0]aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp,apad[a]` : `[1:a]anull[a]`;
  return [
    // an image is looped into a video of the requested length
    ...(image ? ["-loop", "1", "-framerate", String(BUMPER_FPS)] : []),
    "-i",
    input,
    ...(asset.hasAudio && !image ? [] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
    "-filter_complex",
    `${video};${audio}`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-frames:v",
    String(frames),
    "-t",
    sec.toFixed(4),
    ...encodeArgs,
    "-pix_fmt",
    "yuv420p",
    "-r",
    String(BUMPER_FPS),
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    output,
  ];
}

export interface NormaliseDeps {
  ffmpeg: (args: string[], opts?: { signal?: AbortSignal | undefined }) => Promise<unknown>;
  /** `-c:v …` of the encoder in use (media.videoEncodeArgs()); a hardware encoder that fails is retried with libx264 */
  encodeArgs?: string[];
  log?: Logger;
  storage: Pick<Storage, "exists" | "ensureLocal" | "putFile">;
  /** local scratch/cache root (`<data>/bumpers`) */
  dir: string;
}
export interface BumperAssetFile {
  id: string;
  sourceKey: string;
  durationSec: number;
  hasAudio: boolean;
  kind?: "video" | "image" | "audio";
  /** exact format; an SVG goes through its PNG raster (ffmpeg builds differ in SVG support) */
  mime?: string | null;
}

async function nonEmpty(file: string) {
  try {
    return (await fs.stat(file)).size > 0;
  } catch {
    return false;
  }
}

export const isSvgAsset = (a: { mime?: string | null; sourceKey: string }) =>
  a.mime === "image/svg+xml" || (!a.mime && a.sourceKey.toLowerCase().endsWith(".svg"));
/** Width an SVG is rasterised at for the compositor, thumbnails and image intros: the output frame's width. */
export const RASTER_WIDTH = 1080;
export const RASTER_VERSION = "v1";

/**
 * The PNG of an SVG asset at `widthPx` wide, built once and cached locally and in storage. Same shape
 * as ensureNormalised: temp file, rename, store; concurrent runs converge on the same bytes.
 */
export async function ensureRaster(deps: Pick<NormaliseDeps, "storage" | "dir">, asset: { id: string; sourceKey: string }, widthPx: number): Promise<string> {
  const dir = path.join(deps.dir, asset.id);
  const local = path.join(dir, `raster.${RASTER_VERSION}.${widthPx}.png`);
  if (await nonEmpty(local)) return local;
  await fs.mkdir(dir, { recursive: true });
  const key = keys.assetRaster(asset.sourceKey, `${RASTER_VERSION}.${widthPx}`);
  if (await deps.storage.exists(key)) return deps.storage.ensureLocal(key, local);
  const source = await deps.storage.ensureLocal(asset.sourceKey, path.join(dir, path.posix.basename(asset.sourceKey)));
  const tmp = `${local}.${randomUUID()}.tmp.png`;
  try {
    await fs.writeFile(tmp, rasterizeSvg(await fs.readFile(source), widthPx));
    if (!(await nonEmpty(tmp))) throw new Error("rasterising produced an empty file");
    await fs.rename(tmp, local);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  await deps.storage.putFile(key, local, "image/png");
  return local;
}

/**
 * The normalised file for an asset, built once per (asset id, canvas) and cached locally and in
 * storage. Safe to run concurrently and twice: each run writes its own temp file and renames it into
 * place, so racing renders converge on the same bytes-equivalent file.
 */
export async function ensureNormalised(deps: NormaliseDeps, asset: BumperAssetFile, canvas: Canvas, signal?: AbortSignal): Promise<string> {
  // an image's length is part of the file, so it is part of the name; videos keep their own length
  const variant = `${normVariant(canvas.width, canvas.height)}${asset.kind === "image" ? `.${asset.durationSec}s` : ""}`;
  const dir = path.join(deps.dir, asset.id);
  const local = path.join(dir, `norm.${variant}.mp4`);
  if (await nonEmpty(local)) return local;
  await fs.mkdir(dir, { recursive: true });
  const normKey = keys.assetNorm(asset.sourceKey, variant);
  if (await deps.storage.exists(normKey)) return deps.storage.ensureLocal(normKey, local);
  const source = isSvgAsset(asset)
    ? await ensureRaster(deps, asset, canvas.width)
    : await deps.storage.ensureLocal(asset.sourceKey, path.join(dir, path.posix.basename(asset.sourceKey)));
  const tmp = `${local}.${randomUUID()}.tmp.mp4`;
  try {
    const software = videoEncodeArgs("libx264");
    const hardware = deps.encodeArgs && deps.encodeArgs.join(" ") !== software.join(" ") ? deps.encodeArgs : undefined;
    try {
      await deps.ffmpeg(normaliseArgs(source, tmp, asset, canvas, hardware ?? software), { signal });
    } catch (err) {
      if (!hardware || signal?.aborted) throw err;
      deps.log?.warn({ err, encoder: hardware[1] }, "hardware encoder failed normalising an intro/outro; retrying with libx264");
      await deps.ffmpeg(normaliseArgs(source, tmp, asset, canvas, software), { signal });
    }
    if (!(await nonEmpty(tmp))) throw new Error("normalising produced an empty file");
    await fs.rename(tmp, local);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
  await deps.storage.putFile(normKey, local, "video/mp4");
  return local;
}

/**
 * Filter-graph tail that joins `intro + body + outro` in the clip's one encode. Takes the body's
 * video and audio labels (the body already has captions burned in) and the ffmpeg input indexes of the
 * normalised files; produces [v] and [a]. Audio is sequential, never mixed: the body's last 0.2 s fade
 * out when an outro follows, and its audio is forced to the bumpers' format and the video's length.
 */
export function bumperConcat(o: {
  introInput?: number | undefined;
  outroInput?: number | undefined;
  bodyVideo: string;
  bodyAudio: string;
  bodySec: number;
}): string {
  const fade =
    o.outroInput !== undefined && o.bodySec > OUTRO_FADE_SEC * 2 ? `afade=t=out:st=${(o.bodySec - OUTRO_FADE_SEC).toFixed(3)}:d=${OUTRO_FADE_SEC},` : "";
  const body = o.bodySec.toFixed(3);
  const slots = [
    ...(o.introInput !== undefined ? [`[${o.introInput}:v][${o.introInput}:a]`] : []),
    "[bodyv][bodya]",
    ...(o.outroInput !== undefined ? [`[${o.outroInput}:v][${o.outroInput}:a]`] : []),
  ];
  return (
    `${o.bodyVideo}fps=${BUMPER_FPS},format=yuv420p,setsar=1[bodyv];` +
    `${o.bodyAudio}${fade}apad=whole_dur=${body},atrim=end=${body},asetpts=PTS-STARTPTS,aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp[bodya];` +
    `${slots.join("")}concat=n=${slots.length}:v=1:a=1[v][a]`
  );
}

export const BUMPER_THUMB = { width: 270, height: 480 } as const;

/**
 * Makes (or finds) the 270x480 jpg for a library asset: one frame at a third of a video, or the image
 * resized to cover. Idempotent: written to a temp name, renamed, then stored; concurrent callers share one run.
 */
const thumbRuns = new Map<string, Promise<string>>();
export function ensureBumperThumb(
  deps: { ffmpeg: NormaliseDeps["ffmpeg"]; storage: Storage; dir: string },
  asset: { id: string; kind: "video" | "image" | "audio"; durationSec: number; sourceKey: string; mime?: string | null },
  localSource?: string,
): Promise<string> {
  const running = thumbRuns.get(asset.id);
  if (running) return running;
  const run = (async () => {
    if (asset.kind === "audio") throw new Error("audio has no thumbnail");
    const key = keys.assetThumb(asset.sourceKey);
    if (await deps.storage.exists(key)) return key;
    const dir = path.join(deps.dir, `bumper-thumb-${asset.id}`);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `${randomUUID()}.tmp.jpg`);
    const final = path.join(dir, "thumb.jpg");
    try {
      // an SVG is rasterised first (resvg), then cropped like any picture; the PNG stays in storage for the renderer
      const source = isSvgAsset(asset)
        ? await ensureRaster({ storage: deps.storage, dir }, asset, RASTER_WIDTH)
        : (localSource ?? (await deps.storage.ensureLocal(asset.sourceKey, path.join(dir, path.posix.basename(asset.sourceKey)))));
      const seek = asset.kind === "video" ? ["-ss", (asset.durationSec / 3).toFixed(2)] : [];
      await deps.ffmpeg([
        "-y",
        ...seek,
        "-i",
        source,
        "-frames:v",
        "1",
        "-vf",
        `scale=${BUMPER_THUMB.width}:${BUMPER_THUMB.height}:force_original_aspect_ratio=increase,crop=${BUMPER_THUMB.width}:${BUMPER_THUMB.height}`,
        "-q:v",
        "4",
        tmp,
      ]);
      if (!(await nonEmpty(tmp))) throw new Error("thumbnail was empty");
      await fs.rename(tmp, final);
      await deps.storage.putFile(key, final, "image/jpeg");
      return key;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })().finally(() => thumbRuns.delete(asset.id));
  thumbRuns.set(asset.id, run);
  return run;
}

/** sha256 of a file, streamed (bumpers can be 50 MB; never read whole into memory). */
export async function sha256File(file: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}
