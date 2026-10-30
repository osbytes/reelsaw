import path from "node:path";
import { capDiagnostics } from "../transcript-limits.js";
import fs from "node:fs/promises";
import { eq, and } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { Transcript } from "../db/schema.js";
import { keys } from "../storage/index.js";
import { removeScratchClip } from "../storage/sweep.js";
import type { Services } from "../services.js";
import type { StageContext } from "./common.js";
import { finalizeProjectIfDone as finalizeInTx, requestPrepare } from "./lifecycle.js";
import { watermarkFor } from "../quota.js";
import { buildAss, renderedCaptions } from "./captions.js";
import { cutRanges, cutPlan } from "./disfluency.js";
import { needsPrepare } from "./manual.js";
import { attachText, voteTrace } from "./content-region.js";
import { createHash } from "node:crypto";
import { growOverlays, sampleClipText, overlayWindows, tightenOverlays, dropFaceOverlaps, mergeRegions } from "./overlays.js";
import { speechSegments, pauseCuts, VAD_SR } from "../audio/vad.js";
import { alignWordTimes } from "../audio/align.js";
import { activeSpeakers, speechAt, envelopeAt } from "./speaker.js";
import { spawn } from "node:child_process";
import { refineCuts, type CutRange, type RefineResult } from "./audiocuts.js";
import { normalizeToken } from "@reelsaw/shared";
import { toWords } from "./transcript.js";
import { textHeavyRuns, fitTextHeavy, sampleFaces, dropStaticFaces, piecewiseExpr, localTrack, suffixLabels, coverTimeline, resolveSegments, newLayoutDiag, trackCenter, sparseTrack, type Layout, type LayoutDecision, type FaceSample, type TimelineMode, type SectionAdjust } from "./layout.js";
import { OVERLAY_PAD_X, OVERLAY_PAD_Y, verticalCrop, resolveStyle, resolveFraming, speakerCrop, cropX, contentStackGeometry, isFullFrame, tileCrop, shiftRegion, overlayKind, TEXT_OVERLAY_DEFAULTS, ASSET_OVERLAY_DEFAULT_W, CLIP_AUDIO_DEFAULTS, clipLayers, isStickerAsset, type AssetLayer, type TextLayer, type AudioLayer, type ContentRegion, masksSourceText, layoutSeamY, mergeSeamRuns, type DetectedSegment, type ClipDiagnostics, type SourceOverlay, type ClipOverlay, type ClipAudio } from "@reelsaw/shared";
import { WATERMARK_LOGO, type TextOverlayEvent } from "./captions.js";
import type { Logger } from "../log.js";
import { ffmpegThreadArgs, type VideoEncoder } from "../media.js";
import { bumperConcat, bumperFrames, resolveClipBumpers, ensureNormalised, ensureRaster, isSvgAsset, RASTER_WIDTH, BUMPER_FPS } from "./bumpers.js";

const OUT_W = 1080;
const OUT_H = 1920;
/** Soft edge of a burned-in text blur, as a fraction of the source height (`sourceVideo`). */
const BLUR_FEATHER = 0.01;
/** How long a burned-in text blur takes to fade in before its text shows and out after it goes. */
const BLUR_FADE_SEC = 0.25;

export const FIT_CHAIN = (w: number, h: number) =>
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
  /** "stack": the region of the frame shown on top (absent or the whole frame = the classic stack) */
  content?: ContentRegion;
  /** "stack": the speaker is a webcam tile at these bounds; the bottom pane shows the tile alone (`tileCrop`) */
  tile?: ContentRegion;
  /** the user's fixed crop for the first pane (the only pane, the top of a split, the speaker of a stack): shown with `fitPane` */
  crop?: ContentRegion;
  /** the user's fixed crop for the bottom pane of a split */
  crop2?: ContentRegion;
}

/**
 * A part of the source shown in a pane at its own aspect over a blurred copy of itself (the way `fit`
 * shows a frame): a webcam tile in the speaker pane of a stack, or a crop the user fixed on any pane.
 * Reads `[in]`; with `outLabel` the chain ends in `[out];`, without it the overlay is left open for
 * the caller to finish (`,setsar=1`). Labels inside are prefixed with `tag` so two panes can coexist.
 */
export function fitPane(srcW: number, srcH: number, region: ContentRegion, paneW: number, paneH: number, inLabel: string, outLabel: string, tag = "t"): string {
  const c = tileCrop(srcW, srcH, region);
  const blur = "boxblur=luma_radius=40:luma_power=2:chroma_radius=20:chroma_power=2";
  return (
    `[${inLabel}]crop=${c.w}:${c.h}:${c.x}:${c.y},split=2[${tag}bg][${tag}fg];` +
    `[${tag}bg]scale=${paneW}:${paneH}:force_original_aspect_ratio=increase,crop=${paneW}:${paneH},${blur}[${tag}bgb];` +
    `[${tag}fg]scale=${paneW}:${paneH}:force_original_aspect_ratio=decrease:flags=lanczos[${tag}fgs];` +
    `[${tag}bgb][${tag}fgs]overlay=(W-w)/2:(H-h)/2${outLabel ? `[${outLabel}];` : ""}`
  );
}

export function layoutFilter(layout: Layout, srcW: number, srcH: number, track: LayoutDecision["track"] = [], track2: LayoutDecision["track"] = [], geo: FrameGeometry = {}): { chain: string; width: number; height: number } {
  if (layout === "none") {
    const w = Math.round(srcW / 2) * 2;
    const h = Math.round(srcH / 2) * 2;
    return { chain: `[0:v]scale=${w}:${h},setsar=1`, width: w, height: h };
  }
  // every chain ends with setsar=1 so differently framed segments can be concatenated
  // a crop the user fixed on a whole-frame pane: that part of the source, fitted at its own shape over a blurred copy
  if (geo.crop && layout !== "split" && layout !== "stack") return { chain: `${fitPane(srcW, srcH, geo.crop, OUT_W, OUT_H, "0:v", "")},setsar=1`, width: OUT_W, height: OUT_H };
  if (layout === "fit") return { chain: `${FIT_CHAIN(OUT_W, OUT_H)},setsar=1`, width: OUT_W, height: OUT_H };

  // crop window: full height, 9:16 wide (or full width if the source is already narrower)
  const vc = verticalCrop(srcW, srcH);
  const cropW = Math.round(vc.w);
  const cropH = Math.round(vc.h);
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
    // a pane the user fixed to a part of the source shows just that, at its own shape over a blurred copy
    const top = geo.crop ? fitPane(srcW, srcH, geo.crop, OUT_W, halfH, "a", "as", "ta") : `${mk(track, geo.size, "a", "as")};`;
    const bottom = geo.crop2 ? fitPane(srcW, srcH, geo.crop2, OUT_W, halfH, "b", "bs", "tb") : `${mk(t2, geo.size2 ?? geo.size, "b", "bs")};`;
    return {
      chain: `[0:v]split=2[a][b];` + top + bottom + `[as][bs]vstack,setsar=1`,
      width: OUT_W,
      height: OUT_H,
    };
  }
  if (layout === "stack" && geo.content && !isFullFrame(geo.content)) {
    // top half: just the content region (an app screen or title card), kept at its own aspect over a
    // blurred copy of itself; bottom half: the speaker, cropped from the part of the frame it is not on
    const halfH = OUT_H / 2;
    const g = contentStackGeometry(srcW, srcH, geo.content, { cy: trackCenter(track).y, size: geo.size ?? 0.3 }, OUT_W / halfH, geo.avoid);
    const px1 = Math.floor(g.content.x / 2) * 2;
    const py1 = Math.floor(g.content.y / 2) * 2;
    const pw = Math.floor(g.content.w / 2) * 2;
    const ph = Math.floor(g.content.h / 2) * 2;
    const free = g.free;
    const zoomW = Math.floor(g.zoom.w / 2) * 2;
    const zoomH = Math.floor(g.zoom.h / 2) * 2;
    const zoomY = Math.round(g.zoom.y);
    const zx = track.map((tp) => ({ t: tp.t, v: Math.max(free.lo, Math.min(free.hi - zoomW, tp.x * srcW - zoomW / 2)) }));
    const zxExpr = zx.length ? piecewiseExpr(zx, 2) : `${Math.round((free.lo + free.hi - zoomW) / 2)}`;
    const blur = "boxblur=luma_radius=40:luma_power=2:chroma_radius=20:chroma_power=2";
    const fixed = geo.crop ?? geo.tile;
    const bots = fixed ? fitPane(srcW, srcH, fixed, OUT_W, halfH, "bot", "bots") : `[bot]crop=${zoomW}:${zoomH}:x='${zxExpr}':y=${zoomY},scale=${OUT_W}:${halfH}:flags=lanczos[bots];`;
    return {
      chain:
        `[0:v]split=2[psrc][bot];` +
        `[psrc]crop=${pw}:${ph}:${px1}:${py1},split=2[pbg][pfg];` +
        `[pbg]scale=${OUT_W}:${halfH}:force_original_aspect_ratio=increase,crop=${OUT_W}:${halfH},${blur}[pbgb];` +
        `[pfg]scale=${OUT_W}:${halfH}:force_original_aspect_ratio=decrease:flags=lanczos[pfgs];` +
        `[pbgb][pfgs]overlay=(W-w)/2:(H-h)/2[tops];` +
        bots +
        `[tops][bots]vstack,setsar=1`,
      width: OUT_W,
      height: OUT_H,
    };
  }
  if (layout === "stack") {
    // top: whole frame letterboxed to 1080 wide; bottom: speaker crop sized to the (small) face
    const fittedH = Math.round((OUT_W * srcH) / srcW / 2) * 2;
    // a portrait source already fills 9:16: leaving the speaker pane at 0 makes `scale=1080:0` fail
    const topH = Math.min(fittedH, OUT_H - 2);
    const botH = OUT_H - topH;
    const c = speakerCrop(srcW, srcH, OUT_W / botH, { cy: trackCenter(track).y, size: geo.size ?? 0.17 }, geo.avoid);
    const zoomW = even(c.w);
    const zoomH = even(c.h);
    const zx = track.map((p) => ({ t: p.t, v: cropX(srcW, zoomW, p.x) }));
    const zxExpr = zx.length ? piecewiseExpr(zx, 2) : `(iw-${zoomW})/2`;
    // a webcam tile (or a crop the user fixed): the bottom pane is that alone, not a face-sized crop that would reach past it
    const fixed = geo.crop ?? geo.tile;
    const bots = fixed ? fitPane(srcW, srcH, fixed, OUT_W, botH, "bot", "bots") : `[bot]crop=${zoomW}:${zoomH}:x='${zxExpr}':y=${c.y},scale=${OUT_W}:${botH}:flags=lanczos[bots];`;
    return {
      chain:
        `[0:v]split=2[top][bot];` +
        `[top]scale=${OUT_W}:${topH}:flags=lanczos[tops];` +
        bots +
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


/**
 * A path for a filter option written as name='…' in a filtergraph. The graph parser takes the quoted text
 * literally, then the option parser unescapes it: backslash first, then ':' (its separator). A quote has to
 * leave the quoted text, pass the graph parser as \' and reach the option parser as an escaped quote.
 */
function escapeFilterPath(p: string): string {
  return p.replace(/[\\:]/g, (c) => `\\${c}`).replace(/'/g, "'\\\\\\''");
}

/** Short checksum of a sample's contents (time, face boxes, divider, text boxes): two renders of one clip log the same value. */
function sampleDigest(s: FaceSample | undefined): string | null {
  return s ? createHash("sha1").update(JSON.stringify([s.t, s.boxes, s.divider, s.text])).digest("hex").slice(0, 10) : null;
}

export async function renderClip(ctx: StageContext, clipId: string, jobGen?: number) {
  const { svc, projectId, db } = ctx;
  const project = await ctx.project();
  const clip = await db.query.clips.findFirst({ where: and(eq(schema.clips.id, clipId), eq(schema.clips.projectId, projectId)) });
  const log = ctx.log.child({ clipId });
  if (!clip || clip.deletedAt) return; // deleted (or replaced by a re-analyze); nothing to do
  // the generation this job renders; jobs from before generations existed render the current one
  const gen = jobGen ?? clip.renderGen;
  if (gen !== clip.renderGen) {
    log.info({ jobGen: gen, currentGen: clip.renderGen }, "stale render job (clip changed since); skipping");
    return;
  }
  if (needsPrepare(clip)) {
    // clip.prepare renders it once metadata/bounds exist; make sure that job exists and stop here
    // restart: false keeps a prepare job already running (and leaves this render job alone)
    await svc.tx((u) => requestPrepare(svc, u, projectId, clipId, { restart: false }));
    log.warn("render requested before the clip was prepared; sent back to clip.prepare");
    return;
  }

  if (clip.status === "done" && clip.outputKey && (await svc.storage.exists(clip.outputKey))) {
    await finalizeProjectIfDone(svc, projectId);
    return;
  }
  await ctx.acquire("render", 512, { clipId });
  const sourcePath = await ctx.ensureSource(project);
  const clipsDir = path.join(await ctx.dir(), "clips");
  await fs.mkdir(clipsDir, { recursive: true });
  // per-generation scratch names: an overlapping stale render never touches these files
  const outPath = path.join(clipsDir, `${clip.id}.${gen}.mp4`);
  const thumbPath = path.join(clipsDir, `${clip.id}.${gen}.jpg`);

  const renderStarted = Date.now();
  const started = await svc.tx(async (u) => {
    const r = await u.db
      .update(schema.clips)
      .set({ status: "rendering", error: null, updatedAt: new Date() })
      .where(and(eq(schema.clips.id, clipId), eq(schema.clips.renderGen, gen)))
      .returning({ id: schema.clips.id });
    if (r.length) await u.emit(projectId, "clip.rendering", { clipId });
    return r.length > 0;
  });
  if (!started) {
    log.info({ gen }, "clip changed before rendering started; skipping");
    return;
  }

  const settings = project.settings;
  const duration = clip.endSec - clip.startSec;
  log.debug({ gen, index: clip.index, startSec: clip.startSec, endSec: clip.endSec, durationSec: Number(duration.toFixed(2)), origin: clip.origin }, "render start");
  const srcW = project.width ?? 1920;
  const srcH = project.height ?? 1080;

  // framing: user sections (absolute seconds) over a default mode (legacy clip/project override, else auto)
  // (resolveFraming is the same reading get_clip reports; the project's adjustment goes with the project's mode, not with a legacy per-clip override)
  const framing = resolveFraming(clip, settings);
  const defaultMode: TimelineMode = framing.mode;
  const sections = framing.sections.map((sc) => ({ ...sc, start: sc.start - clip.startSec, end: sc.end - clip.startSec, mode: sc.mode as TimelineMode }));
  const timeline = coverTimeline(duration, sections, defaultMode, framing.adjust);
  log.debug({ defaultMode, sections: sections.length, timeline: timeline.map((pc) => ({ start: Number(pc.start.toFixed(2)), end: Number(pc.end.toFixed(2)), mode: pc.mode })) }, "framing requested");
  const needsFaces = timeline.some((pc) => pc.mode === "auto" || pc.mode === "face" || pc.mode === "split" || pc.mode === "stack");
  const transcriptMeta = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId), columns: { sceneCuts: true, overlays: true, textProfile: true } });
  // burned-in captions / watermarks: keep them out of speaker crops, blur whatever is still visible
  // presentations (slide decks, screen shares) keep their text unless the user asked to hide it anyway
  let overlays: SourceOverlay[] = masksSourceText(settings.sourceText, transcriptMeta?.textProfile) ? (transcriptMeta?.overlays ?? []) : [];
  // per-clip text scan: grows/times burned-in text regions, and finds slides to show whole in auto framing
  const needsTextScan = !!svc.text && (overlays.length > 0 || timeline.some((pc) => pc.mode === "auto"));
  const frames = needsTextScan
    ? await sampleClipText({ detector: svc.text!, ffmpegPath: svc.config.FFMPEG_PATH, signal: ctx.signal }, sourcePath, clip.startSec, duration).catch((err) => {
        log.warn({ err }, "per-clip text scan failed; using project regions");
        return [];
      })
    : [];
  if (overlays.length && svc.text) {
    // the project scan samples the whole video sparsely; this clip may show a longer line or a
    // second line it never saw. Re-detect inside the clip and grow the regions to every box seen.
    const clipBoxes = frames.filter((f) => !f.slide).flatMap((f) => f.boxes);
    const grown = mergeRegions(growOverlays(overlays, clipBoxes, { quantile: 1, pad: 0.008 }));
    // blur only while the text is on screen; regions never seen in this clip are dropped
    const timed = overlayWindows(grown, frames, duration).filter((o) => !o.windows || o.windows.length > 0);
    // and only over the text of each stretch, not the clip-wide extent of the band
    const pieces = tightenOverlays(timed, frames, duration, { cores: overlays });
    log.info({ projectRegions: overlays, clipRegions: timed, pieces: pieces.length, clipBoxes: clipBoxes.length, slides: frames.filter((f) => f.slide).length }, "burned-in text regions");
    overlays = pieces;
  }
  // keep speaker crops clear only of text that is on screen for much of the clip; brief text is just blurred
  let avoid = overlays.filter((o) => (o.share ?? 1) >= 0.5).map((o) => ({ y1: o.y1, y2: o.y2 }));
  // a webcam tile is stored as detected; the pane's nudge moves its window here (and in the editor preview), kept inside the frame.
  // A crop the user fixed is shown as is (`adjustDecision` already dropped the tile and applied a top crop).
  const geoOf = (d: LayoutDecision, adjust?: SectionAdjust): FrameGeometry => ({
    size: d.speakerSizes?.[0] ?? d.faceSize,
    size2: d.speakerSizes?.[1],
    avoid,
    ...(d.content ? { content: d.content } : {}),
    ...(d.tile && !adjust?.crop ? { tile: shiftRegion(d.tile, adjust?.offsetX ?? 0, adjust?.offsetY ?? 0) } : {}),
    ...(adjust?.crop ? { crop: adjust.crop } : {}),
    ...(adjust?.crop2 ? { crop2: adjust.crop2 } : {}),
  });
  // Shot changes, on the clip's clock: from the scenes refine step when it ran for this project, else
  // detected on the clip itself (one 320 px decode of the clip, seconds next to the render). The layout
  // needs them whatever the project opted into: without cuts a multi-camera source holds a layout
  // across edits and pans inside a shot (a split pane on an empty seat, the crop sliding to another
  // person) instead of segmenting per shot and snapping at the cut.
  const cutsFrom: "project" | "clip" | "none" = transcriptMeta?.sceneCuts ? "project" : needsFaces && svc.faces ? "clip" : "none";
  const sceneCuts =
    cutsFrom === "clip"
      ? (await svc.media.detectScenes(sourcePath, undefined, ctx.signal, { start: clip.startSec, duration }).catch((err: unknown) => {
          if (ctx.signal.aborted) throw err;
          log.warn({ err }, "shot changes of the clip not detected, rendering without cuts");
          return [] as number[];
        })).filter((c) => c > 0 && c < duration)
      : (transcriptMeta?.sceneCuts ?? []).map((c) => c - clip.startSec).filter((c) => c > 0 && c < duration);
  let samples: FaceSample[] = [];
  if (svc.faces && needsFaces) {
    await ctx.progress(0.02, `Detecting faces for clip ${clip.index + 1}`, { clipId });
    samples = await sampleFaces(svc.faces, { ffmpegPath: svc.config.FFMPEG_PATH, source: sourcePath, startSec: clip.startSec, durationSec: duration, signal: ctx.signal, sampleFps: 4, srcAspect: srcW / srcH });
    const filtered = dropStaticFaces(samples);
    if (filtered.dropped.length) log.info({ dropped: filtered.dropped }, "ignoring static faces (posters/photos)");
    // text boxes seen by the per-clip scan (one pass, no extra decode) tell a content region beside the speaker from a plain talking head
    samples = attachText(filtered.samples, frames.map((f) => ({ t: f.t, all: f.all })));
  }
  // never blur a face: a region that keeps landing on one (while it is "on") is trimmed back to where
  // the faces end (captions under a close-up's chin), or dropped as scene texture
  if (overlays.length && samples.length) {
    const active = (o: SourceOverlay, t: number) => !o.windows || o.windows.some(([a, b]) => t >= a && t <= b);
    const { kept, dropped, trimmed } = dropFaceOverlaps(overlays, samples.map((sm) => ({ t: sm.t, faces: sm.boxes })), { active });
    if (trimmed.length) log.info({ trimmed: trimmed.map((x) => ({ windows: x.to.windows, y1: [x.from.y1, x.to.y1], y2: [x.from.y2, x.to.y2] })) }, "text regions trimmed clear of faces");
    if (dropped.length) log.info({ dropped }, "text regions over faces dropped");
    if (trimmed.length || dropped.length) {
      overlays = kept;
      avoid = overlays.filter((o) => (o.share ?? 1) >= 0.5).map((o) => ({ y1: o.y1, y2: o.y2 }));
    }
  }
  // a single-segment clip in "none" keeps its aspect; anything mixed is 9:16 so pieces can be concatenated
  // clip audio once (16 kHz mono): speaker detection, pause trimming, caption alignment
  let clipAudio: Float32Array | null = null;
  if (svc.vad || svc.aligner) {
    clipAudio = await clipPcm(svc.config.FFMPEG_PATH, sourcePath, clip.startSec, duration, ctx.signal).catch((err) => {
      if (ctx.signal.aborted) throw err;
      log.warn({ err }, "could not extract clip audio; no speaker detection, pause trimming or caption alignment");
      return null;
    });
  }
  const speechProbs = svc.vad && clipAudio ? await svc.vad.probabilities(clipAudio) : null;
  const layoutDiag = newLayoutDiag();
  let segments = resolveSegments(timeline, samples, { ...svc.config, srcAspect: srcW / srcH }, sceneCuts, !!svc.faces, layoutDiag);
  // what the content-region logic saw: one summary at debug; the per-frame vote at trace (module render)
  log.debug(
    { samples: samples.length, firstSample: sampleDigest(samples[0]), lastSample: sampleDigest(samples.at(-1)), frames: layoutDiag.frames, voting: layoutDiag.voting, textFrames: frames.length, samplesWithText: samples.filter((sm) => sm.text).length, candidates: layoutDiag.candidates, decisions: layoutDiag.decisions },
    "content runs",
  );
  for (const sm of samples) log.trace(voteTrace(sm), "content vote");
  // two people on screen: follow whoever is talking when detection is confident, otherwise keep the
  // split. No setting: a section forced to Split in the editor (manual) is always left alone.
  if (svc.faces && speechProbs && segments.some((sg) => sg.decision.layout === "split" && !sg.manual)) {
    const expanded: typeof segments = [];
    for (const sg of segments) {
      if (sg.decision.layout !== "split" || sg.manual || !sg.decision.track2?.length || sg.end - sg.start < 3) {
        expanded.push(sg);
        continue;
      }
      try {
        const a = trackCenter(sg.decision.track).x;
        const b = trackCenter(sg.decision.track2).x;
        const tl = await activeSpeakers({ faces: svc.faces, ffmpegPath: svc.config.FFMPEG_PATH, signal: ctx.signal }, sourcePath, clip.startSec + sg.start, sg.end - sg.start, [a, b], speechAt(speechProbs, sg.start), envelopeAt(clipAudio!, sg.start));
        const confident = tl.confidence >= 0.5;
        log.info({ segment: [sg.start, sg.end], confidence: tl.confidence, runs: tl.runs, used: confident && tl.runs.length > 0 }, "active speaker detection");
        if (!confident || !tl.runs.length) {
          expanded.push(sg);
          continue;
        }
        for (const r of tl.runs) {
          const tr = r.who === 0 ? sg.decision.track : sg.decision.track2;
          // keeps the section's adjustments (the tracks already carry them), so the editor can take them back out
          expanded.push({
            ...sg,
            start: sg.start + r.start,
            end: sg.start + r.end,
            manual: false,
            decision: { ...sg.decision, layout: "face", track: tr, track2: undefined, faceSize: sg.decision.speakerSizes?.[r.who] ?? sg.decision.faceSize, reason: `active speaker ${r.who === 0 ? "left" : "right"} (confidence ${tl.confidence})` },
          });
        }
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        log.warn({ err }, "active speaker detection failed; keeping split");
        expanded.push(sg);
      }
    }
    segments = expanded;
  }
  // slides and documents in auto sections are shown whole: cropping a 16:9 slide to 9:16 cuts the text
  const textRuns = textHeavyRuns(frames, 2, duration, sceneCuts);
  if (textRuns.length) {
    segments = fitTextHeavy(segments, textRuns);
    log.info({ textRuns }, "text-heavy spans shown whole");
  }
  if (segments.length > 1) segments = segments.map((sg) => (sg.decision.layout === "none" ? { ...sg, decision: { ...sg.decision, layout: "fit" as const } } : sg));
  const first = segments[0]!;
  const summary = segments.map((sg) => `${sg.decision.layout}${sg.manual ? "*" : ""} ${sg.start.toFixed(0)}–${sg.end.toFixed(0)}s`).join(", ");
  log.info({ layout: summary, reason: first.decision.reason, facesPerFrame: first.decision.faceCount, sceneCuts: { n: sceneCuts.length, from: cutsFrom } }, "layout resolved");
  log.debug({ sections: segments.map((sg) => ({ start: Number(sg.start.toFixed(2)), end: Number(sg.end.toFixed(2)), layout: sg.decision.layout, manual: sg.manual, reason: sg.decision.reason, faces: sg.decision.faceCount, ...(sg.decision.contentSignals ? { contentRegion: sg.decision.contentSignals } : {}), ...(sg.decision.tile ? { tile: sg.decision.tile } : {}) })), faceSamples: samples.length, sceneCuts: sceneCuts.length }, "layout per section");
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
      ...(sg.decision.track2 && sg.decision.track2.length > 1 ? { track2: sparseTrack(sg.decision.track2, sg.start, sg.end, clip.startSec) } : {}),
      ...(sg.adjust?.offsetX ? { offsetX: sg.adjust.offsetX } : {}),
      ...(sg.adjust?.offsetY ? { offsetY: sg.adjust.offsetY } : {}),
      ...(sg.adjust?.offsetX2 ? { offsetX2: sg.adjust.offsetX2 } : {}),
      ...(sg.adjust?.offsetY2 ? { offsetY2: sg.adjust.offsetY2 } : {}),
      ...(sg.subject ? { subject: sg.subject } : {}),
      ...(sg.subject2 ? { subject2: sg.subject2 } : {}),
      ...(sg.adjust?.subjectX !== undefined ? { subjectX: sg.adjust.subjectX } : {}),
      ...(sg.adjust?.subjectX2 !== undefined ? { subjectX2: sg.adjust.subjectX2 } : {}),
      ...(sg.decision.layout === "stack" && sg.decision.content ? { content: sg.decision.content } : {}),
      ...(sg.decision.layout === "stack" && sg.decision.tile ? { tile: sg.decision.tile } : {}),
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
  const { chain, width, height } = layoutFilter(first.decision.layout, srcW, srcH, first.decision.track, first.decision.track2 ?? [], geoOf(first.decision, first.adjust));

  const transcript = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, projectId) });
  // optional jump cuts for accepted disfluencies; everything downstream works in post-cut time
  // accepted disfluencies are always cut (jump cuts verified per seam; unverifiable cuts are skipped)
  const cutResult = await planClipCuts(svc, { startSec: clip.startSec, endSec: clip.endSec }, transcript ?? null, sourcePath, ctx.signal, log, (i, n, attempt) =>
    void ctx.progress(0.05, `Verifying disfluency cut ${i + 1}/${n}${attempt > 1 ? ` (try ${attempt})` : ""}`, { clipId }).catch(() => {}),
  );
  for (const sk of cutResult.skipped) log.warn({ span: [sk.range.start, sk.range.end], reason: sk.reason }, "disfluency cut skipped");
  for (const c of cutResult.cuts) log.debug({ cut: [c.start, c.end], verified: c.verified, manual: c.manual ?? false }, "disfluency cut");
  for (const c of cutResult.cuts.filter((x) => !x.verified && x.manual)) {
    await svc.events.emit(projectId, "clip.cut_unverified", { clipId, at: Number((c.start + clip.startSec).toFixed(2)), reason: (c.reason ?? "").slice(0, 1500) }).catch(() => {});
  }
  // long pauses: shortened with jump cuts (VAD on the clip audio), merged with the disfluency cuts
  let pauseInfo: ClipDiagnostics["pauses"];
  let cuts: CutRange[] = cutResult.cuts;
  const maxPause = settings.pauses === "off" ? 0 : settings.pauses === "tight" ? 0.35 : 0.6;
  if (speechProbs && maxPause > 0) {
    try {
      const segs = speechSegments(speechProbs);
      const silence = pauseCuts(segs, duration, { maxPause });
      cuts = mergeRanges([...cuts, ...silence]);
      pauseInfo = { cuts: silence.length, removedSec: Number(silence.reduce((n, c) => n + c.end - c.start, 0).toFixed(2)), maxPause };
      if (silence.length) log.info(pauseInfo, "trimming pauses");
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      log.warn({ err }, "pause detection failed; keeping pauses");
    }
  }
  const plan = cutPlan(duration, cuts);
  const outDuration = cuts.length ? plan.newDuration : duration;
  let clipWordsRel = (transcript?.words ?? [])
    .filter((w) => w.end > clip.startSec && w.start < clip.endSec)
    .map((w) => ({ text: w.text, start: Math.max(0, w.start - clip.startSec), end: Math.min(duration, w.end - clip.startSec) }));
  let captionTiming: ClipDiagnostics["captionTiming"];
  if (svc.aligner && clipAudio && clipWordsRel.length) {
    // karaoke highlights follow the audio: force-align the as-heard words (fillers included, they're
    // in the audio) and give each caption word the timing of the heard word it came from
    try {
      const t0 = Date.now();
      const heard = (transcript?.rawWords ?? transcript?.words ?? [])
        .filter((w) => w.end > clip.startSec && w.start < clip.endSec)
        .map((w) => ({ text: w.text, start: Math.max(0, w.start - clip.startSec), end: Math.min(duration, w.end - clip.startSec) }));
      const res = await alignWordTimes(svc.aligner, clipAudio, heard, { language: transcript?.language });
      const norm = normalizeToken;
      // match caption words to heard words one-to-one and in order: a repeated word ("or … or")
      // must not reuse an earlier occurrence's timing, or lines go back in time and overlap
      let cursor = 0;
      const match = clipWordsRel.map((w) => {
        for (let k = cursor; k < heard.length && heard[k]!.start - w.start < 0.6; k++) {
          if (Math.abs(heard[k]!.start - w.start) < 0.6 && norm(heard[k]!.text) === norm(w.text)) {
            cursor = k + 1;
            return k;
          }
        }
        return -1;
      });
      const used = match.filter((k) => k >= 0).length;
      // unmatched words (corrected names, …) move with their nearest matched neighbour instead of
      // keeping transcript timing between aligned neighbours
      const shiftAt = (i: number) => (match[i]! >= 0 ? res.words[match[i]!]!.start - heard[match[i]!]!.start : undefined);
      const nearestShift = (i: number) => {
        for (let d = 1; d < match.length; d++) {
          const s = shiftAt(i - d) ?? shiftAt(i + d);
          if (s !== undefined) return s;
        }
        return 0;
      };
      clipWordsRel = clipWordsRel.map((w, i) => {
        const k = match[i]!;
        if (k >= 0) return { ...w, start: res.words[k]!.start, end: res.words[k]!.end };
        const s = nearestShift(i);
        return { ...w, start: Math.max(0, w.start + s), end: Math.max(0, w.end + s) };
      });
      captionTiming = { aligned: used, total: clipWordsRel.length, medianShiftMs: res.medianShiftMs, ms: Date.now() - t0 };
      log.info(captionTiming, "caption words aligned to audio");
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      log.warn({ err }, "caption alignment failed; using transcript timings");
    }
  }
  const words = clipWordsRel
    .filter((w) => !cuts.some((c) => w.start >= c.start - 0.001 && w.end <= c.end + 0.001))
    .map((w) => ({ text: w.text, start: plan.mapTime(w.start), end: Math.max(plan.mapTime(w.start) + 0.05, plan.mapTime(w.end)) }));
  if (cuts.length) log.info({ cuts: cuts.length, inSec: Number(duration.toFixed(2)), outSec: Number(outDuration.toFixed(2)) }, "applying jump cuts");
  // decided at render time from the owner's plan and the admin's choice, never frozen into the project: a
  // re-render after an upgrade drops it
  const owner = await db.query.user.findFirst({ where: eq(schema.user.id, project.userId), columns: { id: true, role: true } });
  const watermark = owner ? await watermarkFor(db, svc.settings.get(), owner, svc.entitlements) : { on: false, text: "", source: "instance" as const };
  // the logo above the text: composited like an overlay for the whole body; a missing file leaves the text alone
  const logo: LoadedOverlay[] = watermark.on ? await watermarkLogo(svc.config.WATERMARK_LOGO_PATH, outDuration, log) : [];
  if (watermark.on) log.debug({ source: watermark.source, logo: logo.length > 0 }, "watermark on");
  // the clip's layers whatever generation of row it is: text goes into the caption file, assets are composited, audio is mixed
  const layers = clipLayers(clip);
  const visualLayerCount = layers.filter((l) => l.kind !== "audio").length;
  const audioLayerCount = layers.length - visualLayerCount;
  const assPath = path.join(clipsDir, `${clip.id}.ass`);
  const style = resolveStyle(settings, clip.style);
  // split / stack stretches on the body's post-cut clock: captions there sit on the line between the panes
  const seams = mergeSeamRuns(segments.map((sg) => ({ start: plan.mapTime(sg.start), end: plan.mapTime(sg.end), y: layoutSeamY(sg.decision.layout, sg.decision.content, srcW, srcH) })));
  await fs.writeFile(
    assPath,
    buildAss(words, { width, height, font: svc.config.CAPTION_FONT, style, seams, hook: clip.hook, emphasis: clip.emphasis ?? [], texts: textOverlayEvents(layers.filter((l): l is TextLayer => l.kind === "text"), clip.startSec, duration, plan.mapTime), ...(watermark.on ? { watermark: watermark.text, watermarkUnderLogo: logo.length > 0 } : {}) }),
    "utf8",
  );

  const tmpOut = `${outPath}.tmp.mp4`;
  // intro/outro from the project's settings; an unusable one is skipped, never fatal
  // the clip's own choice per slot, else the project's
  const chosen = resolveClipBumpers(settings, clip);
  const bumpers = await loadBumpers(ctx, project.userId, { intro: chosen.introId, outro: chosen.outroId }, { intro: chosen.introSec, outro: chosen.outroSec }, clip.id, log);
  // overlays (logos, stickers, b-roll) from the library, in post-cut body time; an unusable one is skipped
  const overlayItems = await loadOverlays(ctx, project.userId, layers.filter((l): l is AssetLayer => l.kind === "asset"), clip.startSec, duration, plan.mapTime, clip.id, log);
  // background music from the library, mixed under the speech (ducked); an unusable track is skipped like an overlay
  const music = await loadMusic(ctx, project.userId, layers.filter((l): l is AudioLayer => l.kind === "audio"), clip.startSec, duration, plan.mapTime, clip.id, log);
  const srcHasAudio = bumpers.intro || bumpers.outro || music.length ? (await svc.media.ffprobe(sourcePath)).hasAudio : true;
  // with cuts: trim the kept segments and concat them first, then layout + captions run on the result
  const buildGraph = (withBumpers: boolean, withOverlays: boolean): { graph: string; audioMap: string[] } => {
  const vOut = withBumpers ? "[bodyraw]" : "[v]";
  let graph: string;
  let audioMap: string[];
  const hasCutBranch = segments.length > 1 || cuts.length > 0;
  // overlays sit between the framed body and the captions, so captions stay readable over a logo or b-roll;
  // the watermark logo is the last of them (ffmpeg inputs 1..n, in this order), then the music input
  const composited = [...(withOverlays ? overlayItems.items : []), ...logo];
  const withMusic = withOverlays && music.length > 0;
  const captioned = (inLabel: string) => {
    if (!composited.length) return `${inLabel}ass='${escapeFilterPath(assPath)}'${vOut}`;
    const o = overlayChain(composited, 1, OUT_W, OUT_H, inLabel);
    return `${o.chain}${o.out}ass='${escapeFilterPath(assPath)}'${vOut}`;
  };
  const ovl = composited.length > 0;
  const nOverlayInputs = composited.length;
  if (hasCutBranch) {
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
      const chainI = suffixLabels(layoutFilter(d.layout === "none" ? "fit" : d.layout, srcW, srcH, localTrack(d.track, pc.start, pc.end), d.track2 ? localTrack(d.track2, pc.start, pc.end) : [], geoOf(d, pc.seg.adjust)).chain, `s${i}`, `[t${i}]`);
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
    graph = `${src.prefix}${parts.join(";")};${vInputs}concat=n=${pieces.length}:v=1:a=0[cv];${audio};${captioned("[cv]")}`;
    audioMap = ["-map", "[ca]"];
  } else {
    const src = sourceVideo(overlays, srcW, srcH, 1);
    graph = ovl ? `${src.prefix}${chain.replace("[0:v]", src.labels[0]!)}[body];${captioned("[body]")}` : `${src.prefix}${chain.replace("[0:v]", src.labels[0]!)},ass='${escapeFilterPath(assPath)}'${vOut}`;
    audioMap = ["-map", "0:a:0?"];
  }
  // the body's audio as one labelled stream when something has to be mixed in or joined after it
  let bodyAudio = hasCutBranch ? "[ca]" : "0:a:0?";
  if ((withBumpers || withMusic) && !hasCutBranch) {
    // concat / amix need audio in every slot: the no-cuts branch has optional audio, so give it a guaranteed [ca]
    graph += `;${srcHasAudio ? "[0:a:0]anull[ca]" : `anullsrc=r=48000:cl=stereo,atrim=end=${duration.toFixed(3)}[ca]`}`;
    bodyAudio = "[ca]";
  }
  if (withMusic) {
    graph += `;${musicMix(music, 1 + nOverlayInputs, bodyAudio, outDuration)}`;
    bodyAudio = "[mixed]";
    audioMap = ["-map", bodyAudio];
  }
  if (withBumpers) {
    // the burned-in captions are on the body's own timeline, so the intro never shifts them
    // ffmpeg inputs: 0 = source, then the overlays (+ logo), then the music tracks, then the intro and outro
    const base = 1 + nOverlayInputs + (withMusic ? music.length : 0);
    const introInput = bumpers.intro ? base : undefined;
    const outroInput = bumpers.outro ? base + (bumpers.intro ? 1 : 0) : undefined;
    graph += `;${bumperConcat({ introInput, outroInput, bodyVideo: "[bodyraw]", bodyAudio, bodySec: outDuration })}`;
    audioMap = ["-map", "[a]"];
  }
  return { graph, audioMap };
  };
  const encodeWith = async (withBumpers: boolean, withOverlays: boolean, encoder: VideoEncoder) => {
  const { graph, audioMap } = buildGraph(withBumpers, withOverlays);
  const introSec = withBumpers && bumpers.intro ? bumpers.intro.sec : 0;
  const outroSec = withBumpers && bumpers.outro ? bumpers.outro.sec : 0;
  await svc.media.ffmpeg(
    [
      "-ss", clip.startSec.toFixed(3), "-t", duration.toFixed(3), "-i", sourcePath,
      ...[...(withOverlays ? overlayItems.items : []), ...logo].flatMap(overlayInputArgs),
      ...(withOverlays ? music.flatMap((m) => [...(m.loop ? ["-stream_loop", "-1"] : []), "-i", m.path]) : []),
      ...(withBumpers && bumpers.intro ? ["-i", bumpers.intro.path] : []),
      ...(withBumpers && bumpers.outro ? ["-i", bumpers.outro.path] : []),
      "-filter_complex", graph,
      "-map", "[v]", ...audioMap,
      ...ffmpegThreadArgs(svc.resources.ffmpegThreads()),
      ...svc.media.videoEncodeArgs(encoder), "-pix_fmt", "yuv420p", "-r", "30",
      "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
      "-movflags", "+faststart", "-f", "mp4", tmpOut,
    ],
    // progress counts the bumper seconds too, or the bar would finish early
    { signal: ctx.signal, onProgress: (sec) => void ctx.progress(sec / (introSec + outDuration + outroSec), `Rendering clip ${clip.index + 1}`, { clipId }).catch(() => {}) },
  );
  return { introSec, outroSec };
  };
  // a hardware encoder can fail where the probe passed (NVENC session limit, VRAM, a driver reset): the
  // clip is then encoded on the CPU rather than failed, and the line says so
  const encode = async (withBumpers: boolean, withOverlays: boolean) => {
    const encoder = svc.media.encoder().name;
    try {
      return await encodeWith(withBumpers, withOverlays, encoder);
    } catch (err) {
      if (encoder === "libx264" || ctx.signal.aborted) throw err;
      log.warn({ err, encoder }, "hardware encoder failed; encoding this clip with libx264");
      return await encodeWith(withBumpers, withOverlays, "libx264");
    }
  };
  let attached: { introSec: number; outroSec: number };
  let usedBumpers = !!(bumpers.intro || bumpers.outro);
  // the "extras" that the first retry drops together: overlays and music
  let usedOverlays = overlayItems.items.length > 0 || music.length > 0;
  try {
    attached = await encode(usedBumpers, usedOverlays);
  } catch (err) {
    if (ctx.signal.aborted || (!usedBumpers && !usedOverlays)) throw err;
    // the extras are the only thing that differs: drop the overlays first, then the bumpers, rather than failing the clip
    if (usedOverlays) {
      log.warn({ err }, "render with overlays failed; rendering without");
      overlayItems.skipped.push("the render with the overlays failed");
      await svc.events.emit(projectId, "clip.overlay_skipped", { clipId, reason: "the overlays could not be composited, so the clip was rendered without them", error: String((err as Error).message).slice(0, 1500) }).catch(() => {});
      usedOverlays = false;
      try {
        attached = await encode(usedBumpers, false);
      } catch (err2) {
        if (ctx.signal.aborted || !usedBumpers) throw err2;
        log.warn({ err: err2 }, "render with intro/outro failed; rendering without");
        bumpers.skipped.push("the render with the intro and outro failed");
        await svc.events.emit(projectId, "clip.bumper_skipped", { clipId, slot: "intro", reason: "the video could not be joined to the clip, so it was rendered without an intro or outro", error: String((err2 as Error).message).slice(0, 1500) }).catch(() => {});
        usedBumpers = false;
        attached = await encode(false, false);
      }
    } else {
      log.warn({ err }, "render with intro/outro failed; rendering without");
      bumpers.skipped.push("the render with the intro and outro failed");
      await svc.events.emit(projectId, "clip.bumper_skipped", { clipId, slot: "intro", reason: "the video could not be joined to the clip, so it was rendered without an intro or outro", error: String((err as Error).message).slice(0, 1500) }).catch(() => {});
      usedBumpers = false;
      attached = await encode(false, false);
    }
  }
  await fs.rename(tmpOut, outPath);
  // the thumbnail is a still of the clip itself, so it is taken after the intro
  await svc.media.ffmpeg(["-ss", (attached.introSec + outDuration / 3).toFixed(2), "-i", outPath, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "3", thumbPath], { signal: ctx.signal });

  const outputKey = keys.clip(projectId, clip.id, gen);
  const thumbnailKey = keys.thumb(projectId, clip.id, gen);
  const outputBytes = (await fs.stat(outPath)).size;
  await svc.storage.putFile(outputKey, outPath, "video/mp4");
  await svc.storage.putFile(thumbnailKey, thumbPath, "image/jpeg");
  if (svc.storage.driver !== "local") await fs.rm(outPath, { force: true }).catch(() => {});

  log.debug({ intro: bumpers.intro?.id ?? null, outro: bumpers.outro?.id ?? null, used: usedBumpers, introSec: attached.introSec, outroSec: attached.outroSec, skipped: bumpers.skipped, fromClip: chosen.fromClip }, "bumpers");
  if (visualLayerCount) log.debug({ requested: visualLayerCount, used: usedOverlays ? overlayItems.items.length : 0, skipped: overlayItems.skipped, items: overlayItems.items.map((o) => ({ id: o.id, asset: o.assetId, kind: o.kind, from: o.start, to: o.end, x: o.x, y: o.y, w: o.w })) }, "overlays");
  if (audioLayerCount) log.debug({ requested: audioLayerCount, used: usedOverlays ? music.length : 0, tracks: music.map((m) => ({ id: m.id, asset: m.assetId, from: m.start, to: m.end, volume: m.volume, duck: m.duck, fade: m.fade, loop: m.loop })) }, "music");
  const diagnostics: ClipDiagnostics = capDiagnostics({
    renderedAt: new Date().toISOString(),
    ...(pauseInfo ? { pauses: pauseInfo } : {}),
    ...(captionTiming ? { captionTiming } : {}),
    ...(visualLayerCount ? { overlays: { used: usedOverlays ? overlayItems.items.length : 0, ...(overlayItems.skipped.length ? { skipped: overlayItems.skipped } : {}) } } : {}),
    layout: summary,
    cuts: {
      applied: cutResult.cuts.map((c) => ({ start: Number((c.start + clip.startSec).toFixed(3)), end: Number((c.end + clip.startSec).toFixed(3)), verified: c.verified, ...(c.reason ? { reason: c.reason.slice(0, 2000) } : {}), ...(c.manual ? { manual: true } : {}) })),
      skipped: cutResult.skipped.map((sk) => ({ start: Number((sk.range.start + clip.startSec).toFixed(3)), end: Number((sk.range.end + clip.startSec).toFixed(3)), reason: sk.reason.slice(0, 2000) })),
    },
    outDurationSec: Number(outDuration.toFixed(2)),
    ...(chosen.introId || chosen.outroId || chosen.fromClip.length
      ? {
          bumpers: {
            ...(usedBumpers && bumpers.intro ? { introId: bumpers.intro.id } : {}),
            ...(usedBumpers && bumpers.outro ? { outroId: bumpers.outro.id } : {}),
            introSec: Number(attached.introSec.toFixed(3)),
            outroSec: Number(attached.outroSec.toFixed(3)),
            ...(bumpers.skipped.length ? { skipped: bumpers.skipped } : {}),
            ...(chosen.fromClip.length ? { fromClip: chosen.fromClip } : {}),
          },
        }
      : {}),
    renderMs: Date.now() - renderStarted,
  });
  // commit only if this is still the clip's current generation; a newer request wins and our files go
  const committed = await svc.tx(async (u) => {
    const [cur] = await u.db.select({ gen: schema.clips.renderGen, outputKey: schema.clips.outputKey, thumbnailKey: schema.clips.thumbnailKey }).from(schema.clips).where(eq(schema.clips.id, clipId)).for("update");
    if (!cur || cur.gen !== gen) return false;
    // the caption lines as burned in, in the video's own seconds, so an SRT / VTT export matches the file
    const captions = renderedCaptions(words, resolveStyle(settings, clip.style), attached.introSec);
    await u.db.update(schema.clips).set({ status: "done", outputKey, outputBytes, thumbnailKey, watermark: watermark.on, error: null, diagnostics, captions, updatedAt: new Date() }).where(eq(schema.clips.id, clipId));
    await u.emit(projectId, "clip.done", { clipId, index: clip.index });
    await finalizeInTx(svc, u, projectId);
    // a previous output of this clip (other generation) is superseded
    for (const k of [cur.outputKey, cur.thumbnailKey]) {
      if (!k || k === outputKey || k === thumbnailKey) continue;
      u.afterCommit(async () => {
        await svc.storage.delete(k);
        await removeScratchClip(svc, projectId, k);
      });
    }
    return true;
  });
  if (!committed) {
    log.info({ gen }, "render finished for a superseded version; discarding its output");
    await svc.storage.delete(outputKey).catch(() => {});
    await svc.storage.delete(thumbnailKey).catch(() => {});
    await fs.rm(outPath, { force: true }).catch(() => {});
    await fs.rm(thumbPath, { force: true }).catch(() => {});
  }
}

interface LoadedBumper {
  id: string;
  path: string;
  sec: number;
}

/**
 * The project's intro/outro as normalised local files. Soft-deleted assets still resolve (projects
 * that snapshotted the id keep working); a missing, foreign or unreadable one is skipped with a
 * plain-language event so the clip renders without it instead of failing.
 */
async function loadBumpers(ctx: StageContext, userId: string, ids: { intro: string | null; outro: string | null }, secs: { intro?: number; outro?: number }, clipId: string, log: Logger) {
  const { svc, projectId, db } = ctx;
  const out: { intro?: LoadedBumper; outro?: LoadedBumper; skipped: string[] } = { skipped: [] };
  for (const slot of ["intro", "outro"] as const) {
    const id = ids[slot];
    if (!id) continue;
    const skip = async (reason: string, error?: unknown) => {
      out.skipped.push(`${slot}: ${reason}`);
      log.warn({ slot, assetId: id, err: error }, "bumper skipped");
      await svc.events.emit(projectId, "clip.bumper_skipped", { clipId, slot, reason, ...(error ? { error: String((error as Error).message ?? error).slice(0, 1500) } : {}) }).catch(() => {});
    };
    const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, id) });
    if (!asset || (asset.userId !== null && asset.userId !== userId)) {
      await skip(`the ${slot} file is no longer available`);
      continue;
    }
    try {
      // an image lasts as long as this clip or project says, else its own default; a video keeps its length
      const used = asset.kind === "image" && secs[slot] ? { ...asset, durationSec: secs[slot]! } : asset;
      const file = await ensureNormalised(
        { ffmpeg: (args, o) => svc.media.ffmpeg(args, o), encodeArgs: svc.media.videoEncodeArgs(), log: ctx.log, storage: svc.storage, dir: path.join(svc.paths.root, "bumpers") },
        used,
        { width: OUT_W, height: OUT_H, fitChain: FIT_CHAIN(OUT_W, OUT_H) },
        ctx.signal,
      );
      out[slot] = { id, path: file, sec: bumperFrames(used.durationSec) / BUMPER_FPS };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      await skip(`the ${slot} file could not be read`, err);
    }
  }
  return out;
}

/** An overlay ready for the filter graph: a local file and its window in post-cut body seconds. */
export interface LoadedOverlay {
  id: string;
  assetId: string;
  path: string;
  kind: "video" | "image" | "audio";
  /** repeat while the window is open (a GIF, an animated WebP, or a video the layer asked to loop); never set on a still */
  loop: boolean;
  /** the file is a GIF: ffmpeg must be told to honour its own loop flag */
  gif?: boolean;
  /** the file's own length, seconds (sizes a finite `-stream_loop`) */
  durationSec?: number;
  /** body seconds (after cuts) */
  start: number;
  end: number;
  x: number;
  y: number;
  w: number;
  opacity: number;
}

/**
 * The clip's overlays as local library files with their windows mapped from source seconds to the
 * body's post-cut clock. A missing, foreign or unreadable asset, or a window the cuts removed, is
 * skipped with a plain-language event; the clip renders without it rather than failing.
 */
async function loadOverlays(ctx: StageContext, userId: string, overlays: AssetLayer[], clipStart: number, duration: number, mapTime: (t: number) => number, clipId: string, log: Logger): Promise<{ items: LoadedOverlay[]; skipped: string[] }> {
  const { svc, projectId, db } = ctx;
  const out: { items: LoadedOverlay[]; skipped: string[] } = { items: [], skipped: [] };
  for (const o of overlays) {
    const skip = async (reason: string, error?: unknown) => {
      out.skipped.push(`${o.id}: ${reason}`);
      log.warn({ overlayId: o.id, assetId: o.assetId, err: error }, "overlay skipped");
      await svc.events.emit(projectId, "clip.overlay_skipped", { clipId, overlayId: o.id, reason, ...(error ? { error: String((error as Error).message ?? error).slice(0, 1500) } : {}) }).catch(() => {});
    };
    const a = Math.max(0, o.start - clipStart);
    const b = Math.min(duration, o.end - clipStart);
    if (b - a < 0.05) continue; // outside the clip after a retrim: nothing to show, nothing to say
    const start = mapTime(a);
    const end = mapTime(b);
    if (end - start < 0.05) {
      await skip("its whole time range was removed by cuts");
      continue;
    }
    const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, o.assetId) });
    if (!asset || (asset.userId !== null && asset.userId !== userId)) {
      await skip("the library file is no longer available");
      continue;
    }
    if (asset.kind === "audio") {
      await skip("that library item is an audio file, not a picture or video");
      continue;
    }
    try {
      const dir = path.join(svc.paths.root, "bumpers", asset.id);
      await fs.mkdir(dir, { recursive: true });
      // an SVG is composited from its PNG (resvg), rendered once at the output width and cached
      const file = isSvgAsset(asset) ? await ensureRaster({ storage: svc.storage, dir: path.join(svc.paths.root, "bumpers") }, asset, RASTER_WIDTH) : await svc.storage.ensureLocal(asset.sourceKey, path.join(dir, path.posix.basename(asset.sourceKey)));
      // only something that moves can loop: a GIF / silent short video (Giphy) by default, a longer video when the layer says so
      const loop = asset.kind === "video" && (o.loop ?? isStickerAsset(asset));
      out.items.push({ id: o.id, assetId: o.assetId, path: file, kind: asset.kind, loop, ...(loop ? { gif: asset.mime === "image/gif", durationSec: asset.durationSec } : {}), start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), x: o.x, y: o.y, w: o.w ?? ASSET_OVERLAY_DEFAULT_W, opacity: o.opacity ?? 1 });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      await skip("the library file could not be read", err);
    }
  }
  return out;
}

/**
 * The watermark logo as an overlay item for the whole body (bottom centre, above the platform UI
 * zone, the "reelsaw.com" line goes right under it in the caption file). An unreadable file is
 * logged and skipped: the text watermark still renders.
 */
export async function watermarkLogo(file: string, bodySec: number, log: Logger): Promise<LoadedOverlay[]> {
  try {
    await fs.access(file);
  } catch (err) {
    log.warn({ err, file }, "watermark logo not readable; text watermark only");
    return [];
  }
  return [{ id: "watermark", assetId: "", path: file, kind: "image", loop: false, start: 0, end: Number((bodySec + 1).toFixed(3)), x: WATERMARK_LOGO.x, y: WATERMARK_LOGO.y, w: WATERMARK_LOGO.w, opacity: WATERMARK_LOGO.opacity }];
}

/** Background music ready for the graph: a local file and its window in post-cut body seconds. */
export interface LoadedMusic {
  id: string;
  assetId: string;
  path: string;
  /** body seconds (after cuts) */
  start: number;
  end: number;
  /** seconds into the track to start from */
  offset: number;
  volume: number;
  duck: boolean;
  fade: number;
  loop: boolean;
}

/**
 * The clip's music as a local library file with its window mapped from source seconds to the body's
 * post-cut clock. Defaults from CLIP_AUDIO_DEFAULTS. A missing or foreign asset, or a window the cuts
 * removed, is skipped with a plain-language event; the clip renders without music rather than failing.
 */
async function loadMusic(ctx: StageContext, userId: string, tracks: Array<ClipAudio>, clipStart: number, duration: number, mapTime: (t: number) => number, clipId: string, log: Logger): Promise<LoadedMusic[]> {
  const { svc, projectId, db } = ctx;
  const out: LoadedMusic[] = [];
  for (const audio of tracks) {
    const skip = async (reason: string, error?: unknown) => {
      log.warn({ trackId: audio.id, assetId: audio.assetId, err: error }, "music skipped");
      await svc.events.emit(projectId, "clip.overlay_skipped", { clipId, overlayId: audio.id, reason, ...(error ? { error: String((error as Error).message ?? error).slice(0, 1500) } : {}) }).catch(() => {});
    };
    const a = Math.max(0, audio.start - clipStart);
    const b = Math.min(duration, audio.end - clipStart);
    if (b - a < 0.5) continue; // outside the clip after a retrim: nothing to play
    const start = mapTime(a);
    const end = mapTime(b);
    if (end - start < 0.5) {
      await skip("the music's whole time range was removed by cuts");
      continue;
    }
    const asset = await db.query.assets.findFirst({ where: eq(schema.assets.id, audio.assetId) });
    if (!asset || (asset.userId !== null && asset.userId !== userId)) {
      await skip("the music file is no longer in the library");
      continue;
    }
    if (asset.kind !== "audio") {
      await skip("that library item is not an audio file");
      continue;
    }
    try {
      const dir = path.join(svc.paths.root, "bumpers", asset.id);
      await fs.mkdir(dir, { recursive: true });
      const file = await svc.storage.ensureLocal(asset.sourceKey, path.join(dir, path.posix.basename(asset.sourceKey)));
      out.push({ id: audio.id, assetId: asset.id, path: file, start: Number(start.toFixed(3)), end: Number(end.toFixed(3)), offset: audio.offset ?? 0, volume: audio.volume ?? CLIP_AUDIO_DEFAULTS.volume, duck: audio.duck ?? CLIP_AUDIO_DEFAULTS.duck, fade: audio.fade ?? CLIP_AUDIO_DEFAULTS.fade, loop: audio.loop ?? CLIP_AUDIO_DEFAULTS.loop });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      await skip("the music file could not be read", err);
    }
  }
  return out;
}

const AFMT = "aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp";
/** music beds are normalised to −20 LUFS (one pass is enough for a bed) before the track's own level */
const MUSIC_LOUDNORM = "loudnorm=I=-20:TP=-2:LRA=11";

/**
 * Filter-graph segment that mixes music tracks under the body's speech. Each track is trimmed to its
 * window (offset in, looped by the input when asked), faded at both ends, set to its level, delayed to
 * its start and padded to the body. Tracks that duck are summed and compressed by the speech (sidechain:
 * roughly 10 dB down while someone talks, back within half a second); tracks that don't are summed as
 * they are. Everything is mixed without amix's level drop. Inputs start at `firstInput`, in track order.
 * Emits `[mixed]`.
 */
export function musicMix(tracks: LoadedMusic[], firstInput: number, bodyAudio: string, bodySec: number): string {
  const parts: string[] = [];
  const ducked: string[] = [];
  const plain: string[] = [];
  tracks.forEach((m, i) => {
    const len = Math.max(0.1, m.end - m.start);
    const fade = Math.min(m.fade, len / 2);
    const fades = fade > 0 ? `,afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${Math.max(0, len - fade).toFixed(3)}:d=${fade.toFixed(3)}` : "";
    const delay = Math.round(m.start * 1000);
    const label = `[mu${i}]`;
    // loudnorm first: every track sits at −20 LUFS before its level, so "60%" means the same for a quiet file and a loud one
    parts.push(`[${firstInput + i}:a]atrim=start=${m.offset.toFixed(3)}:end=${(m.offset + len).toFixed(3)},asetpts=PTS-STARTPTS,${AFMT},${MUSIC_LOUDNORM}${fades},volume=${m.volume.toFixed(3)},adelay=${delay}|${delay},apad=whole_dur=${bodySec.toFixed(3)},atrim=end=${bodySec.toFixed(3)}${label}`);
    (m.duck ? ducked : plain).push(label);
  });
  // sum each group to one stream (a single track just passes through under the group's label)
  const sum = (labels: string[], out: string) => (labels.length === 1 ? `${labels[0]}anull${out}` : `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0${out}`);
  const mixIn: string[] = ["[speech]"];
  if (ducked.length && plain.length) parts.push(`${bodyAudio}${AFMT},asplit=2[speech][key]`);
  else if (ducked.length) parts.push(`${bodyAudio}${AFMT},asplit=2[speech][key]`);
  else parts.push(`${bodyAudio}${AFMT}[speech]`);
  if (ducked.length) {
    parts.push(sum(ducked, "[musicd]"));
    // threshold 0.02 (≈ −34 dBFS) under conversational speech (≈ −26 dB) at ratio 6: about 6 dB down while someone
    // talks, a bed rather than silence; the short pauses between words let it back up only a little (release 400 ms)
    parts.push(`[musicd][key]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=400:knee=2:makeup=1[ducked]`);
    mixIn.push("[ducked]");
  }
  if (plain.length) {
    parts.push(sum(plain, "[musicp]"));
    mixIn.push("[musicp]");
  }
  parts.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:duration=first:normalize=0[mixed]`);
  return parts.join(";");
}

/** The clip's text overlays as caption-file events, windows mapped from source seconds to the body's post-cut clock. */
export function textOverlayEvents(overlays: Array<ClipOverlay | TextLayer>, clipStart: number, duration: number, mapTime: (t: number) => number): TextOverlayEvent[] {
  const out: TextOverlayEvent[] = [];
  for (const o of overlays) {
    if (overlayKind(o) !== "text" || !o.text) continue;
    const a = Math.max(0, o.start - clipStart);
    const b = Math.min(duration, o.end - clipStart);
    if (b - a < 0.05) continue;
    const start = mapTime(a);
    const end = mapTime(b);
    if (end - start < 0.05) continue;
    out.push({ text: o.text, start, end, x: o.x, y: o.y, size: o.size ?? TEXT_OVERLAY_DEFAULTS.size, color: o.color ?? TEXT_OVERLAY_DEFAULTS.color, box: !!o.box, opacity: o.opacity ?? 1, ...(o.font ? { font: o.font } : {}) });
  }
  return out;
}

/** Most extra loops of a repeating input; the window is a clip, so this is never reached in practice. */
const MAX_INPUT_LOOPS = 1000;

/**
 * ffmpeg input arguments for one overlay file. A looped input is always finite: `-stream_loop` gets the
 * number of extra plays that cover the window (never -1, an endless input can keep the encode alive) and
 * `-t` cuts it at the window's length. A GIF also gets `-ignore_loop 0` so its own loop flag is honoured.
 */
export function overlayInputArgs(o: Pick<LoadedOverlay, "path" | "loop" | "gif" | "durationSec" | "start" | "end">): string[] {
  if (!o.loop) return ["-i", o.path];
  const windowSec = Math.max(0.05, o.end - o.start);
  const extra = o.durationSec && o.durationSec > 0 ? Math.min(MAX_INPUT_LOOPS, Math.ceil(windowSec / o.durationSec)) : 0;
  return [...(o.gif ? ["-ignore_loop", "0"] : []), "-stream_loop", String(extra), "-t", windowSec.toFixed(3), "-i", o.path];
}

/**
 * Filter-graph segment that composites overlays over a body stream. The input label is prepended by
 * the caller; the result ends with `out` (a label to continue from). Overlay inputs start at ffmpeg
 * input `firstInput`, in order. A video overlay plays from its own start when its window opens and
 * is left out after it ends (`eof_action=pass`); an image stays for the whole window. Width is a
 * fraction of the output width; the height follows the file.
 */
export function overlayChain(items: LoadedOverlay[], firstInput: number, outW: number, outH: number, inLabel: string): { chain: string; out: string } {
  const parts: string[] = [];
  let prev = inLabel;
  items.forEach((o, i) => {
    const input = firstInput + i;
    const w = Math.max(2, Math.round((o.w * outW) / 2) * 2);
    // a looped input is cut to its window first, so a repeating source cannot run on past the body
    const prep = [o.kind === "video" && o.loop ? `trim=duration=${Math.max(0.05, o.end - o.start).toFixed(3)}` : "", o.kind === "video" ? `setpts=PTS-STARTPTS+${o.start.toFixed(3)}/TB` : "", `scale=${w}:-2`, "format=rgba", o.opacity < 1 ? `colorchannelmixer=aa=${o.opacity.toFixed(3)}` : ""].filter(Boolean).join(",");
    const x = `${Math.round(o.x * outW)}-w/2`;
    const y = `${Math.round(o.y * outH)}-h/2`;
    const eof = o.kind === "video" && !o.loop ? "pass" : "repeat";
    parts.push(`[${input}:v]${prep}[ov${i}]`);
    parts.push(`${prev}[ov${i}]overlay=x=${x}:y=${y}:eof_action=${eof}:enable='between(t,${o.start.toFixed(3)},${o.end.toFixed(3)})'[oc${i}]`);
    prev = `[oc${i}]`;
  });
  return { chain: `${parts.join(";")};`, out: prev };
}

/**
 * Mark a clip failed. `gen`: only while that render generation is current. `ifStatus`: only while the clip is still in
 * that status (a prepare that gives up must not fail a clip a newer prepare or render has taken over).
 */
export async function markClipFailed(svc: Services, projectId: string, clipId: string, err: unknown, gen?: number, o: { ifStatus?: schema.Clip["status"] } = {}) {
  const message = err instanceof Error ? err.message : String(err);
  await svc.tx(async (u) => {
    // a failing stale render must not mark the newer, pending version as failed
    const [cur] = await u.db.select({ gen: schema.clips.renderGen, status: schema.clips.status }).from(schema.clips).where(eq(schema.clips.id, clipId)).for("update");
    if (!cur || (gen !== undefined && cur.gen !== gen) || (o.ifStatus !== undefined && cur.status !== o.ifStatus)) return;
    await u.db.update(schema.clips).set({ status: "failed", error: message.slice(0, 4000), updatedAt: new Date() }).where(eq(schema.clips.id, clipId));
    await u.emit(projectId, "clip.failed", { clipId, error: message.slice(0, 1000) });
    await finalizeInTx(svc, u, projectId);
  });
}

/** Marks a project done once every clip reached a terminal state. Safe to call repeatedly. */
export async function finalizeProjectIfDone(svc: Services, projectId: string) {
  await svc.tx((u) => finalizeInTx(svc, u, projectId));
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
  transcript: Pick<Transcript, "flags" | "rawWords" | "words" | "language"> | null,
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
  const alignModelId = svc.models.get().align;

  const refined = await refineCuts(
    {
      onProgress,
      language: transcript?.language,
      ...(svc.aligner ? { align: (pcm: Float32Array, ws: string[]) => svc.aligner!.align(pcm, ws) } : {}),
      log: log?.child({ module: "cuts" }),
      ffmpegPath: svc.config.FFMPEG_PATH,
      signal,
      transcribe: async (audio) => {
        const res = await svc.asr.transcribe(audio, { modelId: alignModelId, signal });
        return toWords(res.segments);
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
 *
 * Each blurred patch has a soft edge (an alpha ramp `BLUR_FEATHER` wide, outside the padded text box
 * so the text itself is fully covered; none along a frame edge), and a patch with one window fades
 * in before it and out after it (`BLUR_FADE_SEC`), so the blur doesn't switch on and off as a hard box.
 */
export function sourceVideo(overlays: SourceOverlay[], srcW: number, srcH: number, consumers: number): { prefix: string; labels: string[] } {
  if (!overlays.length) return { prefix: "", labels: Array.from({ length: consumers }, () => "[0:v]") };
  const parts: string[] = [];
  let cur = "[0:v]";
  // the mask is a box inset by `f` and blurred with radius f/2 (power 2): it ramps 0 → 1 over ~1.6 f
  // from the patch edge, so a margin of 2 f keeps the padded text box fully opaque
  const f = Math.max(2, Math.round(BLUR_FEATHER * srcH));
  const margin = 2 * f;
  overlays.forEach((o, i) => {
    // pad a little: detector boxes hug the glyphs, glows and outlines extend past them
    const padX = OVERLAY_PAD_X * srcW + margin;
    const padY = OVERLAY_PAD_Y * srcH + margin;
    // even edges: yuv420p crops snap to even sizes, and the mask (gray) must match the patch exactly
    const x = Math.max(0, Math.floor((o.x1 * srcW - padX) / 2) * 2);
    const y = Math.max(0, Math.floor((o.y1 * srcH - padY) / 2) * 2);
    const x2 = Math.min(Math.floor(srcW / 2) * 2, Math.ceil((o.x2 * srcW + padX) / 2) * 2);
    const y2 = Math.min(Math.floor(srcH / 2) * 2, Math.ceil((o.y2 * srcH + padY) / 2) * 2);
    const w = x2 - x;
    const h = y2 - y;
    if (w < 4 || h < 4) return;
    // boxblur caps each plane's radius at half its size; chroma planes are half resolution (yuv420p)
    const r = Math.max(1, Math.min(40, Math.floor(Math.min(w, h) / 2) - 1));
    const rc = Math.max(1, Math.min(r, Math.floor(Math.min(w, h) / 4) - 1));
    // a side on the frame edge is not feathered (the text may run to the edge)
    const [l, t, rr, b] = [x > 0 ? f : 0, y > 0 ? f : 0, x2 < srcW - 1 ? f : 0, y2 < srcH - 1 ? f : 0];
    const feather = w - l - rr >= 4 && h - t - b >= 4 && Math.min(w, h) / 2 > f;
    // one window: fade in just before it and out just after, so the text is fully covered inside it
    const win = o.windows?.length === 1 ? o.windows[0]! : null;
    const fadeIn = win && win[0] > 0.01 ? Math.max(0, win[0] - BLUR_FADE_SEC) : null;
    const fades = win ? `${fadeIn !== null ? `,fade=t=in:st=${fadeIn.toFixed(2)}:d=${BLUR_FADE_SEC}` : ""},fade=t=out:st=${win[1].toFixed(2)}:d=${BLUR_FADE_SEC}` : "";
    const enable = win
      ? `:enable='between(t,${(fadeIn ?? 0).toFixed(2)},${(win[1] + BLUR_FADE_SEC).toFixed(2)})'`
      : o.windows?.length
        ? `:enable='${o.windows.map(([a, bb]) => `between(t,${a},${bb})`).join("+")}'`
        : "";
    const blurred = `[mk${i}b]crop=${w}:${h}:${x}:${y},boxblur=luma_radius=${r}:luma_power=3:chroma_radius=${rc}:chroma_power=3`;
    const patch =
      feather || fades
        ? `${blurred},format=yuva420p,split=2[mk${i}p][mk${i}q];[mk${i}q]alphaextract,lutyuv=y=255${feather ? `,crop=${w - l - rr}:${h - t - b}:${l}:${t},pad=${w}:${h}:${l}:${t}:black,boxblur=${Math.max(1, Math.ceil(f / 2))}:2` : ""}${fades}[mk${i}m];[mk${i}p][mk${i}m]alphamerge[mk${i}c]`
        : `${blurred}[mk${i}c]`;
    parts.push(`${cur}split=2[mk${i}a][mk${i}b];${patch};[mk${i}a][mk${i}c]overlay=${x}:${y}${enable}[mk${i}]`);
    cur = `[mk${i}]`;
  });
  if (!parts.length) return { prefix: "", labels: Array.from({ length: consumers }, () => "[0:v]") };
  const labels = Array.from({ length: consumers }, (_, i) => `[src${i}]`);
  return { prefix: `${parts.join(";")};${cur}split=${consumers}${labels.join("")};`, labels };
}

/** Union of possibly overlapping ranges, sorted. */
export function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = ranges.filter((r) => r.end > r.start).sort((a, b) => a.start - b.start);
  const out: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 0.02) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** 16 kHz mono float PCM of a clip's audio (VAD input). */
function clipPcm(ffmpegPath: string, source: string, start: number, duration: number, signal?: AbortSignal): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", source, "-vn", "-ac", "1", "-ar", String(VAD_SR), "-f", "f32le", "pipe:1"], { signal });
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code} extracting clip audio`));
      const b = Buffer.concat(chunks);
      resolve(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)));
    });
  });
}
