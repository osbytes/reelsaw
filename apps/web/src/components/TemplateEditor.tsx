import { useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Undo2, Redo2, Keyboard, Loader2, Trash2, Eye, Type, Image as ImageIcon, Music as MusicIcon, PencilLine, AlignCenterHorizontal, AlignCenterVertical, BringToFront, SendToBack, Copy, Maximize2 } from "lucide-react";
import { toast } from "sonner";
import {
  MAX_CLIP_LAYERS,
  TEXT_OVERLAY_DEFAULTS,
  ASSET_OVERLAY_DEFAULT_W,
  CLIP_AUDIO_DEFAULTS,
  SFX_AUDIO_DEFAULTS,
  LAYER_TIMING_MODES,
  LAYER_TIMING_LABEL,
  TEMPLATE_PREVIEW_SECONDS,
  DEFAULT_TEMPLATE_PREVIEW_SEC,
  TEXT_FONTS,
  audioLayerDefaultsFor,
  assetLayerDefaultsFor,
  defaultStyle,
  isStickerAsset,
  isVisualLayer,
  layerMinSeconds,
  layerTemplateNameSchema,
  newLayerId,
  resolveTemplateLayers,
  templateFromLayers,
  timingText,
  type AudioLayer,
  type ClipLayer,
  type LayerTiming,
  type Style,
  type TemplateLayer,
} from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { useHistory } from "../lib/history";
import { createClock, useClock, type Clock } from "../lib/playback";
import { useShortcut, useShortcuts, useSheetKey, MOD } from "../lib/shortcuts";
import { useUnsavedFlag } from "../lib/unsaved";
import { loadTextFonts } from "../lib/fonts";
import { ScrollArea } from "./scroll-area";
import { VerticalPreview, OverlayMenuItem, OverlayMenuSeparator, type Framing, type PreviewAssetOverlay } from "./VerticalPreview";
import { Timeline, type EditorSection, type LayerBlock } from "./Timeline";
import { Modal, Segmented, Select } from "./ui";
import { useBumperLibrary, type LibraryAsset } from "./BumperField";
import { AssetFinderDialog, type PickedAsset } from "./AssetFinder";
import { Thumb, clockText } from "./BumperCombobox";
import { ShortcutSheet } from "./ShortcutSheet";
import { ThemeToggle } from "../App";

/** The template as the editor receives it (`layerTemplates.get`). */
export interface EditorTemplate {
  id: string;
  name: string;
  layers: TemplateLayer[];
}

interface Props {
  template: EditorTemplate;
  onExit: () => void;
}

type TAsset = Extract<TemplateLayer, { kind: "asset" }>;
type TText = Extract<TemplateLayer, { kind: "text" }>;
type TAudio = Extract<TemplateLayer, { kind: "audio" }>;
type TemplatePatch = Partial<Omit<TAsset, "kind"> & Omit<TText, "kind"> & Omit<TAudio, "kind">>;
type Mode = LayerTiming["mode"];

interface TemplateDoc {
  name: string;
  layers: TemplateLayer[];
}

const PREVIEW_KEY = "rs-template-preview-sec";
const SNAP_KEY = "rs-editor-snap";
const FRAME = 1 / 30;
/** the stand-in frame: no source video, the whole (empty) frame */
const FRAMING: Framing = { layout: "fit", cx: 0.5, cy: 0.5 };
const STYLE: Style = { ...defaultStyle, showHook: false };
const r2 = (n: number) => Number(n.toFixed(2));
const r4 = (n: number) => Number(n.toFixed(4));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function readPreviewSec(): number {
  try {
    const v = Number(localStorage.getItem(PREVIEW_KEY));
    return (TEMPLATE_PREVIEW_SECONDS as readonly number[]).includes(v) ? v : DEFAULT_TEMPLATE_PREVIEW_SEC;
  } catch {
    return DEFAULT_TEMPLATE_PREVIEW_SEC;
  }
}

/**
 * A window `[a, b]` (seconds on a clip `len` long) expressed in a timing mode, so switching modes or dragging a
 * block keeps the layer exactly where it is at this preview length. Proportional keeps its min / max hold.
 */
function timingFor(mode: Mode, [a, b]: [number, number], len: number, prev: LayerTiming): LayerTiming {
  switch (mode) {
    case "fill":
      return { mode: "fill" };
    case "head":
      return { mode: "head", start: r2(a), end: r2(b) };
    case "tail":
      return { mode: "tail", start: r2(len - a), end: r2(len - b) };
    case "relative":
      return {
        mode: "relative",
        start: r4(clamp(a / len, 0, 1)),
        end: r4(clamp(b / len, 0, 1)),
        ...(prev.mode === "relative" && prev.minSec !== undefined ? { minSec: prev.minSec } : {}),
        ...(prev.mode === "relative" && prev.maxSec !== undefined ? { maxSec: prev.maxSec } : {}),
      };
  }
}

/** GIF / animated WebP / video: a picture that moves, so it can repeat inside its window */
const isAnimatedAsset = (a: LibraryAsset | undefined) => !!a && (a.kind === "video" || a.mime === "image/gif" || a.mime === "image/webp");
const isSoundEffect = (a: LibraryAsset | undefined) => !!a && audioLayerDefaultsFor({ durationSec: a.durationSec }) === SFX_AUDIO_DEFAULTS;
/** Catalog / provider imports are instance-shared and missing from `library.list`; seed from the pick until `library.get` returns. */
function layerAssetFromPick(a: PickedAsset): LibraryAsset {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    durationSec: a.durationSec,
    mime: a.mime ?? null,
    width: a.width ?? 0,
    height: a.height ?? 0,
    hasAudio: a.hasAudio ?? a.kind === "audio",
    sizeBytes: 0,
    createdAt: new Date().toISOString(),
    thumbnailUrl: a.thumbnailUrl ?? (a.kind === "audio" ? "" : `/media/assets/${a.id}/thumb.jpg`),
    usedBy: 0,
    usedByClips: 0,
    usedByTemplates: 0,
    tags: [],
    provenance: null,
    system: false,
    owner: "shared",
  };
}
const fmtPrecise = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
};

/** A seconds / percent field: commits on blur or Enter, ↑↓ nudge; empty commits `null` when `optional`. */
function NumField({ value, onCommit, label, step = 0.1, suffix, optional, width = "w-[64px]" }: { value: number | undefined; onCommit: (v: number | null) => void; label: string; step?: number; suffix: string; optional?: boolean; width?: string }) {
  const show = (v: number | undefined) => (v === undefined ? "" : String(Number(v.toFixed(2))));
  const [text, setText] = useState(show(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(show(value));
  }, [value, focused]);
  const commit = () => {
    const t = text.trim();
    if (!t && optional) return onCommit(null);
    const n = Number(t);
    if (t && Number.isFinite(n)) onCommit(n);
    else setText(show(value));
  };
  return (
    <span className="inline-flex items-center gap-1">
      <input
        aria-label={label}
        data-native-undo
        inputMode="decimal"
        placeholder={optional ? "–" : undefined}
        className={`${width} rounded-[8px] border border-line bg-panel px-1.5 py-1 text-center font-mono text-xs text-ink outline-none focus:border-acc`}
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if ((e.key === "ArrowUp" || e.key === "ArrowDown") && value !== undefined) {
            e.preventDefault();
            onCommit(value + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? step * 10 : step));
          }
        }}
      />
      <span className="text-ink3">{suffix}</span>
    </span>
  );
}

function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-ink2">{label}</span>
        {hint && <span className="text-[11px] text-ink3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 text-[13px]">
      <span>{label}</span>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-acc" : "bg-line2"}`}>
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${checked ? "left-[18px]" : "left-0.5"}`} />
      </button>
    </label>
  );
}

function Swatches({ colors, value, onChange, label }: { colors: string[]; value: string; onChange: (c: string) => void; label: string }) {
  const on = (c: string) => c.toUpperCase() === value.toUpperCase();
  return (
    <div className="flex flex-wrap items-center gap-2">
      {colors.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`${label} ${c}`}
          onClick={() => onChange(c)}
          className="h-[30px] w-[30px] rounded-full"
          style={{ background: c, border: on(c) ? "2px solid var(--ink)" : "2px solid var(--line)", outline: on(c) ? "2px solid var(--panel)" : "none", outlineOffset: -4 }}
        />
      ))}
      <label className="relative grid h-[30px] w-[30px] cursor-pointer place-items-center rounded-full border-2 border-dashed border-line2 text-xs text-ink3" title="Custom colour">
        +
        <input type="color" className="absolute inset-0 cursor-pointer opacity-0" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      </label>
    </div>
  );
}

const TEXT_COLORS = ["#FFFFFF", "#FFD84D", "#5EE0A0", "#C6A8FF", "#FF8A5C", "#000000"];
const TEXT_SIZES: Array<{ v: number; l: string }> = [
  { v: 0.032, l: "S" },
  { v: 0.045, l: "M" },
  { v: 0.065, l: "L" },
];

/** The Timing row of a card: the mode, its fields, and the timing in words. */
function TimingRow({ layer: l, window: w, len, onTiming }: { layer: TemplateLayer; window: [number, number] | null; len: number; onTiming: (t: LayerTiming, key?: string) => void }) {
  const t = l.timing;
  const min = layerMinSeconds(l.kind);
  const switchTo = (mode: Mode) => {
    if (mode === t.mode) return;
    // the window it has now (or a short one at the start when it does not fit this length), so nothing jumps
    onTiming(timingFor(mode, w ?? [0, Math.min(len, 4)], len, t));
  };
  return (
    <div className="flex flex-col gap-2 rounded-[10px] bg-sunk/60 p-2" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-ink2">Timing</span>
        <span className="truncate text-[11px] text-ink3">{timingText(t)}</span>
      </div>
      <ScrollArea className="w-full">
        <Segmented size="sm" className="w-max min-w-full" value={t.mode} onChange={switchTo} options={LAYER_TIMING_MODES.map((m) => ({ value: m, label: LAYER_TIMING_LABEL[m] }))} ariaLabel="Timing" />
      </ScrollArea>
      {t.mode === "head" && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
          <span className="text-ink3">From</span>
          <NumField label="Seconds after the start it appears" suffix="s" value={t.start} onCommit={(v) => v !== null && onTiming({ ...t, start: r2(clamp(v, 0, t.end - min)) })} />
          <span className="text-ink3">to</span>
          <NumField label="Seconds after the start it ends" suffix="s" value={t.end} onCommit={(v) => v !== null && onTiming({ ...t, end: r2(Math.max(t.start + min, v)) })} />
          <span className="text-ink3">after the start</span>
        </div>
      )}
      {t.mode === "tail" && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
          <span className="text-ink3">Starts</span>
          <NumField label="Seconds before the end it appears" suffix="s" value={t.start} onCommit={(v) => v !== null && onTiming({ ...t, start: r2(Math.max(t.end + min, v)) })} />
          <span className="text-ink3">and ends</span>
          <NumField label="Seconds before the end it ends" suffix="s" value={t.end} onCommit={(v) => v !== null && onTiming({ ...t, end: r2(clamp(v, 0, t.start - min)) })} />
          <span className="text-ink3">before the end</span>
        </div>
      )}
      {t.mode === "fill" && <p className="text-xs text-ink3">From the first to the last second of every clip.</p>}
      {t.mode === "relative" && (
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="text-ink3">From</span>
            <NumField label="Start, percent of the clip" step={1} suffix="%" value={Math.round(t.start * 1000) / 10} onCommit={(v) => v !== null && onTiming({ ...t, start: r4(clamp(v / 100, 0, t.end - 0.01)) })} />
            <span className="text-ink3">to</span>
            <NumField label="End, percent of the clip" step={1} suffix="%" value={Math.round(t.end * 1000) / 10} onCommit={(v) => v !== null && onTiming({ ...t, end: r4(clamp(v / 100, t.start + 0.01, 1)) })} />
            <span className="text-ink3">of the clip</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span className="text-ink3">At least</span>
            <NumField
              optional
              label="Never shorter than, seconds"
              suffix="s"
              value={t.minSec}
              onCommit={(v) => {
                const { minSec: _m, ...rest } = t;
                if (v === null) return onTiming(rest);
                const n = r2(clamp(v, 0, 600));
                onTiming({ ...rest, minSec: n, ...(t.maxSec !== undefined && t.maxSec < n ? { maxSec: n } : {}) });
              }}
            />
            <span className="text-ink3">at most</span>
            <NumField
              optional
              label="Never longer than, seconds"
              suffix="s"
              value={t.maxSec}
              onCommit={(v) => {
                const { maxSec: _m, ...rest } = t;
                if (v === null) return onTiming(rest);
                onTiming({ ...rest, maxSec: r2(clamp(v, Math.max(min, t.minSec ?? 0), 600)) });
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One template layer in the inspector: the header (what it is, where it lands at the preview length, remove), the
 * fields of its kind (the clip editor's LayerCard), and the Timing row in place of from / to seconds.
 */
function TemplateLayerCard({ layer: l, window: w, len, asset, selected, loading, onSelect, onPatch, onRemove }: { layer: TemplateLayer; window: [number, number] | null; len: number; asset: LibraryAsset | undefined; selected: boolean; loading: boolean; onSelect: () => void; onPatch: (patch: TemplatePatch, key?: string) => void; onRemove: () => void }) {
  const removed = loading ? "…" : "Removed from the library";
  const kindLabel = l.kind === "text" ? "text" : l.kind === "audio" ? (isSoundEffect(asset) ? "Sound effect" : "Music") : (asset?.kind ?? "image");
  const sizeIdx = l.kind === "text" ? TEXT_SIZES.findIndex((sz) => Math.abs(sz.v - (l.size ?? TEXT_OVERLAY_DEFAULTS.size)) < 0.004) : -1;
  const pct = (v: number) => Math.round(v * 100);
  const opacityField = (aria: string) => {
    const o = l.kind === "audio" ? 1 : (l.opacity ?? 1);
    return (
      <Field label="Opacity" hint={<span className="font-mono">{pct(o)}%</span>}>
        <input type="range" min={10} max={100} step={5} value={pct(o)} onChange={(e) => onPatch({ opacity: Number(e.target.value) === 100 ? undefined : Number(e.target.value) / 100 }, `ly-o-${l.id}`)} className="accent-[var(--acc)]" aria-label={aria} />
      </Field>
    );
  };
  return (
    <div data-layer-card={l.id} onClick={onSelect} className={`flex cursor-pointer flex-col gap-2 rounded-[12px] p-2.5 ${selected ? "border-2 border-acc" : "border border-line"}`}>
      <div className="flex items-center gap-2">
        {l.kind === "text" ? (
          <span className="grid h-9 w-5 shrink-0 place-items-center rounded-[4px] bg-sunk text-ink2">
            <Type className="h-3.5 w-3.5" />
          </span>
        ) : l.kind === "audio" ? (
          <span className="grid h-9 w-5 shrink-0 place-items-center rounded-[4px] bg-sunk text-ink2">
            <MusicIcon className="h-3.5 w-3.5" />
          </span>
        ) : asset ? (
          <Thumb asset={asset} className="h-9 w-5" />
        ) : (
          <span className="h-9 w-5 shrink-0 rounded-[4px] bg-sunk" />
        )}
        <span className="min-w-0 flex-1">
          {l.kind === "text" ? (
            <input
              className="input h-7 w-full px-2 py-0 text-[13px] font-semibold"
              value={l.text}
              maxLength={120}
              placeholder="Your text"
              aria-label="Layer text"
              data-native-undo
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onPatch({ text: e.target.value }, `ly-t-${l.id}`)}
            />
          ) : (
            <span className="block truncate text-[13px] font-semibold">{asset?.name ?? removed}</span>
          )}
          <span className={`block truncate font-mono text-[11px] ${w ? "text-ink3" : "text-warn"}`} title={w ? `Where it lands on a ${len} s clip` : undefined}>
            {w ? `${fmtPrecise(w[0])}–${fmtPrecise(w[1])} at ${len} s` : `▲ left out of a ${len} s clip`} · {kindLabel}
            {l.kind === "audio" && asset ? ` · ${clockText(asset.durationSec)}` : ""}
          </span>
        </span>
        <button
          className="grid h-7 w-7 place-items-center rounded-[8px] text-ink3 hover:bg-sunk hover:text-ink"
          aria-label="Remove layer"
          title="Remove layer (Delete)"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <TimingRow layer={l} window={w} len={len} onTiming={(timing, key) => onPatch({ timing }, key)} />
      {l.kind === "text" && (
        <div className="flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Size">
              <Segmented size="sm" value={sizeIdx >= 0 ? TEXT_SIZES[sizeIdx]!.v : -1} onChange={(v) => onPatch({ size: v })} options={TEXT_SIZES.map((sz) => ({ value: sz.v, label: sz.l }))} ariaLabel="Text size" />
            </Field>
            {opacityField("Text opacity")}
          </div>
          <Field label="Font">
            <Select size="sm" ariaLabel="Text font" value={l.font ?? TEXT_FONTS[0].family} onValueChange={(v) => onPatch({ font: v === TEXT_FONTS[0].family ? undefined : v })} options={TEXT_FONTS.map((f) => ({ value: f.family, label: f.label }))} />
          </Field>
          <Field label="Colour">
            <Swatches label="Text colour" colors={TEXT_COLORS} value={l.color ?? TEXT_OVERLAY_DEFAULTS.color} onChange={(c) => onPatch({ color: c })} />
          </Field>
          <Switch checked={!!l.box} onChange={(v) => onPatch({ box: v || undefined })} label="Dark plate behind the text" />
        </div>
      )}
      {l.kind === "asset" && (
        <div className="flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Left / right" hint={<span className="font-mono">{pct(l.x)}%</span>}>
              <input type="range" min={0} max={100} step={1} value={pct(l.x)} onChange={(e) => onPatch({ x: Number(e.target.value) / 100 }, `ly-x-${l.id}`)} className="accent-[var(--acc)]" aria-label="Layer position across" />
            </Field>
            <Field label="Up / down" hint={<span className="font-mono">{pct(l.y)}%</span>}>
              <input type="range" min={0} max={100} step={1} value={pct(l.y)} onChange={(e) => onPatch({ y: Number(e.target.value) / 100 }, `ly-y-${l.id}`)} className="accent-[var(--acc)]" aria-label="Layer position down" />
            </Field>
            <Field label="Width" hint={<span className="font-mono">{pct(l.w ?? ASSET_OVERLAY_DEFAULT_W)}%</span>}>
              <input type="range" min={5} max={100} step={1} value={pct(l.w ?? ASSET_OVERLAY_DEFAULT_W)} onChange={(e) => onPatch({ w: Number(e.target.value) / 100 }, `ly-w-${l.id}`)} className="accent-[var(--acc)]" aria-label="Layer width" />
            </Field>
            {opacityField("Layer opacity")}
          </div>
          {isAnimatedAsset(asset) && <Switch checked={l.loop ?? isStickerAsset(asset!)} onChange={(v) => onPatch({ loop: v })} label="Repeat while it shows" />}
        </div>
      )}
      {l.kind === "audio" && (
        <div className="flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Level" hint={<span className="font-mono">{pct(l.volume ?? CLIP_AUDIO_DEFAULTS.volume)}%</span>}>
              <input type="range" min={0} max={100} step={5} value={pct(l.volume ?? CLIP_AUDIO_DEFAULTS.volume)} onChange={(e) => onPatch({ volume: Number(e.target.value) / 100 }, `ly-vol-${l.id}`)} className="accent-[var(--acc)]" aria-label="Sound level" />
            </Field>
            <Field label="Fade in / out" hint={<span className="font-mono">{(l.fade ?? CLIP_AUDIO_DEFAULTS.fade).toFixed(1)}s</span>}>
              <input type="range" min={0} max={5} step={0.5} value={l.fade ?? CLIP_AUDIO_DEFAULTS.fade} onChange={(e) => onPatch({ fade: Number(e.target.value) }, `ly-fade-${l.id}`)} className="accent-[var(--acc)]" aria-label="Sound fade" />
            </Field>
          </div>
          <Switch checked={l.duck ?? CLIP_AUDIO_DEFAULTS.duck} onChange={(v) => onPatch({ duck: v })} label="Lower it while someone speaks" />
          <Switch checked={l.loop ?? CLIP_AUDIO_DEFAULTS.loop} onChange={(v) => onPatch({ loop: v })} label="Repeat if it is shorter than its window" />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-ink3">Track from</span>
            <NumField label="Seconds into the track" suffix="s" value={l.offset ?? 0} onCommit={(v) => v !== null && onPatch({ offset: Math.max(0, r2(v)) || undefined })} />
          </div>
        </div>
      )}
    </div>
  );
}

function LiveTimeline({ clock, ...props }: Omit<ComponentProps<typeof Timeline>, "current"> & { clock: Clock }) {
  return <Timeline {...props} current={useClock(clock)} />;
}

function LivePreview({ clock, overlaysAt, ...props }: Omit<ComponentProps<typeof VerticalPreview>, "time" | "assetOverlays"> & { clock: Clock; overlaysAt: (t: number) => PreviewAssetOverlay[] }) {
  const t = useClock(clock);
  const assetOverlays = useMemo(() => overlaysAt(t), [overlaysAt, t]);
  return <VerticalPreview {...props} assetOverlays={assetOverlays} time={t} />;
}

function ClockText({ clock, len }: { clock: Clock; len: number }) {
  const t = useClock(clock);
  return (
    <span className="mx-1.5 min-w-[7.5rem] text-center font-mono text-xs text-ink2">
      {fmtPrecise(t)} / {fmtPrecise(len)}
    </span>
  );
}

const noop = () => {};

/**
 * The template editor (docs/specs/layer-templates.md): the clip editor slimmed to a template. A 9:16 stand-in frame,
 * the Layers lane laid out at a preview length, and one card per layer with its Timing. The document (name and
 * layers) is undoable; the preview length is a view setting kept per browser.
 */
export function TemplateEditor({ template, onExit }: Props) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const history = useHistory<TemplateDoc>(() => ({ name: template.name, layers: template.layers }));
  const doc = history.state;
  const { name, layers } = doc;
  const [saved, setSaved] = useState<TemplateDoc>(() => ({ name: template.name, layers: template.layers }));
  const edit = (fn: (d: TemplateDoc) => TemplateDoc, key?: string) => history.set(fn, key);

  const [previewSec, setPreviewSecRaw] = useState(readPreviewSec);
  const len = previewSec;
  const setPreviewSec = (v: number) => {
    setPreviewSecRaw(v);
    try {
      localStorage.setItem(PREVIEW_KEY, String(v));
    } catch {
      /* private mode */
    }
  };
  const [snap, setSnapRaw] = useState(() => {
    try {
      return localStorage.getItem(SNAP_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const setSnap = (v: boolean) => {
    setSnapRaw(v);
    try {
      localStorage.setItem(SNAP_KEY, v ? "on" : "off");
    } catch {
      /* private mode */
    }
  };
  const [safe, setSafe] = useState(true);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ kind: "asset" | "audio"; t: number } | null>(null);
  const [guard, setGuard] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const clock = useMemo(() => createClock(0), []);
  useEffect(() => loadTextFonts(), []);
  useEffect(() => {
    if (selectedLayer && !layers.some((l) => l.id === selectedLayer)) setSelectedLayer(null);
  }, [layers, selectedLayer]);
  useEffect(() => {
    if (!selectedLayer) return;
    const id = requestAnimationFrame(() => document.querySelector(`[data-layer-card="${selectedLayer}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    return () => cancelAnimationFrame(id);
  }, [selectedLayer]);
  // a shorter preview pulls the playhead inside it
  useEffect(() => {
    if (clock.get() > len) clock.set(len);
  }, [len, clock]);

  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const compact = size.w < 900;
  const short = !compact && size.h < 720;

  // ----- assets: names, thumbnails and shapes of the layers' library files -----
  const library = useBumperLibrary();
  const [imported, setImported] = useState<LibraryAsset[]>([]);
  const ownAssets = useMemo(() => [...(library.data?.assets ?? []), ...(library.data?.deleted ?? [])], [library.data]);
  const wantedIds = useMemo(() => [...new Set(layers.flatMap((l) => (l.kind === "text" ? [] : [l.assetId])))], [layers]);
  const haveIds = useMemo(() => new Set([...ownAssets, ...imported].map((a) => a.id)), [ownAssets, imported]);
  const missingIds = useMemo(() => wantedIds.filter((id) => !haveIds.has(id)).sort(), [wantedIds, haveIds]);
  const extra = useQuery({ ...trpc.library.get.queryOptions({ ids: missingIds }), enabled: missingIds.length > 0 });
  const libraryAssets = useMemo(() => {
    const map = new Map<string, LibraryAsset>();
    for (const a of [...ownAssets, ...imported, ...(extra.data?.assets ?? [])]) map.set(a.id, a);
    return map;
  }, [ownAssets, imported, extra.data]);
  const assetById = (id: string | undefined) => (id ? libraryAssets.get(id) : undefined);
  const assetsLoading = library.isPending || (missingIds.length > 0 && extra.isPending);
  const rememberPick = (a: PickedAsset) => setImported((prev) => (prev.some((x) => x.id === a.id) ? prev : [...prev, layerAssetFromPick(a)]));

  // ----- the template laid out on a clip of the preview length (resolved layers keep the template ids) -----
  const resolved = useMemo(() => resolveTemplateLayers(layers, { startSec: 0, endSec: len }, (l) => l.id), [layers, len]);
  const windows = useMemo(() => new Map(resolved.layers.map((l) => [l.id, [l.start, l.end] as [number, number]])), [resolved]);
  const sections: EditorSection[] = useMemo(() => [{ start: 0, end: len, mode: "auto" }], [len]);

  const setLayers = (fn: (list: TemplateLayer[]) => TemplateLayer[], key?: string) => edit((d) => ({ ...d, layers: fn(d.layers) }), key);
  const patchLayer = (id: string, patch: TemplatePatch, key?: string) => setLayers((list) => list.map((l) => (l.id === id ? ({ ...l, ...patch } as TemplateLayer) : l)), key);
  /** a block dragged or trimmed on the lane: the new window in the layer's own mode (a trimmed "whole clip" becomes "from the start") */
  const moveLayer = (id: string, [a, b]: [number, number], key?: string) => {
    const l = layers.find((x) => x.id === id);
    if (!l) return;
    const t = l.timing;
    const whole = a <= 0.01 && b >= len - 0.01;
    const mode: Mode = t.mode === "fill" ? (whole ? "fill" : "head") : t.mode;
    patchLayer(id, { timing: timingFor(mode, [a, b], len, t) }, key);
  };
  const seek = (t: number) => clock.set(clamp(t, 0, len));
  const removeLayer = (id: string) => {
    setLayers((list) => list.filter((l) => l.id !== id));
    if (selectedLayer === id) setSelectedLayer(null);
  };
  /** a copy right after the original, nudged so both show on the canvas */
  const duplicateLayer = (id: string) => {
    const i = layers.findIndex((l) => l.id === id);
    const l = layers[i];
    if (!l) return;
    if (layers.length >= MAX_CLIP_LAYERS) return toast(`A template can have at most ${MAX_CLIP_LAYERS} layers`);
    const copy: TemplateLayer = l.kind === "audio" ? { ...l, id: newLayerId() } : { ...l, id: newLayerId(), x: Math.min(0.95, l.x + 0.04), y: Math.min(0.95, l.y + 0.04) };
    setLayers((list) => [...list.slice(0, i + 1), copy, ...list.slice(i + 1)]);
    setSelectedLayer(copy.id);
    toast("Duplicated");
  };
  /** layers are drawn in list order: last on top */
  const orderLayer = (id: string, where: "front" | "back") =>
    setLayers((list) => {
      const l = list.find((x) => x.id === id);
      if (!l) return list;
      const rest = list.filter((x) => x.id !== id);
      return where === "front" ? [...rest, l] : [l, ...rest];
    });
  /** the canvas's right-click menu on a layer (the layer is selected by then) */
  const overlayMenu = (o: PreviewAssetOverlay, ctx: { editText: () => void }) => {
    const l = layers.find((x) => x.id === o.id);
    if (!l || l.kind === "audio") return null;
    return (
      <>
        {o.kind === "text" && <OverlayMenuItem icon={<PencilLine className="h-3.5 w-3.5" />} label="Edit text" kbd="dbl-click" onSelect={ctx.editText} />}
        <OverlayMenuItem icon={<AlignCenterHorizontal className="h-3.5 w-3.5" />} label="Centre left / right" disabled={l.x === 0.5} onSelect={() => patchLayer(l.id, { x: 0.5 })} />
        <OverlayMenuItem icon={<AlignCenterVertical className="h-3.5 w-3.5" />} label="Centre up / down" disabled={l.y === 0.5} onSelect={() => patchLayer(l.id, { y: 0.5 })} />
        <OverlayMenuItem icon={<Maximize2 className="h-3.5 w-3.5" />} label="Show for the whole clip" disabled={l.timing.mode === "fill"} onSelect={() => patchLayer(l.id, { timing: { mode: "fill" } })} />
        {o.kind === "asset" && (
          <>
            <OverlayMenuSeparator />
            <OverlayMenuItem icon={<BringToFront className="h-3.5 w-3.5" />} label="Bring to front" disabled={layers[layers.length - 1]?.id === l.id} onSelect={() => orderLayer(l.id, "front")} />
            <OverlayMenuItem icon={<SendToBack className="h-3.5 w-3.5" />} label="Send to back" disabled={layers[0]?.id === l.id} onSelect={() => orderLayer(l.id, "back")} />
          </>
        )}
        <OverlayMenuSeparator />
        <OverlayMenuItem icon={<Copy className="h-3.5 w-3.5" />} label="Duplicate" onSelect={() => duplicateLayer(l.id)} />
        <OverlayMenuItem icon={<Trash2 className="h-3.5 w-3.5" />} label="Remove" kbd="⌫" onSelect={() => removeLayer(l.id)} />
      </>
    );
  };
  const selectLayer = (id: string | null) => {
    setSelectedLayer(id);
    const w = id ? windows.get(id) : undefined;
    const t = clock.get();
    if (w && (t < w[0] || t > w[1])) seek(w[0]);
  };

  // ----- adding: the clip editor's defaults, then the window becomes a timing -----
  const layerWindow = (t: number, dur: number): [number, number] => {
    const start = r2(clamp(t, 0, len - 0.5));
    return [start, r2(Math.min(len, start + dur))];
  };
  const pushLayer = (l: ClipLayer, note: string, timing?: LayerTiming) => {
    if (layers.length >= MAX_CLIP_LAYERS) return toast(`A template can have at most ${MAX_CLIP_LAYERS} layers`);
    const base = templateFromLayers([l], { startSec: 0, endSec: len })[0]!;
    const tl: TemplateLayer = timing ? { ...base, timing } : base;
    setLayers((list) => [...list, tl]);
    setSelectedLayer(tl.id);
    const t = clock.get();
    if (t < l.start || t > l.end) seek(l.start);
    toast(`${note} · ${timingText(tl.timing).toLowerCase()}`);
  };
  type NewLayerAsset = Pick<LibraryAsset, "id" | "name" | "kind" | "durationSec"> & { mime?: string | null; hasAudio?: boolean };
  const addAssetLayer = (asset: NewLayerAsset, t: number) => {
    const d = assetLayerDefaultsFor(asset);
    const [start, end] = layerWindow(t, Math.min(d.windowSec, len - t));
    pushLayer({ id: newLayerId(), kind: "asset", assetId: asset.id, start, end, x: 0.5, y: d.y, w: d.w, ...(d.loop ? { loop: true } : {}) }, `${asset.name} added`);
  };
  const addTextLayer = (t: number) => {
    const [start, end] = layerWindow(t, 4);
    pushLayer({ id: newLayerId(), kind: "text", text: "Your text", start, end, x: 0.5, y: 0.3, size: TEXT_OVERLAY_DEFAULTS.size, color: TEXT_OVERLAY_DEFAULTS.color }, "Text added");
  };
  const addSoundLayer = (asset: NewLayerAsset, t: number) => {
    const defaults = audioLayerDefaultsFor({ durationSec: asset.durationSec });
    const oneShot = defaults === SFX_AUDIO_DEFAULTS;
    const [start, end] = oneShot ? layerWindow(t, Math.max(0.5, asset.durationSec)) : [0, len];
    // music is a bed under the whole clip, cut to length; a one-shot sound anchors to the nearer edge
    pushLayer({ id: newLayerId(), kind: "audio", assetId: asset.id, start, end, volume: defaults.volume, duck: defaults.duck, fade: defaults.fade, loop: defaults.loop }, `${asset.name} added`, oneShot ? undefined : { mode: "fill" });
  };

  const layerBlocks: LayerBlock[] = useMemo(
    () =>
      resolved.layers.map((l) => {
        if (l.kind === "text") return { id: l.id, start: l.start, end: l.end, name: l.text, kind: "text" as const };
        const a = libraryAssets.get(l.assetId);
        const nm = a?.name ?? (assetsLoading ? "…" : "removed");
        if (l.kind === "audio") return { id: l.id, start: l.start, end: l.end, name: nm, kind: "audio" as const };
        return { id: l.id, start: l.start, end: l.end, name: nm, kind: isAnimatedAsset(a) ? ("video" as const) : ("image" as const), thumbnailUrl: a?.thumbnailUrl };
      }),
    [resolved, libraryAssets, assetsLoading],
  );
  const overlaysAt = useMemo(
    () =>
      (t: number): PreviewAssetOverlay[] =>
        resolved.layers
          .filter(isVisualLayer)
          .filter((l) => t >= l.start - 0.001 && t <= l.end + 0.001)
          .flatMap((l): PreviewAssetOverlay[] => {
            if (l.kind === "text") return [{ kind: "text", id: l.id, text: l.text, x: l.x, y: l.y, size: l.size ?? TEXT_OVERLAY_DEFAULTS.size, color: l.color ?? TEXT_OVERLAY_DEFAULTS.color, box: !!l.box, opacity: l.opacity ?? 1, ...(l.font ? { font: l.font } : {}) }];
            const a = libraryAssets.get(l.assetId);
            if (!a) return [];
            const aspect = a.width > 0 && a.height > 0 ? a.width / a.height : 0;
            return [{ kind: "asset", id: l.id, url: `/media/assets/${a.id}`, name: a.name, aspect, x: l.x, y: l.y, w: l.w ?? ASSET_OVERLAY_DEFAULT_W, opacity: l.opacity ?? 1, video: a.kind === "video", loop: l.loop ?? isStickerAsset(a), offsetSec: t - l.start }];
          }),
    [resolved, libraryAssets],
  );

  // ----- playback: a plain clock over the preview length (no source video); sounds follow it -----
  const togglePlay = () => {
    if (playing) return setPlaying(false);
    if (clock.get() >= len - 0.05) clock.set(0);
    setPlaying(true);
  };
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const next = clock.get() + (now - last) / 1000;
      last = now;
      if (next >= len) {
        clock.set(len);
        setPlaying(false);
        return;
      }
      clock.set(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, len, clock]);
  const audioLayers = useMemo(() => resolved.layers.filter((l): l is AudioLayer => l.kind === "audio"), [resolved]);
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  useEffect(() => {
    for (const m of audioLayers) {
      const el = audioEls.current.get(m.id);
      if (el) el.volume = clamp(m.volume ?? CLIP_AUDIO_DEFAULTS.volume, 0, 1);
    }
  }, [audioLayers]);
  useEffect(() => {
    const els = audioEls.current;
    const pauseAll = () => els.forEach((el) => el.pause());
    if (!audioLayers.length || !playing) {
      pauseAll();
      return;
    }
    let raf = 0;
    const follow = () => {
      const t = clock.get();
      for (const m of audioLayers) {
        const el = els.get(m.id);
        if (!el) continue;
        if (t >= m.start && t < m.end) {
          const want = (m.offset ?? 0) + (t - m.start);
          const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : Infinity;
          const at = m.loop === false ? want : want % dur;
          if (Math.abs(el.currentTime - at) > 0.35) el.currentTime = at;
          if (el.paused && (m.loop !== false || want < dur)) el.play().catch(() => {});
        } else if (!el.paused) el.pause();
      }
      raf = requestAnimationFrame(follow);
    };
    raf = requestAnimationFrame(follow);
    return () => {
      cancelAnimationFrame(raf);
      pauseAll();
    };
  }, [audioLayers, playing, clock]);

  // ----- dirty + save -----
  const dirty = JSON.stringify(doc) !== JSON.stringify(saved);
  const nameOk = layerTemplateNameSchema.safeParse(name).success;
  const update = useMutation(trpc.layerTemplates.update.mutationOptions());
  const busy = update.isPending;
  async function save(): Promise<boolean> {
    if (!nameOk) {
      toast.error("Give the template a name first");
      return false;
    }
    const sent = doc;
    try {
      await update.mutateAsync({ id: template.id, name: sent.name.trim(), layers: sent.layers });
      setSaved(sent);
      await Promise.all([qc.invalidateQueries({ queryKey: trpc.layerTemplates.list.queryKey() }), qc.invalidateQueries({ queryKey: trpc.layerTemplates.get.queryKey({ id: template.id }) })]);
      toast("Saved");
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    }
  }
  const requestExit = () => (dirty ? setGuard(true) : onExit());
  useUnsavedFlag("template-editor", dirty);
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [dirty]);

  // ----- keyboard -----
  const nativeUndo = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.("[data-native-undo]");
  useShortcut("mod+z", (e) => !nativeUndo(e) && (e.preventDefault(), history.undo()), { inFields: true, preventDefault: false });
  useShortcut("mod+shift+z, mod+y", (e) => !nativeUndo(e) && (e.preventDefault(), history.redo()), { inFields: true, preventDefault: false });
  useShortcut("mod+s", () => dirty && !busy && void save(), { inFields: true });
  useShortcut("delete, backspace", () => selectedLayer && removeLayer(selectedLayer), { preventDefault: false });
  useShortcut("space", () => togglePlay());
  useShortcut("s", () => setSnap(!snap), { preventDefault: false });
  useShortcut("left, right, shift+left, shift+right", (e) => {
    setPlaying(false);
    seek(clock.get() + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : FRAME));
  });
  useShortcut("escape", () => setKeysOpen(false), { enabled: keysOpen, preventDefault: false });
  useSheetKey(() => setKeysOpen((o) => !o));
  useShortcuts("Template editor", [
    ["Play / pause", "Space"],
    ["Previous / next frame", "← →"],
    ["Back / forward 1s", "⇧← ⇧→"],
    ["Remove selected layer", "Delete"],
    ["Undo / redo", `${MOD}Z  ⇧${MOD}Z`],
    ["Save", `${MOD}S`],
    ["Snapping on / off", "S"],
    ["Disable snapping while dragging", "hold Alt"],
    ["Zoom timeline", `${MOD} + scroll`],
  ]);

  // ----- inspector -----
  const full = layers.length >= MAX_CLIP_LAYERS;
  const skipped = resolved.skipped.length;
  const inspector = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="text-[13px] font-bold">Layers{layers.length ? ` · ${layers.length}` : ""}</span>
        <span className="ml-auto text-[11px] text-ink3" title="Layers in this template">
          {layers.length}/{MAX_CLIP_LAYERS}
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-ghost text-xs" disabled={full} onClick={() => setPicker({ kind: "asset", t: clock.get() })}>
              <ImageIcon className="h-3.5 w-3.5" /> Image or video
            </button>
            <button className="btn-ghost text-xs" disabled={full} onClick={() => addTextLayer(clock.get())}>
              <Type className="h-3.5 w-3.5" /> Text
            </button>
            <button className="btn-ghost text-xs" disabled={full} onClick={() => setPicker({ kind: "audio", t: clock.get() })} title="Music under the whole clip, or a sound effect at the playhead">
              <MusicIcon className="h-3.5 w-3.5" /> Sound
            </button>
          </div>
          {layers.length === 0 && <p className="text-xs leading-snug text-ink2">A logo in the first seconds, a call to action at the end, a watermark or a music bed under the whole clip. Each layer has a timing, so the template fits a clip of any length.</p>}
          {[...layers]
            .sort((a, b) => (windows.get(a.id)?.[0] ?? Infinity) - (windows.get(b.id)?.[0] ?? Infinity) || a.id.localeCompare(b.id))
            .map((l) => (
              <TemplateLayerCard
                key={l.id}
                layer={l}
                window={windows.get(l.id) ?? null}
                len={len}
                asset={l.kind === "text" ? undefined : assetById(l.assetId)}
                selected={l.id === selectedLayer}
                loading={assetsLoading}
                onSelect={() => selectLayer(l.id)}
                onPatch={(patch, key) => patchLayer(l.id, patch, key)}
                onRemove={() => removeLayer(l.id)}
              />
            ))}
          <p className="text-[11px] leading-snug text-ink3">
            From the start and Before the end keep their seconds on every clip; Whole clip stretches; Proportional is a share of the clip. Change the preview length to see the template fit a shorter or longer clip. Drag a picture or text on the preview to move it, a block on the timeline to change its timing.
          </p>
        </div>
      </ScrollArea>
    </div>
  );

  // ----- preview -----
  const chip = "inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 text-xs text-ink";
  const canvasHeader = (
    <div className={`flex w-full flex-wrap items-center gap-2 ${compact ? "" : "min-h-9"}`}>
      <span className="text-xs font-semibold text-ink2">Preview length</span>
      <Segmented size="sm" value={previewSec} onChange={setPreviewSec} options={TEMPLATE_PREVIEW_SECONDS.map((s) => ({ value: s, label: `${s} s`, title: `Lay the template out on a ${s} s clip` }))} ariaLabel="Preview length" />
      {/* always present, so the count appearing never moves the controls */}
      <span className={`min-w-0 truncate text-xs ${skipped ? "text-warn" : "text-ink3"}`}>{skipped ? `▲ ${skipped} layer${skipped === 1 ? "" : "s"} left out at ${len} s` : ""}</span>
      <span className="flex-1" />
      <button className={chip} aria-pressed={safe} onClick={() => setSafe(!safe)} title="Show the TikTok safe zones">
        <Eye className="h-3.5 w-3.5" /> {safe ? "Safe zones" : "No safe zones"}
      </button>
    </div>
  );
  const preview = (
    <div className={`flex min-h-0 min-w-0 flex-col items-center gap-2.5 px-4 pb-3 pt-3.5 ${compact ? "" : "flex-1"}`}>
      <div className={`relative flex w-full justify-center ${compact ? "h-[min(62dvh,520px)]" : "min-h-0 flex-1"}`}>
        <LivePreview
          clock={clock}
          playing={playing}
          overlaysAt={overlaysAt}
          source={null}
          srcW={1080}
          srcH={1920}
          framing={FRAMING}
          style={STYLE}
          words={[]}
          selectedOverlay={selectedLayer}
          onOverlaySelect={selectLayer}
          onOverlayChange={(id, patch, key) => patchLayer(id, patch, key)}
          overlayMenu={overlayMenu}
          showSafeZones={safe}
          platform="tiktok"
          tag={`Template · ${len} s`}
        />
      </div>
    </div>
  );

  // ----- timeline -----
  const tbtn = "grid h-[34px] min-w-[34px] place-items-center rounded-[10px] border border-line bg-panel px-2 text-[13px] text-ink hover:bg-sunk";
  const abtn = "inline-flex h-[30px] items-center gap-1 rounded-[8px] border border-line bg-panel px-2 text-xs text-ink hover:bg-sunk disabled:cursor-not-allowed disabled:text-ink3 disabled:hover:bg-panel";
  const transport = (
    <>
      <button className={tbtn} onClick={() => (setPlaying(false), seek(clock.get() - FRAME))} title="Previous frame (←)" aria-label="Previous frame">
        ◀︎❙
      </button>
      <button className="grid h-[34px] w-[44px] place-items-center rounded-[10px] bg-ink text-bg" onClick={togglePlay} title="Play / pause (Space)" aria-label={playing ? "Pause" : "Play"}>
        {playing ? "❚❚" : "▶"}
      </button>
      <button className={tbtn} onClick={() => (setPlaying(false), seek(clock.get() + FRAME))} title="Next frame (→)" aria-label="Next frame">
        ❙▶︎
      </button>
      <ClockText clock={clock} len={len} />
    </>
  );
  const timeline = (
    <LiveTimeline
      key={len}
      clock={clock}
      sourceDuration={len}
      range={[0, len]}
      onRange={noop}
      onSeek={seek}
      words={[]}
      sceneCuts={[]}
      sections={sections}
      onSections={noop}
      onSplit={noop}
      onSetMode={noop}
      onMerge={noop}
      onResetLayout={noop}
      onUndo={history.undo}
      onRedo={history.redo}
      canUndo={history.canUndo}
      canRedo={history.canRedo}
      selected={null}
      onSelect={noop}
      detected={[]}
      toolbar={
        <button className={abtn} disabled={!selectedLayer} onClick={() => selectedLayer && removeLayer(selectedLayer)} title={selectedLayer ? "Remove the selected layer (Delete)" : "Select a layer first"}>
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </button>
      }
      transport={transport}
      snap={snap}
      onSnap={setSnap}
      compactHints={short || compact}
      layers={layerBlocks}
      selectedLayer={selectedLayer}
      onLayerSelect={selectLayer}
      onLayerChange={moveLayer}
      onLayerAdd={(t, kind) => {
        if (kind === "template") return; // a template inside a template: not a thing (the lane hides the item without onLayerTemplate)
        seek(t);
        if (kind === "text") addTextLayer(t);
        else setPicker({ kind, t });
      }}
      onLayerRemove={removeLayer}
    />
  );

  // ----- header -----
  const hb = "grid h-[34px] w-[34px] place-items-center rounded-[10px] border border-line bg-panel text-ink hover:bg-sunk disabled:cursor-not-allowed disabled:text-ink3 disabled:hover:bg-panel";
  const header = (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 sm:gap-3 sm:px-4">
      <button className="btn-quiet px-2" onClick={requestExit} title="Back to templates">
        <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Templates</span>
      </button>
      <div className="min-w-0 flex-1">
        <div className="hidden truncate text-[11px] text-ink3 sm:block">Layer template</div>
        <input
          className={`w-full max-w-[28rem] rounded-[6px] border border-transparent bg-transparent px-1 text-[15px] font-bold leading-tight text-ink outline-none hover:border-line focus:border-acc ${nameOk ? "" : "!border-err"}`}
          value={name}
          maxLength={120}
          placeholder="Template name"
          aria-label="Template name"
          aria-invalid={!nameOk}
          data-native-undo
          onChange={(e) => {
            const v = e.target.value;
            edit((d) => ({ ...d, name: v }), "name");
          }}
        />
      </div>
      <button className={hb} disabled={!history.canUndo} onClick={history.undo} title={`Undo (${MOD}Z)`} aria-label="Undo">
        <Undo2 className="h-4 w-4" />
      </button>
      <button className={hb} disabled={!history.canRedo} onClick={history.redo} title={`Redo (${MOD}⇧Z)`} aria-label="Redo">
        <Redo2 className="h-4 w-4" />
      </button>
      <span className={`hidden min-w-[6.5rem] whitespace-nowrap rounded-full px-2.5 py-1 text-center text-xs font-semibold md:inline ${dirty ? "bg-warn-soft" : "bg-ok-soft"}`}>{dirty ? "Unsaved" : "● Saved"}</span>
      <button className={`${hb} hidden sm:grid`} onClick={() => setKeysOpen(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
        <Keyboard className="h-4 w-4" />
      </button>
      <ThemeToggle className="hidden sm:inline-flex" />
      <button className="btn-primary min-w-[5.5rem] justify-center" disabled={busy || !dirty || !nameOk} onClick={() => void save()} title={nameOk ? `Save the template (${MOD}S)` : "Give the template a name first"}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        Save
      </button>
    </header>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      {compact ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col">
            <div className="px-4 pt-3">{canvasHeader}</div>
            {preview}
            <div className="border-y border-line bg-panel">{timeline}</div>
            <div className="flex h-[70dvh] flex-col bg-panel">{inspector}</div>
          </div>
        </ScrollArea>
      ) : (
        <div className="grid min-h-0 flex-1" style={{ gridTemplateColumns: "minmax(0,1fr) 380px", gridTemplateRows: "minmax(0,1fr) auto" }}>
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="shrink-0 px-4 pt-3">{canvasHeader}</div>
            {preview}
          </div>
          <div className="flex min-h-0 flex-col border-l border-line bg-panel">{inspector}</div>
          <div className="border-t border-line bg-panel" style={{ gridColumn: "1 / -1" }}>
            {timeline}
          </div>
        </div>
      )}

      <AssetFinderDialog
        open={picker?.kind === "asset"}
        onOpenChange={(o) => !o && setPicker(null)}
        title="Add to template"
        kinds={["video", "image"]}
        onPick={(a) => {
          rememberPick(a);
          addAssetLayer(a, picker?.t ?? clock.get());
        }}
      />
      <AssetFinderDialog
        open={picker?.kind === "audio"}
        onOpenChange={(o) => !o && setPicker(null)}
        title="Add a sound"
        kind="audio"
        onPick={(a) => {
          rememberPick(a);
          addSoundLayer(a, picker?.t ?? clock.get());
        }}
      />
      {audioLayers.map((m) => (
        <audio
          key={m.id}
          ref={(el) => {
            if (el) audioEls.current.set(m.id, el);
            else audioEls.current.delete(m.id);
          }}
          src={`/media/assets/${m.assetId}`}
          preload="auto"
          className="hidden"
        />
      ))}

      <Modal open={guard} onOpenChange={setGuard} title="Unsaved changes">
        <p className="text-sm leading-relaxed text-ink2">You have unsaved changes to this template.</p>
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button className="btn-ghost" onClick={() => setGuard(false)}>
            Keep editing
          </button>
          <button className="btn-danger" onClick={onExit}>
            Discard
          </button>
          <button
            className="btn-primary"
            disabled={busy || !nameOk}
            onClick={async () => {
              if (await save()) onExit();
            }}
          >
            Save &amp; leave
          </button>
        </div>
      </Modal>
      <ShortcutSheet open={keysOpen} onOpenChange={setKeysOpen} />
    </div>
  );
}
