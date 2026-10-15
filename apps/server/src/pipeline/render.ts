import path from "node:path";
import fs from "node:fs/promises";
import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Transcript } from "../db/schema.js";
import { keys } from "../storage/index.js";
import type { Services } from "../services.js";
import { StageContext, cleanupWorkdir } from "./common.js";
import { buildAss } from "./captions.js";
import { cutRanges, cutPlan } from "./disfluency.js";
import { needsPrepare, prepareModeOf } from "./manual.js";
import { QUEUES } from "../queue/boss.js";
import { refineCuts, type CutRange, type RefineResult } from "./audiocuts.js";
import { transcribe as aiTranscribe } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { toWords } from "./transcript.js";
import { sampleFaces, dropStaticFaces, piecewiseExpr, localTrack, suffixLabels, coverTimeline, resolveSegments, trackCenter, sparseTrack, type Layout, type LayoutDecision, type FaceSample, type TimelineMode } from "./layout.js";
import { resolveStyle, speakerCrop, cropX, type DetectedSegment, type ClipDiagnostics, type SourceOverlay } from "@reelsaw/shared";
import type { Logger } from "../log.js";

const OUT_W = 1080;
const OUT_H = 1920;

const FIT_CHAIN = (w: number, h: number) =>
  `[0:v]split=2[bg][fg];` +
  `[bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=luma_radius=40:luma_power=2:chroma_radius=20:chroma_power=2[bgb];` +
  `[fg]scale=${w}:${h}:force_original_aspect_ratio=decrease[fgs];` +
  `[bgb][fgs]overlay=(W-w)/2:(H-h)/2`;

/**
 * Build the ffmpeg filter chain for a resolved layout.
 * `track` (normalized face centers over clip time) drives the moving crop for "face" and "stack".
 */
/** Extra framing inputs: face size per speaker and burned-in text bands to keep out of speaker crops. */
export interface FrameGeometry {
  size?: number;
  size2?: number;
  avoid?: Array<{ y1: number; y2: number }>;
}

export function layoutFilter(layout: Layout, srcW: number, srcH: number, track: LayoutDecision["track"] = [], track2: LayoutDecision["track"] = [], geo: FrameGeometry = {}): { chain: string; width: number; height: number } {
  if (layout === "none") {
    const w = Math.round(srcW / 2) * 2;
    const h = Math.round(srcH / 2) * 2;
    return { chain: `[0:v]scale=${w}:${h},setsar=1`, width: w, height: h };
  }
  // every chain ends with setsar=1 so differently framed segments can be concatenated
  if (layout === "fit") return { chain: `${FIT_CHAIN(OUT_W, OUT_H)},setsar=1`, width: OUT_W, height: OUT_H };

  // crop window: full height, 9:16 wide (or full width if the source is already narrower)
  const cropW = Math.min(srcW, Math.round((srcH * 9) / 16));
  const cropH = Math.min(srcH, Math.round((srcW * 16) / 9));
  const xs = track.map((p) => ({ t: p.t, v: Math.max(0, Math.min(srcW - cropW, p.x * srcW - cropW / 2)) }));
  const xExpr = !xs.length ? `(iw-${cropW})/2` : piecewiseExpr(xs, 2);
  const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

  if (layout === "split") {
    // two speakers stacked, each crop sized to its face (≈3 face-heights) so it can actually centre
    // the speaker; a full-height 9:8 crop of a wide shot is ~60% of the frame and pins edge faces
    const halfH = OUT_H / 2;
    const mk = (tr: LayoutDecision["track"], size: number | undefined, label: string, out: string) => {
      const c = speakerCrop(srcW, srcH, OUT_W / halfH, { cy: trackCenter(tr).y, size: size ?? 0.3 }, geo.avoid);
      const w = even(c.w);
      const h = even(c.h);
      const pts = tr.map((p) => ({ t: p.t, v: cropX(srcW, w, p.x) }));
      const x = pts.length ? piecewiseExpr(pts, 2) : `(iw-${w})/2`;
      return `[${label}]crop=${w}:${h}:x='${x}':y=${c.y},scale=${OUT_W}:${halfH}:flags=lanczos[${out}]`;
    };
    const t2 = track2.length ? track2 : track;
    return {
      chain: `[0:v]split=2[a][b];` + `${mk(track, geo.size, "a", "as")};` + `${mk(t2, geo.size2 ?? geo.size, "b", "bs")};` + `[as][bs]vstack,setsar=1`,
      width: OUT_W,
      height: OUT_H,
    };
  }
  if (layout === "stack") {
    // top: whole frame letterboxed to 1080 wide; bottom: speaker crop sized to the (small) face
    const topH = Math.round((OUT_W * srcH) / srcW / 2) * 2;
    const botH = OUT_H - topH;
    const c = speakerCrop(srcW, srcH, OUT_W / botH, { cy: trackCenter(track).y, size: geo.size ?? 0.17 }, geo.avoid);
    const zoomW = even(c.w);
    const zoomH = even(c.h);
    const zx = track.map((p) => ({ t: p.t, v: cropX(srcW, zoomW, p.x) }));
    const zxExpr = zx.length ? piecewiseExpr(zx, 2) : `(iw-${zoomW})/2`;
    return {
      chain:
        `[0:v]split=2[top][bot];` +
        `[top]scale=${OUT_W}:${topH}:flags=lanczos[tops];` +
        `[bot]crop=${zoomW}:${zoomH}:x='${zxExpr}':y=${c.y},scale=${OUT_W}:${botH}:flags=lanczos[bots];` +
        `[tops][bots]vstack,setsar=1`,
      width: OUT_W,
      height: OUT_H,
    };
  }
  // face / center
  return {
    chain: `[0:v]crop=${cropW}:${cropH}:x='${xExpr}':y='(ih-${cropH})/2',scale=${OUT_W}:${OUT_H}:flags=lanczos,setsar=1`,
    width: OUT_W,
    height: OUT_H,
  };
}


function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

export async function renderClip(ctx: StageContext, clipId: string) {
  const { svc, projectId, db } = ctx;
  const project = await ctx.project();
  const clip = await db.query.clips.findFirst({ where: and(eq(schema.clips.id, clipId), eq(schema.clips.projectId, projectId)) });
  const log = ctx.log.child({ clipId });
  if (!clip) return; // deleted; nothing to do
  if (needsPrepare(clip)) {
    // clip.prepare renders it once metadata/bounds exist; make sure that job exists and stop here
    if (clip.status !== "preparing") await db.update(schema.clips).set({ status: "preparing", updatedAt: new Date() }).where(eq(schema.clips.id, clipId));
    if (!(await svc.queue.hasLiveJob(QUEUES.prepare, clipId))) await svc.queue.enqueue(QUEUES.prepare, { projectId, clipId, mode: prepareModeOf(clip) });
    log.warn("render requested before the clip was prepared; sent back to clip.prepare");
    return;
  }

  if (clip.status === "done" && clip.outputKey && (await svc.storage.exists(clip.outputKey))) {
    await finalizeProjectIfDone(svc, projectId);
    return;
  }
  await svc.resources.acquire({ kind: "render", needDiskMB: 512, signal: ctx.signal, onWait: (r) => void ctx.progress(0, `Waiting for resources: ${r}`, { clipId }).catch(() => {}) });
  const sourcePath = await ctx.ensureSource(project);
  const clipsDir = path.join(await ctx.dir(), "clips");
  await fs.mkdir(clipsDir, { recursive: true });
  const outPath = path.join(clipsDir, `${clip.id}.mp4`);
  const thumbPath = path.join(clipsDir, `${clip.id}.jpg`);

  const renderStarted = Date.now();
  await db.update(schema.clips).set({ status: "rendering", error: null, updatedAt: new Date() }).where(eq(schema.clips.id, clipId));
  await svc.events.emit(projectId, "clip.rendering", { clipId });

  const settings = project.settings;
  const duration = clip.endSec - clip.startSec;
  const srcW = project.width ?? 1920;
  const srcH = project.height ?? 1080;

  // framing: user sections (absolute seconds) over a default mode (legacy clip/project override, else auto)
  const defaultMode = (clip.layoutOverride ?? settings.reframe ?? "auto") as TimelineMode;
  const sections = (clip.layoutSections ?? []).map((sc) => ({ start: sc.start - clip.startSec, end: sc.end - clip.startSec, mode: sc.mode as TimelineMode, offsetX: sc.offsetX }));
  const timeline = coverTimeline(duration, sections, defaultMode);
  const needsFaces = timeline.some((pc) => pc.mode === "auto" || pc.mode === "face" || pc.mode === "split" || pc.mode === "stack");
  const transcriptMeta = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId), columns: { sceneCuts: true, overlays: true } });
  // burned-in captions / watermarks: keep them out of speaker crops, blur whatever is still visible
  const overlays: SourceOverlay[] = settings.sourceText === "keep" ? [] : (transcriptMeta?.overlays ?? []);
  const avoid = overlays.map((o) => ({ y1: o.y1, y2: o.y2 }));
  const geoOf = (d: LayoutDecision): FrameGeometry => ({ size: d.speakerSizes?.[0] ?? d.faceSize, size2: d.speakerSizes?.[1], avoid });
  const sceneCuts = (transcriptMeta?.sceneCuts ?? []).map((c) => c - clip.startSec).filter((c) => c > 0 && c < duration);
  let samples: FaceSample[] = [];
  if (svc.faces && needsFaces) {
    await ctx.progress(0.02, `Detecting faces for clip ${clip.index + 1}`, { clipId });
    samples = await sampleFaces(svc.faces, { ffmpegPath: svc.config.FFMPEG_PATH, source: sourcePath, startSec: clip.startSec, durationSec: duration, signal: ctx.signal, sampleFps: 4 });
    const filtered = dropStaticFaces(samples);
    if (filtered.dropped.length) log.info({ dropped: filtered.dropped }, "ignoring static faces (posters/photos)");
    samples = filtered.samples;
  }
  // a single-segment clip in "none" keeps its aspect; anything mixed is 9:16 so pieces can be concatenated
  let segments = resolveSegments(timeline, samples, svc.config, sceneCuts, !!svc.faces);
  if (segments.length > 1) segments = segments.map((sg) => (sg.decision.layout === "none" ? { ...sg, decision: { ...sg.decision, layout: "fit" as const } } : sg));
  const first = segments[0]!;
  const summary = segments.map((sg) => `${sg.decision.layout}${sg.manual ? "*" : ""} ${sg.start.toFixed(0)}–${sg.end.toFixed(0)}s`).join(", ");
  log.info({ layout: summary, reason: first.decision.reason, facesPerFrame: first.decision.faceCount }, "layout resolved");
  const detected: DetectedSegment[] = segments.map((sg) => {
    const c1 = trackCenter(sg.decision.track);
    const c2 = sg.decision.track2 ? trackCenter(sg.decision.track2) : undefined;
    return {
      start: Number((sg.start + clip.startSec).toFixed(2)),
      end: Number((sg.end + clip.startSec).toFixed(2)),
      layout: sg.decision.layout,
      manual: sg.manual,
      reason: sg.decision.reason,
      cx: Number(c1.x.toFixed(3)),
      cy: Number(c1.y.toFixed(3)),
      ...(c2 ? { cx2: Number(c2.x.toFixed(3)), cy2: Number(c2.y.toFixed(3)) } : {}),
      size: Number((sg.decision.speakerSizes?.[0] ?? sg.decision.faceSize).toFixed(3)),
      ...(sg.decision.speakerSizes ? { size2: sg.decision.speakerSizes[1] } : {}),
      ...(sg.decision.track.length > 1 ? { track: sparseTrack(sg.decision.track, sg.start, sg.end, clip.startSec) } : {}),
      ...(sg.offsetX ? { offsetX: sg.offsetX } : {}),
    };
  });
  await db
    .update(schema.clips)
    .set({
      layout: segments.length > 1 ? "mixed" : first.decision.layout,
      layoutSegments: detected,
      layoutInfo: { reason: segments.length > 1 ? summary : first.decision.reason, faceRatio: first.decision.faceRatio, faceSize: first.decision.faceSize },
    })
    .where(eq(schema.clips.id, clipId));
  const { chain, width, height } = layoutFilter(first.decision.layout, srcW, srcH, first.decision.track, first.decision.track2 ?? [], geoOf(first.decision));

  const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId) });
  // optional jump cuts for accepted disfluencies; everything downstream works in post-cut time
  // accepted disfluencies are always cut (jump cuts verified per seam; unverifiable cuts are skipped)
  const cutResult = await planClipCuts(svc, { startSec: clip.startSec, endSec: clip.endSec }, transcript ?? null, sourcePath, ctx.signal, log, (i, n, attempt) =>
    void ctx.progress(0.05, `Verifying disfluency cut ${i + 1}/${n}${attempt > 1 ? ` (try ${attempt})` : ""}`, { clipId }).catch(() => {}),
  );
  for (const sk of cutResult.skipped) log.warn({ span: [sk.range.start, sk.range.end], reason: sk.reason }, "disfluency cut skipped");
  for (const c of cutResult.cuts) log.debug({ cut: [c.start, c.end] }, "disfluency cut");
  const cuts = cutResult.cuts;
  const plan = cutPlan(duration, cuts);
  const outDuration = cuts.length ? plan.newDuration : duration;
  const words = (transcript?.words ?? [])
    .filter((w) => w.end > clip.startSec && w.start < clip.endSec)
    .map((w) => ({ text: w.text, start: Math.max(0, w.start - clip.startSec), end: Math.min(duration, w.end - clip.startSec) }))
    .filter((w) => !cuts.some((c) => w.start >= c.start - 0.001 && w.end <= c.end + 0.001))
    .map((w) => ({ text: w.text, start: plan.mapTime(w.start), end: Math.max(plan.mapTime(w.start) + 0.05, plan.mapTime(w.end)) }));
  if (cuts.length) log.info({ cuts: cuts.length, inSec: Number(duration.toFixed(2)), outSec: Number(outDuration.toFixed(2)) }, "applying jump cuts");
  const assPath = path.join(clipsDir, `${clip.id}.ass`);
  await fs.writeFile(
    assPath,
    buildAss(words, { width, height, font: svc.config.CAPTION_FONT, style: resolveStyle(settings, clip.style), hook: clip.hook, emphasis: clip.emphasis ?? [] }),
    "utf8",
  );

  const tmpOut = `${outPath}.tmp.mp4`;
  // with cuts: trim the kept segments and concat them first, then layout + captions run on the result
  let graph: string;
  let audioMap: string[];
  if (segments.length > 1 || cuts.length) {
    // pieces = kept ranges (after cuts) split at layout boundaries; each piece gets its own framing
    const keep = cuts.length ? plan.keep : [{ start: 0, end: duration }];
    const layoutSegs = segments;
    const pieces: Array<{ start: number; end: number; seg: (typeof layoutSegs)[number] }> = [];
    for (const k of keep) {
      for (const seg of layoutSegs) {
        const a = Math.max(k.start, seg.start);
        const b = Math.min(k.end, seg.end);
        if (b - a >= 0.1) pieces.push({ start: a, end: b, seg });
      }
    }
    const XF = 0.02; // crossfade length; each audio piece (but the last) is trimmed this much longer so the fade consumes it
    const src = sourceVideo(overlays, srcW, srcH, pieces.length);
    const parts = pieces.map((pc, i) => {
      const d = pc.seg.decision;
      const chainI = suffixLabels(layoutFilter(d.layout === "none" ? "fit" : d.layout, srcW, srcH, localTrack(d.track, pc.start, pc.end), d.track2 ? localTrack(d.track2, pc.start, pc.end) : [], geoOf(d)).chain, `s${i}`, `[t${i}]`);
      const aEnd = i < pieces.length - 1 ? Math.min(duration, pc.end + XF) : pc.end;
      return (
        `${src.labels[i]}trim=start=${pc.start.toFixed(3)}:end=${pc.end.toFixed(3)},setpts=PTS-STARTPTS[t${i}];${chainI}[v${i}];` +
        `[0:a]atrim=start=${pc.start.toFixed(3)}:end=${aEnd.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
      );
    });
    const vInputs = pieces.map((_, i) => `[v${i}]`).join("");
    // audio: chain of equal-power crossfades; no clicks at the seams
    let audio = "";
    if (pieces.length === 1) audio = `[a0]anull[ca]`;
    else {
      let prev = "[a0]";
      for (let i = 1; i < pieces.length; i++) {
        const out = i === pieces.length - 1 ? "[ca]" : `[x${i}]`;
        audio += `${prev}[a${i}]acrossfade=d=${XF}:c1=tri:c2=tri${out};`;
        prev = out;
      }
      audio = audio.replace(/;$/, "");
    }
    graph = `${src.prefix}${parts.join(";")};${vInputs}concat=n=${pieces.length}:v=1:a=0[cv];${audio};[cv]ass='${escapeFilterPath(assPath)}'[v]`;
    audioMap = ["-map", "[ca]"];
  } else {
    const src = sourceVideo(overlays, srcW, srcH, 1);
    graph = `${src.prefix}${chain.replace("[0:v]", src.labels[0]!)},ass='${escapeFilterPath(assPath)}'[v]`;
    audioMap = ["-map", "0:a:0?"];
  }
  await svc.media.ffmpeg(
    [
      "-ss", clip.startSec.toFixed(3), "-t", duration.toFixed(3), "-i", sourcePath,
      "-filter_complex", graph,
      "-map", "[v]", ...audioMap,
      "-threads", String(svc.resources.ffmpegThreads()),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p", "-r", "30",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
      "-movflags", "+faststart", "-f", "mp4", tmpOut,
    ],
    { signal: ctx.signal, onProgress: (sec) => void ctx.progress(sec / outDuration, `Rendering clip ${clip.index + 1}`, { clipId }).catch(() => {}) },
  );
  await fs.rename(tmpOut, outPath);
  await svc.media.ffmpeg(["-ss", (outDuration / 3).toFixed(2), "-i", outPath, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "3", thumbPath], { signal: ctx.signal });

  const outputKey = keys.clip(projectId, clip.id);
  const thumbnailKey = keys.thumb(projectId, clip.id);
  await svc.storage.putFile(outputKey, outPath, "video/mp4");
  await svc.storage.putFile(thumbnailKey, thumbPath, "image/jpeg");
  if (svc.storage.driver !== "local") await fs.rm(outPath, { force: true }).catch(() => {});

  const diagnostics: ClipDiagnostics = {
    renderedAt: new Date().toISOString(),
    layout: summary,
    cuts: {
      applied: cutResult.cuts.map((c) => ({ start: Number((c.start + clip.startSec).toFixed(3)), end: Number((c.end + clip.startSec).toFixed(3)) })),
      skipped: cutResult.skipped.map((sk) => ({ start: Number((sk.range.start + clip.startSec).toFixed(3)), end: Number((sk.range.end + clip.startSec).toFixed(3)), reason: sk.reason.slice(0, 2000) })),
    },
    outDurationSec: Number(outDuration.toFixed(2)),
    renderMs: Date.now() - renderStarted,
  };
  await db.update(schema.clips).set({ status: "done", outputKey, thumbnailKey, error: null, diagnostics, updatedAt: new Date() }).where(eq(schema.clips.id, clipId));
  await svc.events.emit(projectId, "clip.done", { clipId, index: clip.index });
  await finalizeProjectIfDone(svc, projectId);
}

export async function markClipFailed(svc: Services, projectId: string, clipId: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  await svc.database.db.update(schema.clips).set({ status: "failed", error: message.slice(0, 4000), updatedAt: new Date() }).where(eq(schema.clips.id, clipId));
  await svc.events.emit(projectId, "clip.failed", { clipId, error: message.slice(0, 1000) });
  await finalizeProjectIfDone(svc, projectId);
}

/** Marks a project done once every clip reached a terminal state. Safe to call repeatedly. */
export async function finalizeProjectIfDone(svc: Services, projectId: string) {
  const db = svc.database.db;
  const clips = await db.query.clips.findMany({ where: eq(schema.clips.projectId, projectId) });
  if (!clips.length || !clips.every((c) => c.status === "done" || c.status === "failed")) return;
  const project = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  if (!project || project.status === "done" || project.status === "failed") return;
  const doneCount = clips.filter((c) => c.status === "done").length;
  if (doneCount === 0) {
    await db.update(schema.projects).set({ status: "failed", error: "Every clip failed to render", updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
    await svc.events.emit(projectId, "project.failed", { stage: "render", error: "Every clip failed to render" });
    return;
  }
  await db.update(schema.projects).set({ status: "done", stage: null, stageProgress: 1, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
  await svc.events.emit(projectId, "project.done", { clips: doneCount, failed: clips.length - doneCount });
  await cleanupWorkdir(svc, projectId).catch((err) => svc.log.warn({ err, projectId }, "workdir cleanup failed"));
}

export interface ClipCutPlan extends RefineResult {
  /** flagged spans (clip-relative) before refinement */
  requested: CutRange[];
}

/**
 * Accepted disfluency flags inside a clip → verified jump cuts (clip-relative seconds). Shared by
 * the renderer and the `cuts` CLI command so a cut can be debugged without a full render.
 */
export async function planClipCuts(
  svc: Services,
  clip: { startSec: number; endSec: number },
  transcript: Pick<Transcript, "flags" | "rawWords" | "words"> | null,
  sourcePath: string,
  signal?: AbortSignal,
  log?: Logger,
  onProgress?: (cut: number, total: number, attempt: number) => void,
): Promise<ClipCutPlan> {
  const duration = clip.endSec - clip.startSec;
  const requested = cutRanges(transcript?.flags ?? [], clip.startSec, clip.endSec);
  if (!requested.length) return { requested, cuts: [], skipped: [] };
  // move each boundary to the quietest point in the gap next to the neighbouring words; drop cuts with no gap
  const clipWords = (transcript?.rawWords ?? transcript?.words ?? [])
    .filter((w) => w.end > clip.startSec - 1 && w.start < clip.endSec + 1)
    .map((w) => ({ text: w.text, start: w.start - clip.startSec, end: w.end - clip.startSec }));
  const alignModelId = svc.config.TRANSCRIPT_ALIGN_MODEL ?? svc.config.TRANSCRIPTION_MODEL;
  const alignModel = await svc.ai.transcriptionModel(alignModelId);
  const alignOptions = svc.ai.transcriptionOptions(alignModelId) as Record<string, JSONObject>;
  const refined = await refineCuts(
    {
      onProgress,
      log: log?.child({ module: "cuts" }),
      ffmpegPath: svc.config.FFMPEG_PATH,
      signal,
      transcribe: async (audio) => {
        const res = await aiTranscribe({ model: alignModel, audio, providerOptions: alignOptions, abortSignal: signal, maxRetries: 2 });
        return toWords(res.segments.map((sg) => ({ text: sg.text, startSecond: sg.startSecond, endSecond: sg.endSecond })));
      },
    },
    sourcePath,
    clip.startSec,
    duration,
    requested,
    clipWords,
  );
  return { requested, ...refined };
}

/**
 * Source video labels for the filtergraph. With burned-in text to hide, the source is masked once
 * (each text region blurred in place) and split for every consumer; otherwise every consumer reads
 * [0:v] directly.
 */
export function sourceVideo(overlays: SourceOverlay[], srcW: number, srcH: number, consumers: number): { prefix: string; labels: string[] } {
  if (!overlays.length) return { prefix: "", labels: Array.from({ length: consumers }, () => "[0:v]") };
  const parts: string[] = [];
  let cur = "[0:v]";
  overlays.forEach((o, i) => {
    // pad a little: detector boxes hug the glyphs, glows and outlines extend past them
    const padX = 0.01 * srcW;
    const padY = 0.012 * srcH;
    const x = Math.max(0, Math.floor(o.x1 * srcW - padX));
    const y = Math.max(0, Math.floor(o.y1 * srcH - padY));
    const w = Math.min(srcW - x, Math.ceil((o.x2 - o.x1) * srcW + 2 * padX));
    const h = Math.min(srcH - y, Math.ceil((o.y2 - o.y1) * srcH + 2 * padY));
    if (w < 4 || h < 4) return;
    // boxblur caps each plane's radius at half its size; chroma planes are half resolution (yuv420p)
    const r = Math.max(1, Math.min(40, Math.floor(Math.min(w, h) / 2) - 1));
    const rc = Math.max(1, Math.min(r, Math.floor(Math.min(w, h) / 4) - 1));
    parts.push(`${cur}split=2[mk${i}a][mk${i}b];[mk${i}b]crop=${w}:${h}:${x}:${y},boxblur=luma_radius=${r}:luma_power=3:chroma_radius=${rc}:chroma_power=3[mk${i}c];[mk${i}a][mk${i}c]overlay=${x}:${y}[mk${i}]`);
    cur = `[mk${i}]`;
  });
  if (!parts.length) return { prefix: "", labels: Array.from({ length: consumers }, () => "[0:v]") };
  const labels = Array.from({ length: consumers }, (_, i) => `[src${i}]`);
  return { prefix: `${parts.join(";")};${cur}split=${consumers}${labels.join("")};`, labels };
}
