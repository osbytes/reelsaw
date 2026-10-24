/**
 * Layers as stored on a clip: ids unique, windows clamped to the clip and at least 0.1 s (pictures, text) or 0.5 s
 * (sounds), defaults left out, numbers rounded, ordered by start. `clips.update`, the layer-template apply and the
 * CLI all write through `cleanLayers`, so one rule decides what a stored layer looks like.
 */
import { TRPCError } from "@trpc/server";
import { ASSET_OVERLAY_DEFAULT_W, CLIP_AUDIO_DEFAULTS, MAX_CLIP_LAYERS, TEXT_FONTS, TEXT_OVERLAY_DEFAULTS, layersToLegacy, overlayKind, type ClipAudio, type ClipLayer, type ClipOverlay } from "@reelsaw/shared";

type ClipRange = { startSec: number; endSec: number };

/** Overlays as stored: ordered by start, ids unique, windows at least 0.1 s, numbers rounded. */
export function cleanOverlays(list: ClipOverlay[] | null | undefined, clip: ClipRange): ClipOverlay[] | null {
  if (!list?.length) return null;
  const seen = new Set<string>();
  const out: ClipOverlay[] = [];
  for (const o of list) {
    if (seen.has(o.id)) throw new TRPCError({ code: "BAD_REQUEST", message: `Overlay id “${o.id}” is used twice` });
    seen.add(o.id);
    const start = Math.max(clip.startSec, o.start);
    const end = Math.min(clip.endSec, o.end);
    if (end - start < 0.1) throw new TRPCError({ code: "BAD_REQUEST", message: `Overlay “${o.id}” lies outside the clip or lasts under 0.1 s` });
    const r3 = (n: number) => Number(n.toFixed(3));
    const kind = overlayKind(o);
    const base = { id: o.id, kind, start: Number(start.toFixed(2)), end: Number(end.toFixed(2)), x: r3(o.x), y: r3(o.y), ...(o.opacity !== undefined && o.opacity < 1 ? { opacity: r3(o.opacity) } : {}) };
    if (kind === "text") out.push({ ...base, text: o.text!, size: r3(o.size ?? TEXT_OVERLAY_DEFAULTS.size), color: (o.color ?? TEXT_OVERLAY_DEFAULTS.color).toUpperCase(), ...(o.box ? { box: true } : {}), ...(o.font && o.font !== TEXT_FONTS[0].family ? { font: o.font } : {}) });
    else out.push({ ...base, assetId: o.assetId!, w: r3(o.w ?? ASSET_OVERLAY_DEFAULT_W) });
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/**
 * Layers as stored: asset and text layers cleaned like overlays (plus `loop`), audio layers like music tracks,
 * one id space, ordered by start; null when empty.
 */
export function cleanLayers(list: ClipLayer[] | null | undefined, clip: ClipRange): ClipLayer[] | null {
  if (!list?.length) return null;
  if (list.length > MAX_CLIP_LAYERS) throw new TRPCError({ code: "BAD_REQUEST", message: `A clip can have at most ${MAX_CLIP_LAYERS} layers` });
  const ids = new Set<string>();
  for (const l of list) {
    if (ids.has(l.id)) throw new TRPCError({ code: "BAD_REQUEST", message: `Layer id “${l.id}” is used twice` });
    ids.add(l.id);
  }
  const { overlays, audio } = layersToLegacy(list);
  const loops = new Map(list.flatMap((l) => (l.kind === "asset" && l.loop !== undefined ? [[l.id, l.loop] as const] : [])));
  const visual: ClipLayer[] = (cleanOverlays(overlays, clip) ?? []).map((o) => {
    if (overlayKind(o) === "text") {
      const { assetId: _a, w: _w, kind: _k, ...rest } = o;
      return { ...rest, kind: "text" as const, text: o.text! };
    }
    const { text: _t, size: _s, color: _c, box: _b, font: _f, kind: _k, ...rest } = o;
    const loop = loops.get(o.id);
    return { ...rest, kind: "asset" as const, assetId: o.assetId!, ...(loop !== undefined ? { loop } : {}) };
  });
  const sounds: ClipLayer[] = (cleanAudio(audio, clip) ?? []).map((a) => ({ ...a, kind: "audio" as const }));
  return [...visual, ...sounds].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** Music tracks as stored: ordered by start, ids unique, clamped to the clip, defaults left out, numbers rounded; null when empty. */
export function cleanAudio(list: ClipAudio[] | null | undefined, clip: ClipRange): ClipAudio[] | null {
  if (!list?.length) return null;
  const seen = new Set<string>();
  const r2 = (n: number) => Number(n.toFixed(2));
  const out: ClipAudio[] = [];
  for (const a of list) {
    if (seen.has(a.id)) throw new TRPCError({ code: "BAD_REQUEST", message: `Music track id “${a.id}” is used twice` });
    seen.add(a.id);
    const start = Math.max(clip.startSec, a.start);
    const end = Math.min(clip.endSec, a.end);
    if (end - start < 0.5) throw new TRPCError({ code: "BAD_REQUEST", message: `Music track “${a.id}” lies outside the clip or lasts under 0.5 s` });
    out.push({
      id: a.id,
      assetId: a.assetId,
      start: r2(start),
      end: r2(end),
      ...(a.offset ? { offset: r2(a.offset) } : {}),
      ...(a.volume !== undefined && Math.abs(a.volume - CLIP_AUDIO_DEFAULTS.volume) > 1e-3 ? { volume: r2(a.volume) } : {}),
      ...(a.duck === false ? { duck: false } : {}),
      ...(a.fade !== undefined && Math.abs(a.fade - CLIP_AUDIO_DEFAULTS.fade) > 1e-3 ? { fade: r2(a.fade) } : {}),
      ...(a.loop === false ? { loop: false } : {}),
    });
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}
