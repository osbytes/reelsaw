/**
 * A sparse source (docs/specs/range-clipping.md, slice 3): a link with ranges downloads only its padded ranges
 * (`--download-sections`), and they are joined on the source clock with a black, silent filler for the time no range
 * asked for. The result is one ordinary file as long as the video, so every stage that reads the source by time
 * (transcription, scene and text scans, the editor's player, render) works unchanged, while only the ranges were
 * fetched, transcribed and counted.
 *
 * The join is a stream copy (concat demuxer, each part cut with `outpoint`), so a piece is never re-encoded unless its
 * codecs differ from the first piece's; the filler is encoded to match it at one frame a second, a few KB a minute.
 * A spike (plan 3.1) found yt-dlp's sections start on the requested second for YouTube, so each piece is placed at its
 * requested start.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { ProbeInfo } from "../media.js";
import { ENCODE_PASS_CPU } from "../resources.js";
import type { StageContext } from "./common.js";

/** One downloaded stretch of the video: the file and the source seconds it holds. */
export interface SourcePiece {
  path: string;
  startSec: number;
  endSec: number;
}

/** What a part must share with the first piece for a stream-copy join. */
type Shape = Required<Pick<ProbeInfo, "width" | "height" | "videoCodec" | "audioCodec" | "sampleRate" | "channels" | "videoTimescale">>;

/** The shape a piece is joined in, from its probe; null when the probe lacks something a join needs. */
export function joinShape(p: ProbeInfo): Shape | null {
  const { width, height, videoCodec, audioCodec, sampleRate, channels, videoTimescale } = p;
  if (!width || !height || !videoCodec || !audioCodec || !sampleRate || !channels || !videoTimescale) return null;
  return { width, height, videoCodec, audioCodec, sampleRate, channels, videoTimescale };
}

const sameShape = (a: Shape, b: Shape) =>
  a.width === b.width &&
  a.height === b.height &&
  a.videoCodec === b.videoCodec &&
  a.audioCodec === b.audioCodec &&
  a.sampleRate === b.sampleRate &&
  a.channels === b.channels &&
  a.videoTimescale === b.videoTimescale;

/**
 * The concat list that lays the parts on the source clock: each gap a filler cut to the gap's length, each piece cut
 * to its range's length (a section file may run a few frames long). Pure, so the layout is unit tested.
 */
export function concatPlan(
  pieces: ReadonlyArray<{ startSec: number; endSec: number }>,
  durationSec: number,
): Array<{ kind: "filler"; sec: number } | { kind: "piece"; index: number; sec: number }> {
  const out: Array<{ kind: "filler"; sec: number } | { kind: "piece"; index: number; sec: number }> = [];
  let at = 0;
  pieces.forEach((p, index) => {
    if (p.startSec > at + 0.01) out.push({ kind: "filler", sec: p.startSec - at });
    out.push({ kind: "piece", index, sec: p.endSec - p.startSec });
    at = p.endSec;
  });
  if (durationSec > at + 0.01) out.push({ kind: "filler", sec: durationSec - at });
  return out;
}

/** Join the pieces (in source order, not overlapping) into one file `durationSec` long on the source clock. */
export async function buildSparseSource(ctx: StageContext, pieces: SourcePiece[], durationSec: number, dir: string): Promise<string> {
  const { svc } = ctx;
  const [first] = pieces;
  if (!first) throw new Error("No pieces to join");
  const firstShape = joinShape(await svc.media.ffprobe(first.path));
  if (!firstShape) throw new Error("The first downloaded range has no usable video and audio");
  // the filler is H.264 and AAC, so every part is joined in those codecs (the format asked for prefers them anyway)
  const shape: Shape = { ...firstShape, videoCodec: "h264", audioCodec: "aac" };
  const encode = (argv: string[]) =>
    svc.resources.withCpu({ kind: "sparse-source", cpu: ENCODE_PASS_CPU, ids: { projectId: ctx.projectId } }, (threads) =>
      svc.media.ffmpeg(argv, { signal: ctx.signal, threads }),
    );
  // a piece in another shape (another codec, or a site that served another encode for one range) is re-encoded to it
  const parts: string[] = [];
  for (const [i, p] of pieces.entries()) {
    const s = joinShape(await svc.media.ffprobe(p.path));
    if (s && sameShape(s, shape)) {
      parts.push(p.path);
      continue;
    }
    const out = path.join(dir, `piece-${i}-joined.mp4`);
    await encode([
      "-y",
      "-i",
      p.path,
      "-vf",
      `scale=${shape.width}:${shape.height}:force_original_aspect_ratio=decrease,pad=${shape.width}:${shape.height}:(ow-iw)/2:(oh-ih)/2`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-ar",
      String(shape.sampleRate),
      "-ac",
      String(shape.channels),
      "-video_track_timescale",
      String(shape.videoTimescale),
      out,
    ]);
    parts.push(out);
  }
  const lines: string[] = [];
  for (const [i, step] of concatPlan(pieces, durationSec).entries()) {
    if (step.kind === "piece") {
      lines.push(`file '${(parts[step.index] ?? "").replace(/'/g, "'\\''")}'`, `outpoint ${step.sec.toFixed(3)}`);
      continue;
    }
    // black and silent at one frame a second, in the first piece's shape: a few KB a minute
    const filler = path.join(dir, `filler-${i}.mp4`);
    await encode([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${shape.width}x${shape.height}:r=1`,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=${shape.sampleRate}:cl=${shape.channels === 1 ? "mono" : "stereo"}`,
      "-t",
      String(Math.ceil(step.sec) + 1),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-tune",
      "stillimage",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "32k",
      "-video_track_timescale",
      String(shape.videoTimescale),
      filler,
    ]);
    lines.push(`file '${filler.replace(/'/g, "'\\''")}'`, `outpoint ${step.sec.toFixed(3)}`);
  }
  const list = path.join(dir, "sparse.txt");
  await fs.writeFile(list, `${lines.join("\n")}\n`);
  const out = path.join(dir, "source.mp4");
  await svc.media.ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out], {
    signal: ctx.signal,
    threads: "light",
  });
  return out;
}
