/**
 * A/B preview of one disfluency cut: the audio around a transcript flag, as recorded and with the
 * flagged span removed using the renderer's 20 ms equal-power crossfade. Built on demand when the
 * user listens; nothing is precomputed during refine.
 *
 * Cut boundaries, best first:
 *   render     – what the last render of a clip containing the flag actually cut (exact)
 *   search     – the production cut search (`refineCuts`) run on just this window (exact, a few seconds)
 *   timestamps – raw word timestamps from the transcript (approximate, may clip a word edge)
 */
import { spawn } from "node:child_process";
import { and, eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Services } from "../services.js";
import { refineCuts } from "./audiocuts.js";
import { toWords } from "./transcript.js";

export type CutSource = "render" | "search" | "timestamps";
export interface CutPreviewPlan {
  flagId: string;
  heard: string;
  /** absolute source seconds */
  flag: { start: number; end: number };
  cut: { start: number; end: number };
  source: CutSource;
  /** the search or the last render refused this cut: why */
  refused?: string;
}

const XF = 0.02;
const searchCache = new Map<string, { cut?: { start: number; end: number }; refused?: string }>();
const audioCache = new Map<string, Buffer>();
const remember = <V>(m: Map<string, V>, k: string, v: V, max: number) => {
  m.set(k, v);
  if (m.size > max) m.delete(m.keys().next().value!);
  return v;
};

function ffmpeg(bin: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  const out: Buffer[] = [];
  let err = "";
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { signal, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg (${code}): ${err.slice(-300)}`))));
  });
}

async function load(svc: Services, userId: string, projectId: string, flagId: string) {
  const db = svc.database.db;
  const project = await db.query.projects.findFirst({ where: and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)) });
  if (!project?.sourceKey) return null;
  const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId) });
  const flag = transcript?.flags?.find((f) => f.id === flagId);
  if (!transcript || !flag || flag.kind !== "disfluency") return null;
  const loc = await svc.storage.resolve(project.sourceKey);
  return { project, transcript, flag, input: "url" in loc ? loc.url : loc.file };
}

export async function planCutPreview(svc: Services, userId: string, projectId: string, flagId: string, opts: { exact?: boolean; signal?: AbortSignal } = {}): Promise<CutPreviewPlan | null> {
  const ctx = await load(svc, userId, projectId, flagId);
  if (!ctx) return null;
  const { flag, transcript, input, project } = ctx;
  const base = { flagId, heard: flag.heard, flag: { start: flag.start, end: flag.end } };

  // 1. the last render's verified boundaries
  const clips = await svc.database.db.query.clips.findMany({ where: eq(schema.clips.projectId, projectId), columns: { diagnostics: true, startSec: true, endSec: true } });
  for (const c of clips) {
    const d = c.diagnostics;
    if (!d || flag.start < c.startSec || flag.end > c.endSec) continue;
    const hit = d.cuts.applied.find((a) => a.start < flag.end + 0.15 && a.end > flag.start - 0.15);
    if (hit) return { ...base, cut: { start: hit.start, end: hit.end }, source: "render" };
    const sk = d.cuts.skipped.find((s) => Math.abs(s.start - flag.start) < 0.2);
    if (sk && !opts.exact) return { ...base, cut: { start: flag.start, end: flag.end }, source: "timestamps", refused: sk.reason };
  }

  // 2. the production cut search on this window, on request (ASR calls; cached)
  if (opts.exact) {
    const key = `${projectId}:${flagId}:${flag.start}:${flag.end}`;
    let r = searchCache.get(key);
    if (!r) {
      // the full search can take minutes on hard spots (whisper fallback); a preview gets 30 s
      const budget = AbortSignal.timeout(30_000);
      const signal = opts.signal ? AbortSignal.any([opts.signal, budget]) : budget;
      const ws = Math.max(0, flag.start - 3);
      const we = Math.min(project.durationSec ?? flag.end + 3, flag.end + 3);
      const words = (transcript.rawWords ?? transcript.words).filter((w) => w.end > ws && w.start < we).map((w) => ({ text: w.text, start: w.start - ws, end: w.end - ws }));
      const modelId = svc.config.TRANSCRIPT_ALIGN_MODEL ?? svc.config.TRANSCRIPTION_MODEL;
      const res = await refineCuts(
        {
          ffmpegPath: svc.config.FFMPEG_PATH,
          signal,
          log: svc.log.child({ module: "cut-preview" }),
          ...(svc.aligner ? { align: (pcm: Float32Array, ws2: string[]) => svc.aligner!.align(pcm, ws2) } : {}),
          transcribe: async (audio) => toWords((await svc.asr.transcribe(audio, { modelId, signal })).segments),
        },
        input,
        ws,
        we - ws,
        [{ start: flag.start - ws, end: flag.end - ws }],
        words,
      ).catch((err) => {
        if (budget.aborted && !opts.signal?.aborted) return { cuts: [], skipped: [{ range: { start: 0, end: 0 }, reason: "No clean cut found within 30 s. The full render search may still find one." }] };
        throw err;
      });
      const c = res.cuts[0];
      r = remember(searchCache, key, c ? { cut: { start: Number((c.start + ws).toFixed(3)), end: Number((c.end + ws).toFixed(3)) } } : { refused: res.skipped[0]?.reason ?? "no clean cut found" }, 500);
    }
    if (r.cut) return { ...base, cut: r.cut, source: "search" };
    return { ...base, cut: { start: flag.start, end: flag.end }, source: "timestamps", refused: r.refused };
  }

  // 3. raw word timestamps
  return { ...base, cut: { start: flag.start, end: flag.end }, source: "timestamps" };
}

/** MP3 of [flag − pad, flag + pad], optionally with `cut` removed (absolute seconds). */
export async function cutPreviewAudio(
  svc: Services,
  userId: string,
  projectId: string,
  flagId: string,
  opts: { pad: number; cut?: { start: number; end: number }; signal?: AbortSignal },
): Promise<Buffer | null> {
  const ctx = await load(svc, userId, projectId, flagId);
  if (!ctx) return null;
  const { flag, input, project } = ctx;
  const pad = Math.max(0.5, Math.min(10, opts.pad));
  const ws = Math.max(0, Math.min(flag.start, opts.cut?.start ?? flag.start) - pad);
  const we = Math.min(project.durationSec ?? Infinity, Math.max(flag.end, opts.cut?.end ?? flag.end) + pad);
  const key = `${projectId}:${flagId}:${ws.toFixed(3)}:${we.toFixed(3)}:${opts.cut ? `${opts.cut.start}-${opts.cut.end}` : "orig"}`;
  const hit = audioCache.get(key);
  if (hit) return hit;
  const args = ["-ss", ws.toFixed(3), "-t", (we - ws).toFixed(3), "-i", input, "-vn"];
  if (opts.cut) {
    // same seam as the renderer: first piece runs XF past the cut so the crossfade consumes it
    const a = Math.max(0, opts.cut.start - ws);
    const b = Math.max(a, opts.cut.end - ws);
    args.push("-filter_complex", `[0:a]atrim=end=${(a + XF).toFixed(3)},asetpts=PTS-STARTPTS[a];[0:a]atrim=start=${b.toFixed(3)},asetpts=PTS-STARTPTS[b];[a][b]acrossfade=d=${XF}:c1=tri:c2=tri[o]`, "-map", "[o]");
  }
  args.push("-ac", "1", "-ar", "44100", "-b:a", "128k", "-f", "mp3", "pipe:1");
  const buf = await ffmpeg(svc.config.FFMPEG_PATH, args, opts.signal);
  return remember(audioCache, key, buf, 200);
}
