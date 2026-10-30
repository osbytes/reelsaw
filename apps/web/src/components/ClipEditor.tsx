import { Fragment, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Undo2,
  Redo2,
  Keyboard,
  PanelLeft,
  Loader2,
  X,
  Link2,
  Plus,
  Trash2,
  Scissors,
  Eye,
  Type,
  Image as ImageIcon,
  Music as MusicIcon,
  LayoutTemplate,
  PencilLine,
  Crop,
  AlignCenterHorizontal,
  AlignCenterVertical,
  BringToFront,
  SendToBack,
  Copy,
  Maximize2,
} from "lucide-react";
import { useNavigate } from "react-router";
import * as Popover from "@radix-ui/react-popover";
import { useTRPC } from "../lib/trpc";
import { toast } from "sonner";
import { readHash, writeHash, linkWith, fmtSec } from "../lib/hash";
import { ScrollArea } from "./scroll-area";
import { scrollWithin } from "../lib/scroll";
import {
  VerticalPreview,
  OverlayMenuItem,
  OverlayMenuSeparator,
  safeZoneWarning,
  paneCrop,
  paneRect,
  paneAspect,
  PLATFORM_NAME,
  type Framing,
  type Platform,
  type PreviewLayout,
  type PreviewAssetOverlay,
  type PaneHit,
} from "./VerticalPreview";
import { CropDialog, type CropKey, type CropPaneOption } from "./CropDialog";
import {
  Timeline,
  normalizeSections,
  adjustLabel,
  MODE_LABEL,
  layoutLabel,
  SPLIT_SHORTCUT,
  type EditorSection,
  type BumperBlock,
  type BumperSlot,
  type LayerBlock,
} from "./Timeline";
import { Segmented, Modal, Kbd, Select, ConfirmDialog } from "./ui";
import {
  BumperSelects,
  ProjectBumpersModal,
  choicesFrom,
  clipBumpersFrom,
  useBumperLibrary,
  effectiveAsset,
  effectiveSeconds,
  type LibraryAsset,
} from "./BumperField";
import { ApplyTemplateDialog, SaveAsTemplateDialog, applyTemplateLocally, existingOnClip } from "./TemplatePicker";
import { AssetFinderDialog, type PickedAsset } from "./AssetFinder";
import { BumperCombobox, Thumb, clockText } from "./BumperCombobox";
import { loadTextFonts } from "../lib/fonts";
import { z } from "zod";
import { ThemeToggle } from "../App";
import { HeaderAlerts } from "./HeaderAlerts";
import { useDeletedToast } from "../lib/deletedToast";
import { useRestoreWindow } from "../lib/retention";
import { useLeaveGuard, useUnsavedFlag } from "../lib/unsaved";
import { reportClientError } from "../lib/diagnostics";
import { cutState, cutStateTitle } from "../lib/cutState";
import { useHistory } from "../lib/history";
import { createClock, useClock, type Clock } from "../lib/playback";
import { useShortcut, useShortcuts, useSheetKey } from "../lib/shortcuts";
import { ShortcutSheet } from "./ShortcutSheet";
import {
  defaultStyle,
  formatTime,
  resolveStyle,
  paneOf,
  withPane,
  hasAdjust,
  MAX_CLIP_LAYERS,
  TEXT_OVERLAY_DEFAULTS,
  ASSET_OVERLAY_DEFAULT_W,
  CLIP_AUDIO_DEFAULTS,
  SFX_AUDIO_DEFAULTS,
  audioLayerDefaultsFor,
  assetLayerDefaultsFor,
  isStickerAsset,
  clipLayers,
  clipLayerSchema,
  isVisualLayer,
  TEXT_FONTS,
  type AssetLayer,
  type AudioLayer,
  type TextLayer,
  type ClipLayer,
  type ClipDiagnostics,
  type ClipBumpers,
  type DetectedSegment,
  type LayoutSection,
  type PaneAdjust,
  type ProjectSettings,
  shiftRegion,
  regionLabel,
  layoutSectionSchema,
  projectDefaultSection,
  adjustOf,
  FULL_FRAME,
  layoutSeamY,
  mergeSeamRuns,
  type SeamRun,
  type ContentRegion,
  type SectionMode,
  type SourceOverlay,
  type Style,
  type StyleOverride,
  type TranscriptFlag,
  type TranscriptSegment,
  type Word,
} from "@reelsaw/shared";

export interface EditorClip {
  id: string;
  index: number;
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  startSec: number;
  endSec: number;
  layoutOverride: string | null;
  layout: string | null;
  layoutSections: LayoutSection[];
  layoutSegments: DetectedSegment[];
  style: StyleOverride | null;
  emphasis: string[];
  bumpers?: ClipBumpers | null;
  /** everything laid over or played under the clip (older rows: `overlays` + `audio`, read through clipLayers) */
  layers?: unknown;
  overlays?: unknown;
  audio?: unknown;
  status: string;
  diagnostics: ClipDiagnostics | null;
}

interface Props {
  projectId: string;
  projectTitle: string;
  clipCount: number;
  sourceVideoUrl: string;
  durationSec: number;
  srcW: number;
  srcH: number;
  settings: ProjectSettings;
  /** cleaned words (what captions say) */
  words: Word[];
  /** as-heard words, for the transcript and the hatched cuts on the timeline */
  rawWords: Word[];
  segments: TranscriptSegment[];
  flags: TranscriptFlag[];
  sceneCuts: number[];
  /** burned-in source text the render will blur / avoid (empty when the project keeps it) */
  overlays: SourceOverlay[];
  clip: EditorClip;
  /** live render progress for this clip, 0..1 */
  renderProgress?: number | undefined;
  onExit: () => void;
}

const FRAME = 1 / 30;
const MODES: SectionMode[] = ["auto", "face", "split", "stack", "fit", "center"];
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
type Tab = "captions" | "framing" | "layers" | "text" | "cuts" | "transcript";
const PANE_NAME = ["Top", "Bottom"] as const;
/** every optional field of a layout section, from the schema: the saved form and the change check cover them all */
const SECTION_FIELDS = (Object.keys(layoutSectionSchema.shape) as Array<keyof LayoutSection>).filter(
  (k): k is Exclude<keyof LayoutSection, "start" | "end" | "mode"> => k !== "start" && k !== "end" && k !== "mode",
);
const newLayerId = () => `ly-${Math.random().toString(36).slice(2, 6)}`;
/** shortest a layer may be: pictures and text 0.1 s, sounds 0.5 s */
const layerMin = (l: Pick<ClipLayer, "kind">) => (l.kind === "audio" ? 0.5 : 0.1);
/** a library row as the editor reads it: the list also carries the mime type */
type LayerAsset = LibraryAsset;
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
/** GIF / animated WebP / video: a picture that moves, so it can repeat inside its window */
const isAnimatedAsset = (a: LayerAsset | undefined) => !!a && (a.kind === "video" || a.mime === "image/gif" || a.mime === "image/webp");
/** a short or sfx-tagged sound gets the one-shot treatment */
const isSoundEffect = (a: LayerAsset | undefined) => !!a && audioLayerDefaultsFor({ durationSec: a.durationSec }) === SFX_AUDIO_DEFAULTS;
type LayerPatch = Partial<Omit<AssetLayer, "kind"> & Omit<TextLayer, "kind"> & Omit<AudioLayer, "kind">>;
/** Layers clamped to the clip; one that no longer fits is dropped (a retrim past it). */
const clampLayers = (list: ClipLayer[], r: [number, number]): ClipLayer[] =>
  list.map((l) => ({ ...l, start: Math.max(r[0], l.start), end: Math.min(r[1], l.end) })).filter((l) => l.end - l.start >= layerMin(l));
type Layout = "classic" | "transcript";
const LAYOUT_KEY = "rs-editor-layout";
const SNAP_KEY = "rs-editor-snap";
/** the editor's own clipboard (⌘C / ⌘V on a layer), shared by every editor tab of this browser */
const CLIP_KEY = "rs-editor-clipboard";
/** the clipboard holds a layer; items copied before layers existed ("overlay" / "music") are read through clipLayers */
function readClipboardLayer(raw: string): ClipLayer | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  const item = z.object({ kind: z.string(), value: z.unknown() }).safeParse(v);
  if (!item.success) return null;
  if (item.data.kind === "layer") {
    const l = clipLayerSchema.safeParse(item.data.value);
    return l.success ? l.data : null;
  }
  if (item.data.kind === "overlay") return clipLayers({ overlays: [item.data.value] })[0] ?? null;
  if (item.data.kind === "music") return clipLayers({ audio: [item.data.value] })[0] ?? null;
  return null;
}

interface EditorDoc {
  range: [number, number];
  sections: EditorSection[];
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  style: Style;
  emphasis: string[];
  /** this clip's own intro/outro: missing key = the project's, null = none */
  bumpers: ClipBumpers;
  /** everything laid over or played under the clip (images, video, text, music, sounds), absolute source seconds */
  layers: ClipLayer[];
}

const MODE_EXPLAIN: Record<string, string> = {
  face: "9:16 crop that follows whoever is talking.",
  split: "Two speakers, one above the other.",
  stack: "Whole frame on top, speaker zoomed below. For screen shares with a webcam.",
  fit: "Whole frame over a blurred background. For slides, b-roll and wide shots.",
  center: "Static centre crop.",
};

/** Forced sections from the DB + auto in the gaps, covering the clip; a clip with none gets the project's framing. */
function initialSections(clip: EditorClip, range: [number, number], settings: ProjectSettings): EditorSection[] {
  if (clip.layoutSections.length) {
    const forced = [...clip.layoutSections].sort((a, b) => a.start - b.start);
    const out: EditorSection[] = [];
    let t = range[0];
    for (const s of forced) {
      if (s.start > t + 0.05) out.push({ start: t, end: s.start, mode: "auto" });
      out.push({ ...s });
      t = Math.max(t, s.end);
    }
    if (t < range[1] - 0.05) out.push({ start: t, end: range[1], mode: "auto" });
    return normalizeSections(out, range);
  }
  if (clip.layoutOverride && clip.layoutOverride !== "auto")
    return [{ start: range[0], end: range[1], mode: (clip.layoutOverride === "none" ? "fit" : clip.layoutOverride) as SectionMode }];
  return [projectDefaultSection(settings, range[0], range[1])];
}

function parseTime(v: string): number | null {
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}
function fmtPrecise(t: number) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

function TimeField({ value, onCommit, label }: { value: number; onCommit: (t: number) => void; label: string }) {
  const [text, setText] = useState(fmtPrecise(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmtPrecise(value));
  }, [value, focused]);
  const commit = () => {
    const t = parseTime(text);
    if (t !== null) onCommit(t);
    else setText(fmtPrecise(value));
  };
  return (
    <input
      aria-label={label}
      data-native-undo
      className="w-[74px] rounded-[8px] border border-line bg-panel px-1.5 py-1 text-center font-mono text-xs text-ink outline-none focus:border-acc"
      value={text}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          onCommit(value + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 1 : 0.1));
        }
      }}
    />
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
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? "bg-acc" : "bg-line2"}`}
      >
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
          style={{
            background: c,
            border: on(c) ? "2px solid var(--ink)" : "2px solid var(--line)",
            outline: on(c) ? "2px solid var(--panel)" : "none",
            outlineOffset: -4,
          }}
        />
      ))}
      <label
        className="relative grid h-[30px] w-[30px] cursor-pointer place-items-center rounded-full border-2 border-dashed border-line2 text-xs text-ink3"
        title="Custom colour"
      >
        +
        <input type="color" className="absolute inset-0 cursor-pointer opacity-0" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      </label>
    </div>
  );
}

const HL = ["#C6A8FF", "#FFD84D", "#5EE0A0", "#FFFFFF"];
const KW = ["#FFD84D", "#FF8A5C", "#5EE0A0", "#C6A8FF"];
const TEXT_COLORS = ["#FFFFFF", "#FFD84D", "#5EE0A0", "#C6A8FF", "#FF8A5C", "#000000"];
/** text overlay sizes as fractions of the frame height (the default is M) */
const TEXT_SIZES: Array<{ v: number; l: string }> = [
  { v: 0.032, l: "S" },
  { v: 0.045, l: "M" },
  { v: 0.065, l: "L" },
];
const SIZES: Array<{ v: number; l: string }> = [
  { v: 0.8, l: "S" },
  { v: 1, l: "M" },
  { v: 1.25, l: "L" },
];

/**
 * One layer in the inspector, whatever its kind: the header (what it is, remove), the fields of its kind,
 * and the time fields every layer shares.
 */
function LayerCard({
  layer: l,
  asset,
  selected,
  rangeStart,
  rangeEnd,
  loading,
  onSelect,
  onPatch,
  onRemove,
}: {
  layer: ClipLayer;
  asset: LayerAsset | undefined;
  selected: boolean;
  rangeStart: number;
  rangeEnd: number;
  loading: boolean;
  onSelect: () => void;
  onPatch: (patch: LayerPatch, key?: string) => void;
  onRemove: () => void;
}) {
  const min = layerMin(l);
  const removed = loading ? "…" : "Deleted from the library";
  const kindLabel = l.kind === "text" ? "text" : l.kind === "audio" ? (isSoundEffect(asset) ? "Sound effect" : "Music") : (asset?.kind ?? "image");
  const sizeIdx = l.kind === "text" ? TEXT_SIZES.findIndex((sz) => Math.abs(sz.v - (l.size ?? TEXT_OVERLAY_DEFAULTS.size)) < 0.004) : -1;
  const pct = (v: number) => Math.round(v * 100);
  const opacityField = (aria: string) => {
    const o = l.kind === "audio" ? 1 : (l.opacity ?? 1);
    return (
      <Field label="Opacity" hint={<span className="font-mono">{pct(o)}%</span>}>
        <input
          type="range"
          min={10}
          max={100}
          step={5}
          value={pct(o)}
          onChange={(e) => onPatch({ opacity: Number(e.target.value) === 100 ? undefined : Number(e.target.value) / 100 }, `ly-o-${l.id}`)}
          className="accent-[var(--acc)]"
          aria-label={aria}
        />
      </Field>
    );
  };
  return (
    <div
      data-layer-card={l.id}
      onClick={onSelect}
      className={`flex cursor-pointer flex-col gap-2 rounded-[12px] p-2.5 ${selected ? "border-2 border-acc" : "border border-line"}`}
    >
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
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => onPatch({ text: e.target.value }, `ly-t-${l.id}`)}
            />
          ) : (
            <span className="block truncate text-[13px] font-semibold">{asset?.name ?? removed}</span>
          )}
          <span className="block font-mono text-[11px] text-ink3">
            {fmtPrecise(l.start - rangeStart)}–{fmtPrecise(l.end - rangeStart)} · {kindLabel}
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
      {l.kind === "text" && (
        <div className="flex flex-col gap-3" onClick={(e) => e.stopPropagation()}>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Size">
              <Segmented
                size="sm"
                value={sizeIdx >= 0 ? TEXT_SIZES[sizeIdx]!.v : -1}
                onChange={(v) => onPatch({ size: v })}
                options={TEXT_SIZES.map((sz) => ({ value: sz.v, label: sz.l }))}
                ariaLabel="Text size"
              />
            </Field>
            {opacityField("Text opacity")}
          </div>
          <Field label="Font">
            <Select
              size="sm"
              ariaLabel="Text font"
              value={l.font ?? TEXT_FONTS[0].family}
              onValueChange={(v) => onPatch({ font: v === TEXT_FONTS[0].family ? undefined : v })}
              options={TEXT_FONTS.map((f) => ({ value: f.family, label: f.label }))}
            />
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
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={pct(l.x)}
                onChange={(e) => onPatch({ x: Number(e.target.value) / 100 }, `ly-x-${l.id}`)}
                className="accent-[var(--acc)]"
                aria-label="Layer position across"
              />
            </Field>
            <Field label="Up / down" hint={<span className="font-mono">{pct(l.y)}%</span>}>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={pct(l.y)}
                onChange={(e) => onPatch({ y: Number(e.target.value) / 100 }, `ly-y-${l.id}`)}
                className="accent-[var(--acc)]"
                aria-label="Layer position down"
              />
            </Field>
            <Field label="Width" hint={<span className="font-mono">{pct(l.w ?? ASSET_OVERLAY_DEFAULT_W)}%</span>}>
              <input
                type="range"
                min={5}
                max={100}
                step={1}
                value={pct(l.w ?? ASSET_OVERLAY_DEFAULT_W)}
                onChange={(e) => onPatch({ w: Number(e.target.value) / 100 }, `ly-w-${l.id}`)}
                className="accent-[var(--acc)]"
                aria-label="Layer width"
              />
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
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={pct(l.volume ?? CLIP_AUDIO_DEFAULTS.volume)}
                onChange={(e) => onPatch({ volume: Number(e.target.value) / 100 }, `ly-vol-${l.id}`)}
                className="accent-[var(--acc)]"
                aria-label="Sound level"
              />
            </Field>
            <Field label="Fade in / out" hint={<span className="font-mono">{(l.fade ?? CLIP_AUDIO_DEFAULTS.fade).toFixed(1)}s</span>}>
              <input
                type="range"
                min={0}
                max={5}
                step={0.5}
                value={l.fade ?? CLIP_AUDIO_DEFAULTS.fade}
                onChange={(e) => onPatch({ fade: Number(e.target.value) }, `ly-fade-${l.id}`)}
                className="accent-[var(--acc)]"
                aria-label="Sound fade"
              />
            </Field>
          </div>
          <Switch checked={l.duck ?? CLIP_AUDIO_DEFAULTS.duck} onChange={(v) => onPatch({ duck: v })} label="Lower it while someone speaks" />
          <Switch checked={l.loop ?? CLIP_AUDIO_DEFAULTS.loop} onChange={(v) => onPatch({ loop: v })} label="Repeat if it is shorter than its window" />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs" onClick={(e) => e.stopPropagation()}>
        <span className="text-ink3">From</span>
        <TimeField label="Layer start" value={l.start - rangeStart} onCommit={(t) => onPatch({ start: Math.min(l.end - min, rangeStart + Math.max(0, t)) })} />
        <span className="text-ink3">to</span>
        <TimeField label="Layer end" value={l.end - rangeStart} onCommit={(t) => onPatch({ end: Math.max(l.start + min, rangeStart + t) })} />
        {l.kind === "audio" && (
          <>
            <span className="text-ink3">· track from</span>
            <TimeField label="Seconds into the track" value={l.offset ?? 0} onCommit={(t) => onPatch({ offset: Math.max(0, t) })} />
          </>
        )}
        <button
          className="btn-ghost px-2 py-0.5 text-xs"
          onClick={() => onPatch({ start: rangeStart, end: rangeEnd })}
          title={l.kind === "audio" ? "Play under the whole clip" : "Show it for the whole clip"}
        >
          Whole clip
        </button>
      </div>
    </div>
  );
}

/** The timeline with a per-frame playhead; the rest of the editor does not follow the clock. */
function LiveTimeline({ clock, ...props }: Omit<ComponentProps<typeof Timeline>, "current"> & { clock: Clock }) {
  return <Timeline {...props} current={useClock(clock)} />;
}

/** The 9:16 preview, re-rendered per frame on its own (framing and caption time follow the clock). */
function LivePreview({
  clock,
  framingAt,
  assetOverlaysAt,
  rangeStart,
  playing,
  ...props
}: Omit<ComponentProps<typeof VerticalPreview>, "framing" | "time" | "assetOverlays"> & {
  clock: Clock;
  framingAt: (t: number) => Framing;
  assetOverlaysAt: (t: number) => PreviewAssetOverlay[];
  rangeStart: number;
  playing: boolean;
}) {
  const t = useClock(clock);
  const framing = useMemo(() => framingAt(t), [framingAt, t]);
  const assetOverlays = useMemo(() => assetOverlaysAt(t), [assetOverlaysAt, t]);
  return <VerticalPreview {...props} framing={framing} assetOverlays={assetOverlays} time={t - rangeStart} playing={playing} />;
}

/**
 * Full-screen clip editor: live 9:16 preview of the source with the clip's framing and captions,
 * inspector tabs (captions, framing, text, cuts, transcript) and a multi-lane timeline. Every edit is
 * one undoable document; saving keeps you here so the re-render can be watched.
 */
export function ClipEditor(props: Props) {
  const {
    projectId,
    projectTitle,
    clipCount,
    sourceVideoUrl,
    durationSec,
    srcW,
    srcH,
    settings,
    words,
    rawWords,
    segments,
    flags,
    sceneCuts,
    overlays,
    clip,
    renderProgress,
    onExit,
  } = props;
  const trpc = useTRPC();
  const qc = useQueryClient();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const projectStyle = useMemo(() => resolveStyle(settings), [settings]);
  const history = useHistory<EditorDoc>(() => ({
    range: [clip.startSec, clip.endSec],
    sections: initialSections(clip, [clip.startSec, clip.endSec], settings),
    title: clip.title,
    hook: clip.hook,
    caption: clip.caption,
    hashtags: clip.hashtags,
    style: resolveStyle(settings, clip.style),
    emphasis: clip.emphasis,
    bumpers: clip.bumpers ?? {},
    layers: clipLayers(clip),
  }));
  const { range, sections, title, hook, caption, hashtags, style, emphasis, bumpers, layers } = history.state;
  const navigate = useNavigate();
  const [bumpersDialog, setBumpersDialog] = useState(false);
  // the intro / outro this clip renders with (its own choice, else the project's), as "Save as template" keeps them
  const templateBumpers = useMemo((): ClipBumpers | null => {
    const slot = (s: "intro" | "outro") => {
      const own = bumpers[s];
      const id = effectiveAsset(own, s === "intro" ? settings.introAssetId : settings.outroAssetId);
      if (!id) return {};
      const sec = own !== undefined ? bumpers[`${s}Sec`] : s === "intro" ? settings.introSec : settings.outroSec;
      return { [s]: id, ...(sec !== undefined ? { [`${s}Sec`]: sec } : {}) };
    };
    const b: ClipBumpers = { ...slot("intro"), ...slot("outro") };
    return Object.keys(b).length ? b : null;
  }, [bumpers, settings.introAssetId, settings.outroAssetId, settings.introSec, settings.outroSec]);
  /** the crop dialog: which section and which of its crops it opened on */
  const [cropDialog, setCropDialog] = useState<{ section: number; key: CropKey } | null>(null);
  /** the section whose framing is about to become the project's (confirm first: every clip re-renders) */
  const [applyAll, setApplyAll] = useState<number | null>(null);
  const [selectedLayer, setSelectedLayerRaw] = useState<string | null>(null);
  const [selectedBumper, setSelectedBumperRaw] = useState<BumperSlot | null>(null);
  // the text-overlay fonts, from the server image, so the preview shows the real faces
  useEffect(() => loadTextFonts(), []);
  // selecting a block on the timeline brings its card into view in the Layers pane (after a tab switch renders it)
  useEffect(() => {
    if (!selectedLayer) return;
    const id = requestAnimationFrame(() =>
      document.querySelector(`[data-layer-card="${selectedLayer}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
    return () => cancelAnimationFrame(id);
  }, [selectedLayer]);
  /** the asset or sound picker: what is being added and where the playhead was when it was asked for */
  const [picker, setPicker] = useState<{ kind: "asset" | "audio"; t: number } | null>(null);
  // templates: a set of layers laid onto this clip (into the document, undoable), or this clip's layers saved as one
  const [templateOpen, setTemplateOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const library = useBumperLibrary();
  const [imported, setImported] = useState<LibraryAsset[]>([]);
  const ownAssets = useMemo(() => [...(library.data?.assets ?? []), ...(library.data?.deleted ?? [])], [library.data]);
  const wantedIds = useMemo(() => {
    const ids = [
      ...layers.flatMap((l) => (l.kind === "text" ? [] : [l.assetId])),
      effectiveAsset(bumpers.intro, settings.introAssetId),
      effectiveAsset(bumpers.outro, settings.outroAssetId),
    ].filter((id): id is string => !!id);
    return [...new Set(ids)];
  }, [layers, bumpers, settings.introAssetId, settings.outroAssetId]);
  const haveIds = useMemo(() => new Set([...ownAssets, ...imported].map((a) => a.id)), [ownAssets, imported]);
  const missingIds = useMemo(() => wantedIds.filter((id) => !haveIds.has(id)).sort(), [wantedIds, haveIds]);
  const extra = useQuery({ ...trpc.library.get.queryOptions({ ids: missingIds }), enabled: missingIds.length > 0 });
  const libraryAssets = useMemo(() => {
    const map = new Map<string, LibraryAsset>();
    for (const a of [...ownAssets, ...imported, ...(extra.data?.assets ?? [])]) map.set(a.id, a);
    return [...map.values()];
  }, [ownAssets, imported, extra.data]);
  const assetById = (id: string | null | undefined): LibraryAsset | undefined => (id ? libraryAssets.find((a) => a.id === id) : undefined);
  const assetsLoading = library.isPending || (missingIds.length > 0 && extra.isPending);
  const rememberPick = (a: PickedAsset) => setImported((prev) => (prev.some((x) => x.id === a.id) ? prev : [...prev, layerAssetFromPick(a)]));
  const edit = (patch: Partial<EditorDoc> | ((d: EditorDoc) => Partial<EditorDoc>), key?: string) =>
    history.set((d) => ({ ...d, ...(typeof patch === "function" ? patch(d) : patch) }), key);
  const setStyle = (patch: Partial<Style>, key?: string) => edit((d) => ({ style: { ...d.style, ...patch } }), key);
  const [selected, setSelectedRaw] = useState<number | null>(null);
  // one selection at a time: a section, a layer or an intro/outro block
  const setSelected = (i: number | null) => {
    setSelectedRaw(i);
    if (i !== null) {
      setSelectedLayerRaw(null);
      setSelectedBumperRaw(null);
    }
  };
  const setSelectedLayer = (id: string | null) => {
    setSelectedLayerRaw(id);
    if (id !== null) {
      setSelectedRaw(null);
      setSelectedBumperRaw(null);
    }
  };
  const setSelectedBumper = (slot: BumperSlot | null) => {
    setSelectedBumperRaw(slot);
    if (slot !== null) {
      setSelectedRaw(null);
      setSelectedLayerRaw(null);
    }
  };
  useEffect(() => {
    if (selected !== null && selected >= sections.length) setSelectedRaw(sections.length - 1);
  }, [sections.length, selected]);
  useEffect(() => {
    if (selectedLayer && !layers.some((l) => l.id === selectedLayer)) setSelectedLayerRaw(null);
  }, [layers, selectedLayer]);
  const [styleScope, setStyleScope] = useState<"clip" | "all">("clip");
  const [playing, setPlaying] = useState(false);
  // `current` follows timeupdate (~4 Hz) and seeks; `clock` is the per-frame position, read only by
  // the timeline playhead and the preview so the rest of the editor does not re-render at 60 Hz
  const [current, setCurrent] = useState(clip.startSec);
  const clock = useMemo(() => createClock(clip.startSec), []);
  const [buffering, setBuffering] = useState(true);
  // deep link: #tab=<tab>&t=<seconds into the clip>
  const TABS: Tab[] = ["captions", "framing", "layers", "text", "cuts", "transcript"];
  const [tab, setTab] = useState<Tab>(() => {
    const raw = readHash().get("tab");
    const h = (raw === "overlays" ? "layers" : raw) as Tab | null; // old deep links
    return h && TABS.includes(h) ? h : "captions";
  });
  useEffect(() => writeHash({ tab: tab === "captions" ? null : tab }), [tab]);
  const [safe, setSafe] = useState(true);
  const [platform, setPlatform] = useState<Platform>("tiktok");
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
  const [kwDraft, setKwDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [keysOpen, setKeysOpen] = useState(false);
  const [txSel, setTxSel] = useState<{ start: number; end: number } | null>(null);
  const [layout, setLayoutRaw] = useState<Layout>(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === "transcript" ? "transcript" : "classic";
    } catch {
      return "classic";
    }
  });
  const setLayout = (l: Layout) => {
    setLayoutRaw(l);
    try {
      localStorage.setItem(LAYOUT_KEY, l);
    } catch {
      /* private mode */
    }
    if (l === "transcript" && tab === "transcript") setTab("captions");
  };
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  const compact = size.w < 900;
  const short = !compact && size.h < 720;
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const update = useMutation(trpc.clips.update.mutationOptions());
  const setSourceText = useMutation(trpc.projects.setSourceText.mutationOptions());
  const updateStyle = useMutation(trpc.projects.updateStyle.mutationOptions());
  const applyFraming = useMutation(trpc.projects.applyFraming.mutationOptions());
  const delClip = useMutation(trpc.clips.delete.mutationOptions());
  const notifyDeleted = useDeletedToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const keepWindow = useRestoreWindow("clip", confirmDelete);

  const setRange = (r: [number, number], key?: string) => {
    const a = Math.max(0, Number(r[0].toFixed(2)));
    const b = Math.min(durationSec || Infinity, Number(r[1].toFixed(2)));
    if (b - a < 3) return;
    edit((d) => ({ range: [a, b], sections: normalizeSections(d.sections, [a, b]), layers: clampLayers(d.layers, [a, b]) }), key);
  };
  const setSections = (s: EditorSection[], key?: string) => edit((d) => ({ sections: normalizeSections(s, d.range) }), key);

  // media listeners once; read the live range through a ref
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    setVideoEl(v);
    const onTime = (coarse = true) => {
      clock.set(v.currentTime);
      if (coarse) setCurrent(v.currentTime);
      const [a, b] = rangeRef.current;
      if (!v.paused && v.currentTime >= b) {
        v.pause();
        v.currentTime = a;
      }
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onWaiting = () => setBuffering(true);
    const onReady = () => setBuffering(false);
    const onMeta = () => {
      const t = Number(readHash().get("t"));
      const [a, b] = rangeRef.current;
      v.currentTime = Number.isFinite(t) && t > 0 ? Math.min(b - 0.05, a + t) : a;
    };
    const evs: Array<[string, () => void]> = [
      ["timeupdate", () => onTime()],
      ["play", onPlay],
      ["pause", onPause],
      ["waiting", onWaiting],
      ["seeking", onWaiting],
      ["canplay", onReady],
      ["seeked", onReady],
      ["loadedmetadata", onMeta],
    ];
    for (const [n, f] of evs) v.addEventListener(n, f);
    if (v.readyState >= 1) onMeta();
    let raf = 0;
    const tick = () => {
      if (!v.paused) onTime(false);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const [n, f] of evs) v.removeEventListener(n, f);
    };
  }, []);

  useEffect(() => {
    if (playing) return;
    const id = setTimeout(() => writeHash({ t: current > range[0] + 0.05 ? fmtSec(current - range[0]) : null }), 400);
    return () => clearTimeout(id);
  }, [current, playing, range]);
  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, t);
    clock.set(Math.max(0, t));
    setCurrent(Math.max(0, t));
    setSelectedBumperRaw(null);
  };
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    setSelectedBumperRaw(null);
    if (v.paused) {
      if (v.currentTime < range[0] - 0.05 || v.currentTime >= range[1] - 0.05) v.currentTime = range[0];
      v.play().catch((err) => reportClientError("error", err));
    } else v.pause();
  };
  const setIn = (t: number) => setRange([Math.min(t, range[1] - 1), range[1]]);
  const setOut = (t: number) => setRange([range[0], Math.max(t, range[0] + 1)]);
  const splitAt = (t: number) => {
    if (t <= range[0] + 0.5 || t >= range[1] - 0.5) return void toast("Move the playhead inside the clip to split");
    if (sections.some((s) => Math.abs(s.start - t) < 0.5 && s.start > range[0])) return void toast("Too close to an existing transition");
    const i = sections.findIndex((s) => t > s.start && t < s.end);
    if (i < 0) return;
    const s = sections[i]!;
    setSections([...sections.slice(0, i), { ...s, end: t }, { ...s, start: t }, ...sections.slice(i + 1)]);
    setSelected(i + 1);
    toast(`Split at ${fmtPrecise(t - range[0])}`);
  };
  /** Remove the transition on one side of section i: it absorbs into that neighbour, which keeps its framing. */
  const mergeSection = (i: number, side: "left" | "right") => {
    if (sections.length < 2) return;
    const next = sections.map((s) => ({ ...s }));
    if (side === "left" && i > 0) {
      next[i - 1]!.end = next[i]!.end;
      next.splice(i, 1);
      setSelected(i - 1);
    } else if (side === "right" && i < next.length - 1) {
      next[i + 1]!.start = next[i]!.start;
      next.splice(i, 1);
      setSelected(i);
    } else return;
    setSections(next);
  };
  const setMode = (i: number, mode: SectionMode) => setSections(sections.map((s, j) => (j === i ? { ...s, mode } : s)));
  /** Back to what the project gives every clip (automatic, unless a framing was applied to the project). */
  const resetLayout = () => {
    setSections([projectDefaultSection(settings, range[0], range[1])]);
    setSelected(null);
  };
  /** The project's framing as this clip would show it: the baseline a clip without sections of its own compares against. */
  const projectDefault = projectDefaultSection(settings, range[0], range[1]);
  const projectFramed = projectDefault.mode !== "auto" || hasAdjust(projectDefault);

  // framing at the playhead: forced section → that layout; auto → what the last render detected there.
  const secIdx = Math.max(
    0,
    sections.findLastIndex((s) => current >= s.start - 0.02),
  );
  const framingAt = useMemo(
    () =>
      (t: number): Framing => {
        const sec =
          sections[
            Math.max(
              0,
              sections.findLastIndex((s) => t >= s.start - 0.02),
            )
          ] ?? sections[0]!;
        const det = clip.layoutSegments.find((d) => t >= d.start && t < d.end) ?? clip.layoutSegments.find((d) => !d.manual);
        const fallback: PreviewLayout = clip.layout && clip.layout !== "mixed" ? (clip.layout as PreviewLayout) : "fit";
        const lay: PreviewLayout = sec.mode === "auto" ? (det && !det.manual ? det.layout : fallback) : sec.mode;
        const clamp = (v: number) => Math.max(0, Math.min(1, v));
        const at = (tr: Array<[number, number]> | undefined): number | undefined => {
          if (!tr?.length) return undefined;
          const k = tr.findIndex(([pt]) => pt > t);
          if (k <= 0) return tr[k === 0 ? 0 : tr.length - 1]![1];
          const [t0, x0] = tr[k - 1]!;
          const [t1, x1] = tr[k]!;
          return x0 + ((x1 - x0) * (t - t0)) / Math.max(0.01, t1 - t0);
        };
        // what the last render followed in each pane, with the adjustments it applied taken back out
        const rendered = (pane: 0 | 1) => {
          const off =
            pane === 0
              ? { x: det?.offsetX ?? 0, y: det?.offsetY ?? 0, subject: det?.subjectX }
              : { x: det?.offsetX2 ?? 0, y: det?.offsetY2 ?? 0, subject: det?.subjectX2 };
          const x = at(pane === 0 ? det?.track : det?.track2) ?? (pane === 0 ? det?.cx : det?.cx2);
          const y = pane === 0 ? det?.cy : det?.cy2;
          return x === undefined ? undefined : { x: x - off.x, y: (y ?? 0.45) - off.y, subject: off.subject };
        };
        // a pane's centre: the person it follows (the detector's pick, or the subject the user pointed at), then its offset
        const centre = (pane: 0 | 1): { x: number; y: number } => {
          const a = paneOf(sec, pane);
          const own = rendered(pane);
          // a split that has not been rendered yet has no second track: mirror the first speaker's spot for the bottom pane
          const first = rendered(0);
          let base = own ? { x: own.x, y: own.y } : pane === 1 ? { x: clamp(1 - (first?.x ?? 0.5)), y: first?.y ?? 0.45 } : { x: 0.5, y: 0.45 };
          if (a.subjectX !== undefined && (own?.subject === undefined || Math.abs(own.subject - a.subjectX) > 0.02)) {
            // not rendered with this subject yet: follow whichever rendered track is that person, else hold the spot
            const other = rendered(pane === 0 ? 1 : 0);
            const near = [own, other].find((c) => c && Math.abs(c.x - a.subjectX!) <= 0.12);
            base = near ? { x: near.x, y: near.y } : { x: a.subjectX, y: base.y };
          }
          if (lay === "center") base = { x: 0.5, y: base.y };
          return { x: clamp(base.x + (a.offsetX ?? 0)), y: clamp(base.y + (a.offsetY ?? 0)) };
        };
        const c1 = centre(0);
        const c2 = lay === "split" ? centre(1) : undefined;
        return {
          layout: lay,
          cx: c1.x,
          cy: c1.y,
          ...(c2 ? { cx2: c2.x, cy2: c2.y } : {}),
          ...(det?.size !== undefined ? { size: det.size } : {}),
          ...(det?.size2 !== undefined ? { size2: det.size2 } : {}),
          // a content region is an automatic choice; a section forced to Stack keeps the whole frame on top,
          // unless the speaker is a webcam tile in a band: the tile and its band are the speaker's own bounds and apply to a forced stack too.
          // The user's own top crop wins over both.
          ...(lay === "stack" && sec.contentCrop
            ? { content: sec.contentCrop }
            : lay === "stack" && det?.content && (det.tile || (sec.mode === "auto" && !det.manual))
              ? { content: det.content }
              : {}),
          // the tile is stored as detected; the pane's nudge moves its window, as in the render. A fixed crop replaces it.
          ...(lay === "stack" && det?.tile && !sec.crop ? { tile: shiftRegion(det.tile, paneOf(sec, 0).offsetX ?? 0, paneOf(sec, 0).offsetY ?? 0) } : {}),
          // crops the user fixed: the pane shows exactly that (`fitPane` in the render)
          ...(lay !== "none" && sec.crop ? { crop: sec.crop } : {}),
          ...(lay === "split" && sec.crop2 ? { crop2: sec.crop2 } : {}),
        };
      },
    [sections, clip.layoutSegments, clip.layout],
  );
  const framing = useMemo(() => framingAt(current), [framingAt, current]);
  // where each stretch's panes meet, on the clip's clock (the captions' clock): the preview puts caption lines there like the renderer
  const seams = useMemo((): SeamRun[] => {
    const runs: SeamRun[] = [];
    const step = 0.1;
    for (let t = range[0]; t < range[1]; t += step) {
      const f = framingAt(t);
      runs.push({ start: t - range[0], end: Math.min(range[1], t + step) - range[0], y: layoutSeamY(f.layout, f.content, srcW, srcH) });
    }
    return mergeSeamRuns(runs);
  }, [framingAt, range, srcW, srcH]);
  const autoChoiceFor = (s: EditorSection) =>
    [...new Set(clip.layoutSegments.filter((d) => !d.manual && d.end > s.start && d.start < s.end).map(layoutLabel))].join(" / ");

  const panKey = useRef<string>("");
  const setPane = (i: number, pane: 0 | 1, a: PaneAdjust, key?: string) =>
    setSections(
      sections.map((s, j) => (j === i ? withPane(s, pane, a) : s)),
      key,
    );
  /** Drag on a pane of the preview: nudge its offset, or move its fixed crop (one undo step per gesture). */
  const panPane = (pane: 0 | 1, dx: number, dy: number) => {
    const i = secIdx;
    const a = paneOf(sections[i]!, pane);
    if (!panKey.current) panKey.current = `g:pan-${i}-${pane}-${Date.now()}`;
    if (a.crop) {
      // a fixed crop is what shows: the drag moves the crop itself, inside the frame
      setPane(i, pane, { crop: shiftRegion(a.crop, dx, dy) }, panKey.current);
      return;
    }
    const r4 = (n: number) => Number(n.toFixed(4));
    setPane(
      i,
      pane,
      { ...a, offsetX: r4(Math.max(-0.5, Math.min(0.5, (a.offsetX ?? 0) + dx))), offsetY: r4(Math.max(-0.5, Math.min(0.5, (a.offsetY ?? 0) + dy))) },
      panKey.current,
    );
  };
  /**
   * Follow awareness: when the drag carried the pane so far that the face it followed left the crop,
   * the user meant "follow the person here", not "nudge": the drop point becomes the pane's subject
   * and the offset resets. A smaller drag stays an offset and keeps following the same person.
   */
  const panEnd = (pane: 0 | 1) => {
    const key = panKey.current;
    panKey.current = "";
    const i = secIdx;
    const s = sections[i]!;
    const a = paneOf(s, pane);
    if (!a.offsetX || a.crop) return;
    const f = framingAt(current);
    const half = paneCrop(f, srcW, srcH, pane).w / 2;
    if (Math.abs(a.offsetX) <= half * 0.85) return;
    const followed = (pane === 0 ? f.cx : (f.cx2 ?? f.cx)) - a.offsetX; // where the followed face sits
    const subjectX = Number(Math.max(0, Math.min(1, followed + a.offsetX)).toFixed(3));
    setPane(i, pane, { subjectX, offsetY: a.offsetY }, key);
    toast(`${f.layout === "split" ? PANE_NAME[pane] : "The crop"} now follows the person at ${Math.round(subjectX * 100)}% (re-render to track them)`);
  };
  const resetOffset = (i: number) =>
    setSections(
      sections.map((s, j) => {
        if (j !== i) return s;
        const { contentCrop: _top, ...rest } = withPane(withPane(s, 0, {}), 1, {});
        return rest;
      }),
    );
  const resetPane = (i: number, pane: 0 | 1) => setPane(i, pane, {});
  /** The layout a section shows: its mode, or what the render chose for an Auto section. */
  const layoutOf = (s: EditorSection, i: number): PreviewLayout =>
    s.mode === "auto"
      ? (clip.layoutSegments.find((d) => !d.manual && d.end > s.start && d.start < s.end)?.layout ?? (i === secIdx ? framing.layout : "fit"))
      : s.mode;
  /** How many crop panes a section has in the preview: 2 for a split, 0 for whole-frame (unless a crop was fixed on it), else 1. */
  const paneCount = (s: EditorSection, i: number): 0 | 1 | 2 => {
    const lay = layoutOf(s, i);
    return lay === "split" ? 2 : lay === "none" || (lay === "fit" && !s.crop) ? 0 : 1;
  };
  /** The crops the dialog can set on a section: one per pane, plus the top of a stack; fields start from what shows at the playhead. */
  const cropPanesFor = (i: number): CropPaneOption[] => {
    const s = sections[i]!;
    const lay = layoutOf(s, i);
    const f = i === secIdx ? framing : framingAt(Math.max(s.start, Math.min(s.end - 0.01, current)));
    const norm = (r: { x: number; y: number; w: number; h: number }): ContentRegion => ({
      x1: r.x / srcW,
      y1: r.y / srcH,
      x2: (r.x + r.w) / srcW,
      y2: (r.y + r.h) / srcH,
    });
    const auto = (pane: 0 | 1) => norm(paneRect({ ...f, crop: undefined, crop2: undefined }, srcW, srcH, pane));
    if (lay === "none") return [];
    if (lay === "split") {
      return [
        { key: "crop", name: PANE_NAME[0], aspect: paneAspect(f, srcW, srcH, 0), auto: auto(0), current: s.crop },
        { key: "crop2", name: PANE_NAME[1], aspect: paneAspect(f, srcW, srcH, 1), auto: auto(1), current: s.crop2 },
      ];
    }
    if (lay === "stack") {
      return [
        { key: "contentCrop", name: "Screen", aspect: paneAspect(f, srcW, srcH, "top"), auto: f.content ?? FULL_FRAME, current: s.contentCrop },
        { key: "crop", name: "Speaker", aspect: paneAspect(f, srcW, srcH, 0), auto: auto(0), current: s.crop },
      ];
    }
    return [{ key: "crop", name: "Crop", aspect: paneAspect(f, srcW, srcH, 0), auto: auto(0), current: s.crop }];
  };
  const openCrop = (i: number, key: CropKey = "crop") => {
    const panes = cropPanesFor(i);
    if (!panes.length) return void toast("This section shows the source as it is; pick a framing first");
    setCropDialog({ section: i, key: panes.some((p) => p.key === key) ? key : panes[0]!.key });
  };
  const applyCrop = (i: number, key: CropKey, region: ContentRegion | null) => {
    if (key === "contentCrop") {
      setSections(
        sections.map((s, j) => {
          if (j !== i) return s;
          const { contentCrop: _old, ...rest } = s;
          return region ? { ...rest, contentCrop: region } : rest;
        }),
      );
    } else setPane(i, key === "crop" ? 0 : 1, region ? { crop: region } : {});
    toast(region ? `Crop set · ${regionLabel(region)} (re-render to apply)` : "Crop back to automatic");
  };
  /** the preview's right-click menu on the picture: the crop of the pane under the pointer */
  const paneMenu = (hit: PaneHit) => {
    const i = secIdx;
    const s = sections[i]!;
    const key: CropKey = hit === "top" ? "contentCrop" : hit === 1 ? "crop2" : "crop";
    const lay = layoutOf(s, i);
    const name = hit === "top" ? "Screen" : lay === "split" ? PANE_NAME[hit] : lay === "stack" ? "Speaker" : "Crop";
    const fixed = key === "contentCrop" ? s.contentCrop : hit === 1 ? s.crop2 : s.crop;
    const adjusted =
      hit === "top"
        ? !!s.contentCrop
        : (() => {
            const a = paneOf(s, hit);
            return !!(a.offsetX || a.offsetY || a.subjectX !== undefined || a.crop);
          })();
    return (
      <>
        <OverlayMenuItem label={`${name}${fixed ? ` · ${regionLabel(fixed)}` : ""}`} disabled onSelect={() => {}} />
        <OverlayMenuSeparator />
        <OverlayMenuItem icon={<Crop className="h-3.5 w-3.5" />} label="Set crop…" onSelect={() => openCrop(i, key)} />
        <OverlayMenuItem
          label="Back to automatic"
          disabled={!adjusted}
          onSelect={() => (hit === "top" ? applyCrop(i, "contentCrop", null) : resetPane(i, hit))}
        />
      </>
    );
  };

  // ----- layers: images, video, text and sounds over / under the clip -----
  const audioLayers = useMemo(() => layers.filter((l): l is AudioLayer => l.kind === "audio"), [layers]);
  const setLayers = (list: ClipLayer[], key?: string) => edit((d) => ({ layers: clampLayers(list, d.range) }), key);
  const patchLayer = (id: string, patch: LayerPatch, key?: string) =>
    setLayers(
      layers.map((l) => (l.id === id ? ({ ...l, ...patch } as ClipLayer) : l)),
      key,
    );
  const layerWindow = (t: number, len: number): [number, number] => {
    const start = Number(Math.max(range[0], Math.min(range[1] - 0.5, t)).toFixed(2));
    return [start, Number(Math.min(range[1], start + len).toFixed(2))];
  };
  const pushLayer = (l: ClipLayer, note: string) => {
    if (layers.length >= MAX_CLIP_LAYERS) return void toast(`A clip can have at most ${MAX_CLIP_LAYERS} layers`);
    setLayers([...layers, l]);
    setSelectedLayer(l.id);
    if (current < l.start || current > l.end) seek(l.start);
    if (tab !== "layers" && tab !== "transcript") setTab("layers");
    toast(note);
  };
  type NewLayerAsset = Pick<LayerAsset, "id" | "name" | "kind" | "durationSec"> & { mime?: string | null | undefined; hasAudio?: boolean | undefined };
  const addAssetLayer = (asset: NewLayerAsset, t: number) => {
    const d = assetLayerDefaultsFor(asset);
    const [start, end] = layerWindow(t, Math.min(d.windowSec, range[1] - t));
    pushLayer(
      { id: newLayerId(), kind: "asset", assetId: asset.id, start, end, x: 0.5, y: d.y, w: d.w, ...(d.loop ? { loop: true } : {}) },
      `${asset.name} added ${isStickerAsset(asset) ? "as an overlay" : "as b-roll"} · drag it on the preview`,
    );
  };
  const addTextLayer = (t: number) => {
    const [start, end] = layerWindow(t, 4);
    pushLayer(
      { id: newLayerId(), kind: "text", text: "Your text", start, end, x: 0.5, y: 0.3, size: TEXT_OVERLAY_DEFAULTS.size, color: TEXT_OVERLAY_DEFAULTS.color },
      "Text added · type it in the Layers tab, drag it on the preview",
    );
  };
  const addSoundLayer = (asset: NewLayerAsset, t: number) => {
    const defaults = audioLayerDefaultsFor({ durationSec: asset.durationSec });
    const oneShot = defaults === SFX_AUDIO_DEFAULTS;
    // a one-shot sound lasts as long as the file; music starts at the playhead and runs to the end of the clip
    const [start, end] = oneShot ? layerWindow(t, Math.max(0.5, asset.durationSec)) : layerWindow(t, range[1] - t);
    pushLayer(
      {
        id: newLayerId(),
        kind: "audio",
        assetId: asset.id,
        start,
        end: oneShot ? end : range[1],
        volume: defaults.volume,
        duck: defaults.duck,
        fade: defaults.fade,
        loop: defaults.loop,
      },
      `${asset.name} plays from ${fmtPrecise(start - range[0])} · drag the block to move or shorten it`,
    );
  };
  const removeLayer = (id: string) => {
    setLayers(layers.filter((l) => l.id !== id));
    if (selectedLayer === id) setSelectedLayerRaw(null);
  };
  /** a copy right after the original, nudged so both show on the canvas */
  const duplicateLayer = (id: string) => {
    const i = layers.findIndex((l) => l.id === id);
    const l = layers[i];
    if (!l) return;
    if (layers.length >= MAX_CLIP_LAYERS) return void toast(`A clip can have at most ${MAX_CLIP_LAYERS} layers`);
    const copy: ClipLayer =
      l.kind === "audio" ? { ...l, id: newLayerId() } : { ...l, id: newLayerId(), x: Math.min(0.95, l.x + 0.04), y: Math.min(0.95, l.y + 0.04) };
    setLayers([...layers.slice(0, i + 1), copy, ...layers.slice(i + 1)]);
    setSelectedLayer(copy.id);
    toast("Duplicated");
  };
  /** layers are drawn in list order: last on top */
  const orderLayer = (id: string, where: "front" | "back") => {
    const l = layers.find((x) => x.id === id);
    if (!l) return;
    const rest = layers.filter((x) => x.id !== id);
    setLayers(where === "front" ? [...rest, l] : [l, ...rest]);
  };
  /** the canvas's right-click menu on a layer (the layer is selected by then) */
  const overlayMenu = (o: PreviewAssetOverlay, ctx: { editText: () => void }) => {
    const l = layers.find((x) => x.id === o.id);
    if (!l || l.kind === "audio") return null;
    const whole = l.start <= range[0] + 0.01 && l.end >= range[1] - 0.01;
    return (
      <>
        {o.kind === "text" && <OverlayMenuItem icon={<PencilLine className="h-3.5 w-3.5" />} label="Edit text" kbd="dbl-click" onSelect={ctx.editText} />}
        <OverlayMenuItem
          icon={<AlignCenterHorizontal className="h-3.5 w-3.5" />}
          label="Centre left / right"
          disabled={l.x === 0.5}
          onSelect={() => patchLayer(l.id, { x: 0.5 })}
        />
        <OverlayMenuItem
          icon={<AlignCenterVertical className="h-3.5 w-3.5" />}
          label="Centre up / down"
          disabled={l.y === 0.5}
          onSelect={() => patchLayer(l.id, { y: 0.5 })}
        />
        <OverlayMenuItem
          icon={<Maximize2 className="h-3.5 w-3.5" />}
          label="Show for the whole clip"
          disabled={whole}
          onSelect={() => patchLayer(l.id, { start: range[0], end: range[1] })}
        />
        {o.kind === "asset" && (
          <>
            <OverlayMenuSeparator />
            <OverlayMenuItem
              icon={<BringToFront className="h-3.5 w-3.5" />}
              label="Bring to front"
              disabled={layers[layers.length - 1]?.id === l.id}
              onSelect={() => orderLayer(l.id, "front")}
            />
            <OverlayMenuItem
              icon={<SendToBack className="h-3.5 w-3.5" />}
              label="Send to back"
              disabled={layers[0]?.id === l.id}
              onSelect={() => orderLayer(l.id, "back")}
            />
          </>
        )}
        <OverlayMenuSeparator />
        <OverlayMenuItem icon={<Copy className="h-3.5 w-3.5" />} label="Copy" kbd="⌘C" onSelect={() => copyLayer(l)} />
        <OverlayMenuItem icon={<Copy className="h-3.5 w-3.5" />} label="Duplicate" onSelect={() => duplicateLayer(l.id)} />
        <OverlayMenuItem icon={<Trash2 className="h-3.5 w-3.5" />} label="Remove" kbd="Delete" onSelect={() => removeLayer(l.id)} />
      </>
    );
  };
  const layerBlocks: LayerBlock[] = useMemo(
    () =>
      layers.map((l) => {
        if (l.kind === "text") return { id: l.id, start: l.start, end: l.end, name: l.text, kind: "text" as const };
        const a = assetById(l.assetId);
        const name = a?.name ?? (assetsLoading ? "…" : "deleted");
        if (l.kind === "audio") return { id: l.id, start: l.start, end: l.end, name, kind: "audio" as const };
        return {
          id: l.id,
          start: l.start,
          end: l.end,
          name,
          kind: isAnimatedAsset(a) ? ("video" as const) : ("image" as const),
          thumbnailUrl: a?.thumbnailUrl,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layers, libraryAssets, assetsLoading],
  );
  const previewOverlaysAt = (t: number): PreviewAssetOverlay[] =>
    layers
      .filter(isVisualLayer)
      .filter((l) => t >= l.start - 0.001 && t <= l.end + 0.001)
      .flatMap((l): PreviewAssetOverlay[] => {
        if (l.kind === "text")
          return [
            {
              kind: "text",
              id: l.id,
              text: l.text,
              x: l.x,
              y: l.y,
              size: l.size ?? TEXT_OVERLAY_DEFAULTS.size,
              color: l.color ?? TEXT_OVERLAY_DEFAULTS.color,
              box: !!l.box,
              opacity: l.opacity ?? 1,
              ...(l.font ? { font: l.font } : {}),
            },
          ];
        const a = assetById(l.assetId);
        if (!a) return [];
        // the file itself: a GIF/WebP as <img> (browsers loop them), a video (including Giphy GIF-as-mp4) as <video>
        const aspect = a.width > 0 && a.height > 0 ? a.width / a.height : 0;
        return [
          {
            kind: "asset",
            id: l.id,
            url: `/media/assets/${a.id}`,
            name: a.name,
            aspect,
            x: l.x,
            y: l.y,
            w: l.w ?? ASSET_OVERLAY_DEFAULT_W,
            opacity: l.opacity ?? 1,
            video: a.kind === "video",
            loop: l.loop ?? isStickerAsset(a),
            offsetSec: t - l.start,
          },
        ];
      });

  // the audio layers play along in the preview: one <audio> element per layer following the clock inside its window (no ducking)
  const audioEls = useRef(new Map<string, HTMLAudioElement>());
  useEffect(() => {
    for (const m of audioLayers) {
      const el = audioEls.current.get(m.id);
      if (el) el.volume = Math.max(0, Math.min(1, m.volume ?? CLIP_AUDIO_DEFAULTS.volume));
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
          const len = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : Infinity;
          const at = m.loop === false ? want : want % len;
          if (Math.abs(el.currentTime - at) > 0.35) el.currentTime = at;
          if (el.paused && (m.loop !== false || want < len)) el.play().catch(() => {});
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

  // ----- copy / paste of the selected layer (⌘C / ⌘V), also across clips of this browser -----
  const copySelection = () => {
    const l = selectedLayer ? layers.find((x) => x.id === selectedLayer) : undefined;
    return l ? copyLayer(l) : false;
  };
  const copyLayer = (l: ClipLayer) => {
    try {
      localStorage.setItem(CLIP_KEY, JSON.stringify({ kind: "layer", value: l }));
    } catch {
      /* private mode */
    }
    toast(`Copied ${l.kind === "text" ? `“${l.text}”` : l.kind === "audio" ? "the sound" : "the layer"} · ⌘V pastes it at the playhead`);
    return true;
  };
  const pasteSelection = () => {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(CLIP_KEY);
    } catch {
      /* private mode */
    }
    if (!raw) return false;
    const l = readClipboardLayer(raw);
    if (!l) return false;
    const t = Math.max(range[0], Math.min(range[1] - 0.5, current));
    const len = l.end - l.start;
    pushLayer({ ...l, id: newLayerId(), start: Number(t.toFixed(2)), end: Number(Math.min(range[1], t + len).toFixed(2)) }, "Pasted at the playhead");
    return true;
  };
  /** "Browse library…" in the + menu: the catalog and providers in a dialog; an imported item lands on the lane at the playhead */

  // ----- intro / outro as blocks on the timeline -----
  const bumperBlock = (slot: BumperSlot): BumperBlock | null => {
    const own = bumpers[slot];
    const id = effectiveAsset(own, slot === "intro" ? settings.introAssetId : settings.outroAssetId);
    const a = assetById(id);
    if (!id || !a) return null;
    const sec =
      a.kind === "video"
        ? a.durationSec
        : (effectiveSeconds(bumpers[`${slot}Sec`], own, slot === "intro" ? settings.introSec : settings.outroSec, a.durationSec) ?? a.durationSec);
    return { name: a.name, sec: Math.round(sec * 10) / 10, kind: a.kind, thumbnailUrl: a.thumbnailUrl, source: own === undefined ? "project" : "clip" };
  };
  const bumperBlocks = { intro: bumperBlock("intro"), outro: bumperBlock("outro") };
  const setBumperSeconds = (slot: BumperSlot, sec: number, key?: string) => {
    const own = bumpers[slot];
    const id = effectiveAsset(own, slot === "intro" ? settings.introAssetId : settings.outroAssetId);
    if (!id) return;
    // dragging the length makes the choice the clip's own, so the seconds have somewhere to live
    edit({ bumpers: { ...bumpers, [slot]: id, [`${slot}Sec`]: sec } }, key);
  };
  const still =
    selectedBumper && bumperBlocks[selectedBumper]?.thumbnailUrl
      ? { url: bumperBlocks[selectedBumper]!.thumbnailUrl!, tag: `${selectedBumper === "intro" ? "Intro" : "Outro"} · ${bumperBlocks[selectedBumper]!.sec} s` }
      : null;

  const clipWords = useMemo(
    () =>
      words.filter((w) => w.end > range[0] && w.start < range[1]).map((w) => ({ text: w.text, start: Math.max(0, w.start - range[0]), end: w.end - range[0] })),
    [words, range],
  );
  const cutSpans = useMemo(
    () => flags.filter((f) => f.kind === "disfluency" && (f.status === "auto" || f.status === "accepted")).map((f) => ({ start: f.start, end: f.end })),
    [flags],
  );

  // ----- dirty tracking + save -----
  /**
   * A section as it is stored and compared: times to 1/100 s, offsets to 4 places, subjects and crops to 3,
   * fields that do nothing left out. Every field of `layoutSectionSchema` goes through here, so a new one is
   * saved and counts as a change (compared with `SECTION_FIELDS`).
   */
  const toSaved = (s: LayoutSection): LayoutSection => {
    const r4 = (n: number | undefined) => (n ? Number(n.toFixed(4)) : undefined);
    const r3 = (n: number | undefined) => (n === undefined ? undefined : Number(n.toFixed(3)));
    const region = (r: ContentRegion | undefined): ContentRegion | undefined =>
      r ? { x1: r3(r.x1)!, y1: r3(r.y1)!, x2: r3(r.x2)!, y2: r3(r.y2)! } : undefined;
    const out: LayoutSection = { start: Number(s.start.toFixed(2)), end: Number(s.end.toFixed(2)), mode: s.mode };
    const extra: Omit<LayoutSection, "start" | "end" | "mode"> = {
      offsetX: r4(s.offsetX),
      offsetY: r4(s.offsetY),
      offsetX2: r4(s.offsetX2),
      offsetY2: r4(s.offsetY2),
      subjectX: r3(s.subjectX),
      subjectX2: r3(s.subjectX2),
      crop: region(s.crop),
      crop2: region(s.crop2),
      contentCrop: region(s.contentCrop),
    };
    for (const k of SECTION_FIELDS) if (extra[k] !== undefined) Object.assign(out, { [k]: extra[k] });
    return out;
  };
  const forced = (list: EditorSection[]) => list.filter((s) => s.mode !== "auto" || hasAdjust(s)).map(toSaved);
  // a timeline that is just the project's framing is stored as no sections at all, so the clip keeps following the project
  const followsProject = JSON.stringify(forced(sections)) === JSON.stringify(forced([projectDefault]));
  const forcedSections = followsProject ? [] : forced(sections);
  const sectionsChanged =
    JSON.stringify(forcedSections) !== JSON.stringify(clip.layoutSections.map(toSaved)) ||
    (!!clip.layoutOverride && !forcedSections.length && clip.layoutOverride !== "auto");
  const styleOverride: StyleOverride = useMemo(() => {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(style) as Array<keyof Style>) if (style[k] !== projectStyle[k]) o[k] = style[k];
    return o as StyleOverride;
  }, [style, projectStyle]);
  const initialStyle = useMemo(() => resolveStyle(settings, clip.style), [settings, clip.style]);
  const styleChanged = JSON.stringify(style) !== JSON.stringify(initialStyle) || (styleScope === "all" && Object.keys(styleOverride).length > 0);
  const emphasisChanged = JSON.stringify(emphasis) !== JSON.stringify(clip.emphasis);
  const tagsChanged = JSON.stringify(hashtags) !== JSON.stringify(clip.hashtags);
  const boundsChanged = range[0] !== clip.startSec || range[1] !== clip.endSec;
  const hookChanged = hook !== clip.hook;
  // the seconds count too: a changed intro/outro length needs a re-render like a changed asset
  const bumperKey = (b: ClipBumpers | null | undefined) =>
    JSON.stringify({ intro: b?.intro, outro: b?.outro, introSec: b?.introSec ?? null, outroSec: b?.outroSec ?? null });
  const bumpersChanged = bumperKey(bumpers) !== bumperKey(clip.bumpers);
  // a fixed key order and defaults folded in: jsonb hands keys back in its own order, so a plain stringify of the row would always differ
  const layerKey = (list: ClipLayer[]) =>
    JSON.stringify(
      [...list]
        .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
        .map((l) => {
          const base = [l.id, l.kind, Number(l.start.toFixed(2)), Number(l.end.toFixed(2))];
          if (l.kind === "audio")
            return [
              ...base,
              l.assetId,
              Number((l.offset ?? 0).toFixed(2)),
              Number((l.volume ?? CLIP_AUDIO_DEFAULTS.volume).toFixed(2)),
              l.duck ?? CLIP_AUDIO_DEFAULTS.duck,
              Number((l.fade ?? CLIP_AUDIO_DEFAULTS.fade).toFixed(2)),
              l.loop ?? CLIP_AUDIO_DEFAULTS.loop,
            ];
          const shared = [Number(l.x.toFixed(3)), Number(l.y.toFixed(3)), l.opacity !== undefined && l.opacity < 1 ? Number(l.opacity.toFixed(3)) : 1];
          if (l.kind === "text")
            return [
              ...base,
              l.text,
              ...shared,
              Number((l.size ?? TEXT_OVERLAY_DEFAULTS.size).toFixed(3)),
              (l.color ?? TEXT_OVERLAY_DEFAULTS.color).toUpperCase(),
              !!l.box,
              l.font ?? TEXT_FONTS[0].family,
            ];
          return [...base, l.assetId, ...shared, Number((l.w ?? ASSET_OVERLAY_DEFAULT_W).toFixed(3)), l.loop ?? null];
        }),
    );
  const layersChanged = layerKey(layers) !== layerKey(clipLayers(clip));
  const dirtyCount = [
    title !== clip.title,
    hookChanged,
    caption !== clip.caption,
    tagsChanged,
    boundsChanged,
    sectionsChanged,
    styleChanged,
    emphasisChanged,
    bumpersChanged,
    layersChanged,
  ].filter(Boolean).length;
  const changed = dirtyCount > 0;
  const needsRender = boundsChanged || sectionsChanged || styleChanged || emphasisChanged || hookChanged || bumpersChanged || layersChanged;

  async function save(rerender: boolean): Promise<boolean> {
    try {
      if (styleChanged && styleScope === "all") await updateStyle.mutateAsync({ id: projectId, style, rerender });
      await update.mutateAsync({
        id: clip.id,
        title: title.trim() || clip.title,
        hook,
        caption,
        ...(tagsChanged ? { hashtags } : {}),
        startSec: range[0],
        endSec: range[1],
        ...(emphasisChanged ? { emphasis } : {}),
        ...(bumpersChanged ? { bumpers } : {}),
        ...(layersChanged ? { layers } : {}),
        ...(sectionsChanged ? { layoutSections: forcedSections, layoutOverride: null } : {}),
        ...(styleChanged && styleScope === "clip" ? { style: Object.keys(styleOverride).length ? styleOverride : null } : {}),
        rerender,
      });
      await qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
      toast(rerender && needsRender ? (styleScope === "all" && styleChanged ? "Saved · re-rendering every clip" : "Saved · re-rendering") : "Saved");
      return true;
    } catch (err) {
      toast.error((err as Error).message);
      return false;
    }
  }
  const busy = update.isPending || updateStyle.isPending || applyFraming.isPending;
  const guard = useLeaveGuard(changed, onExit);
  const requestExit = guard.requestExit;

  useUnsavedFlag("clip-editor", changed);
  // warn on tab close with unsaved edits
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => {
      if (changed) e.preventDefault();
    };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [changed]);

  // keyboard
  // a field with its own undo stack (text inputs opt in with data-native-undo) keeps ⌘Z
  const nativeUndo = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.("[data-native-undo]");
  useShortcut("mod+z", (e) => !nativeUndo(e) && (e.preventDefault(), history.undo()), { inFields: true, preventDefault: false });
  useShortcut("mod+shift+z, mod+y", (e) => !nativeUndo(e) && (e.preventDefault(), history.redo()), { inFields: true, preventDefault: false });
  useShortcut("mod+s", () => changed && !busy && void save(needsRender), { inFields: true });
  useShortcut("mod+b", () => splitAt(clock.get()), { inFields: true }); // ⌘K belongs to the command palette
  // copy / paste the selected layer; a text selection keeps the browser's own clipboard
  useShortcut("mod+c", (e) => !window.getSelection()?.toString() && copySelection() && e.preventDefault(), { preventDefault: false });
  useShortcut("mod+v", (e) => pasteSelection() && e.preventDefault(), { preventDefault: false });
  useShortcut("escape", () => setKeysOpen(false), { enabled: keysOpen, preventDefault: false });
  useSheetKey(() => setKeysOpen((o) => !o));
  useShortcut("space", () => togglePlay());
  useShortcut("i", () => setIn(clock.get()), { preventDefault: false });
  useShortcut("o", () => setOut(clock.get()), { preventDefault: false });
  useShortcut("s", () => setSnap(!snap), { preventDefault: false });
  useShortcut("left, right, shift+left, shift+right", (e) => {
    videoRef.current?.pause();
    seek(clock.get() + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 1 : FRAME));
  });
  useShortcut(
    "delete, backspace",
    () => {
      if (selectedLayer) removeLayer(selectedLayer);
      else if (selected !== null && selected > 0) mergeSection(selected, "left");
    },
    { preventDefault: false },
  );

  // ----- transcript (panel or tab) -----
  const txViewport = useRef<HTMLDivElement>(null);
  const txActive = useRef<HTMLSpanElement>(null);
  const txContent = useRef<HTMLDivElement>(null);
  const showTranscript = layout === "transcript" && !compact ? true : tab === "transcript";
  useEffect(() => {
    if (showTranscript && txViewport.current && txActive.current && playing)
      scrollWithin(txViewport.current, txActive.current, { block: "nearest", behavior: "auto" });
  }, [current, showTranscript, playing]);
  const txLines = useMemo(() => {
    const lo = range[0] - 40;
    const hi = range[1] + 40;
    return segments
      .filter((s) => s.end > lo && s.start < hi)
      .map((s) => ({ s, ws: rawWords.filter((w) => w.start >= s.start - 0.02 && w.start < s.end - 0.02) }));
  }, [segments, rawWords, range]);
  const readTxSelection = () => {
    const sel = window.getSelection();
    const el = txContent.current;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !el) return setTxSel(null);
    const r = sel.getRangeAt(0);
    if (!el.contains(r.commonAncestorContainer)) return setTxSel(null);
    const spans = [...el.querySelectorAll<HTMLElement>("[data-s]")].filter((n) => r.intersectsNode(n));
    if (!spans.length) return setTxSel(null);
    // snap the highlight to whole words
    const snapped = document.createRange();
    snapped.setStartBefore(spans[0]!);
    snapped.setEndAfter(spans.at(-1)!);
    sel.removeAllRanges();
    sel.addRange(snapped);
    setTxSel({ start: Math.min(...spans.map((n) => Number(n.dataset.s))), end: Math.max(...spans.map((n) => Number(n.dataset.e))) });
  };
  const transcript = (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1" viewportRef={txViewport}>
        <div ref={txContent} className="flex flex-col gap-3 px-4 py-3" onMouseUp={() => setTimeout(readTxSelection, 0)}>
          {txLines.length === 0 && <p className="text-ink3">No transcript around this clip.</p>}
          {txLines.map(({ s, ws }, i) => {
            const outside = s.end < range[0] || s.start > range[1];
            return (
              <div key={i} className={outside ? "opacity-55" : ""}>
                <button className="font-mono text-[11px] text-ink3 hover:text-ink" onClick={() => seek(s.start)}>
                  {formatTime(s.start)}
                </button>
                <p className="text-[14px] leading-[1.7]">
                  {ws.map((w, k) => {
                    const inside = w.start >= range[0] - 0.01 && w.end <= range[1] + 0.05;
                    const cur = current >= w.start && current < w.end + 0.06;
                    const cut = cutSpans.some((c) => w.start >= c.start - 0.02 && w.end <= c.end + 0.02);
                    return (
                      <span key={k}>
                        <span
                          ref={cur ? txActive : undefined}
                          data-s={w.start}
                          data-e={w.end}
                          onClick={() => !window.getSelection()?.toString() && seek(w.start)}
                          className={`cursor-pointer rounded-[3px] ${cur ? "bg-acc text-acc-ink" : inside ? "bg-acc-soft" : ""} ${cut ? "line-through decoration-ink3" : ""}`}
                        >
                          {w.text}
                        </span>{" "}
                      </span>
                    );
                  })}
                </p>
              </div>
            );
          })}
        </div>
      </ScrollArea>
      {txSel && (
        <div className="absolute inset-x-3 bottom-3 z-10 flex items-center gap-2 rounded-[12px] bg-ink px-3 py-2 text-xs text-bg shadow-pop">
          <span className="font-mono">{(txSel.end - txSel.start).toFixed(1)}s selected</span>
          <div className="flex-1" />
          <button
            className="rounded-[8px] bg-acc px-2.5 py-1 font-semibold text-acc-ink"
            onClick={() => {
              if (txSel.end - txSel.start < 3) return void toast("Clips need at least 3s");
              window.getSelection()?.removeAllRanges();
              setRange([txSel.start - 0.1, txSel.end + 0.2]);
              seek(txSel.start);
              setTxSel(null);
              toast("Range set from transcript");
            }}
          >
            Set range
          </button>
          <button
            aria-label="Cancel"
            className="rounded-[8px] px-1.5 py-1 hover:bg-white/10"
            onClick={() => {
              window.getSelection()?.removeAllRanges();
              setTxSel(null);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );

  // ----- inspector tabs -----
  const cropLayout = framing.layout !== "fit" && framing.layout !== "none";
  const curSec = sections[secIdx];
  const capWarn = safe && style.captions !== "none" ? safeZoneWarning(platform, style.captionX, style.captionY) : "";

  const captionsTab = (
    <div className="flex flex-col gap-5">
      {/* the follow-up action lives in the label row's reserved slot, so toggling never pushes the panel down */}
      <Field
        label="Apply style to"
        hint={
          styleScope === "all" ? (
            <span>re-renders every clip</span>
          ) : (
            <button
              className={`text-xs font-semibold text-acc-text ${Object.keys(styleOverride).length > 0 ? "" : "invisible"}`}
              aria-hidden={Object.keys(styleOverride).length === 0}
              tabIndex={Object.keys(styleOverride).length > 0 ? 0 : -1}
              onClick={() => edit({ style: projectStyle })}
            >
              Use the project style
            </button>
          )
        }
      >
        <Segmented
          value={styleScope}
          onChange={setStyleScope}
          options={[
            { value: "clip", label: "This clip" },
            { value: "all", label: `All ${clipCount} clips`, title: "Updates the project style and re-renders every clip" },
          ]}
        />
      </Field>
      <Field label="Look">
        <div className="grid grid-cols-4 gap-2">
          {(
            [
              ["karaoke", "Highlight"],
              ["box", "Boxed"],
              ["plain", "Outlined"],
              ["none", "Off"],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              onClick={() => setStyle({ captions: v })}
              className={`flex flex-col items-center gap-1 rounded-[10px] bg-panel px-1 py-2 text-xs ${style.captions === v ? "border-2 border-acc" : "border border-line"}`}
            >
              <span
                className="rounded-[5px] px-1.5 text-base font-extrabold"
                style={
                  v === "karaoke"
                    ? { color: "var(--acc-text)" }
                    : v === "box"
                      ? { background: "var(--acc)", color: "var(--acc-ink)" }
                      : v === "plain"
                        ? { color: "var(--panel)", WebkitTextStroke: "1.5px var(--ink)" }
                        : { color: "var(--ink3)", textDecoration: "line-through" }
                }
              >
                Aa
              </span>
              {l}
            </button>
          ))}
        </div>
      </Field>
      {style.captions !== "none" && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Size">
              <Segmented
                size="sm"
                value={SIZES.find((x) => Math.abs(x.v - style.captionSize) < 0.06)?.v ?? -1}
                onChange={(v) => setStyle({ captionSize: v })}
                options={SIZES.map((x) => ({ value: x.v, label: x.l }))}
              />
            </Field>
            <Field label="Words on screen" hint={<span className="font-mono">{style.wordsPerLine}</span>}>
              <input
                type="range"
                min={1}
                max={6}
                step={1}
                value={Math.min(6, style.wordsPerLine)}
                onChange={(e) => setStyle({ wordsPerLine: Number(e.target.value) }, "words")}
                className="accent-[var(--acc)]"
              />
            </Field>
          </div>
          {style.captions === "karaoke" || style.captions === "box" ? (
            <Field label="Highlight">
              <Swatches label="Highlight" colors={HL} value={style.highlightColor} onChange={(c) => setStyle({ highlightColor: c })} />
            </Field>
          ) : null}
          <Field
            label={
              <Switch
                checked={style.emphasis}
                onChange={(v) => setStyle({ emphasis: v })}
                label={<span className="text-xs font-semibold text-ink2">Key words</span>}
              />
            }
          >
            {style.emphasis && (
              <>
                <Swatches label="Key word" colors={KW} value={style.emphasisColor} onChange={(c) => setStyle({ emphasisColor: c })} />
                <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line bg-panel p-1.5">
                  {emphasis.map((w, i) => (
                    <span key={w} className="inline-flex items-center gap-1 rounded-full bg-sunk py-0.5 pl-2.5 pr-1 text-xs font-semibold">
                      {w}
                      <button
                        className="grid h-4 w-4 place-items-center rounded-full text-ink3 hover:bg-line hover:text-ink"
                        aria-label={`Remove ${w}`}
                        onClick={() => edit((d) => ({ emphasis: d.emphasis.filter((_, j) => j !== i) }))}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    className="min-w-[90px] flex-1 bg-transparent px-1 py-0.5 text-xs outline-none placeholder:text-ink3"
                    placeholder="Add key word…"
                    value={kwDraft}
                    onChange={(e) => setKwDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.key === "Enter" || e.key === ",") && kwDraft.trim()) {
                        e.preventDefault();
                        const w = kwDraft
                          .trim()
                          .toLowerCase()
                          .replace(/[^\p{L}\p{N}' ]+/gu, "");
                        if (w && !emphasis.includes(w)) edit((d) => ({ emphasis: [...d.emphasis, w] }));
                        setKwDraft("");
                      } else if (e.key === "Backspace" && !kwDraft && emphasis.length) edit((d) => ({ emphasis: d.emphasis.slice(0, -1) }));
                    }}
                  />
                </div>
              </>
            )}
          </Field>
          <Switch checked={style.uppercase} onChange={(v) => setStyle({ uppercase: v })} label="Uppercase" />
          <div className="flex items-center justify-between gap-2 text-[13px]">
            <span>
              Caption position{" "}
              <span className="font-mono text-xs text-ink3">
                x {Math.round(style.captionX * 100)}% · y {Math.round(style.captionY * 100)}%
              </span>
            </span>
            <button
              className="btn-ghost px-2.5 py-1 text-xs"
              disabled={style.captionX === defaultStyle.captionX && style.captionY === defaultStyle.captionY}
              onClick={() => setStyle({ captionX: defaultStyle.captionX, captionY: defaultStyle.captionY })}
            >
              Reset
            </button>
          </div>
          <Switch checked={style.captionSeam} onChange={(v) => setStyle({ captionSeam: v })} label="Between the panes in split and stack sections" />
        </>
      )}
      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <Switch checked={style.showHook} onChange={(v) => setStyle({ showHook: v })} label="Hook text" />
        {style.showHook && (
          <>
            <Field label="Show for" hint={<span className="font-mono">{style.hookSeconds}s</span>}>
              <input
                type="range"
                min={1}
                max={10}
                step={0.5}
                value={style.hookSeconds}
                onChange={(e) => setStyle({ hookSeconds: Number(e.target.value) }, "hookdur")}
                className="accent-[var(--acc)]"
              />
            </Field>
            <div className="flex items-center justify-between gap-2 text-[13px]">
              <span>
                Hook position <span className="font-mono text-xs text-ink3">y {Math.round(style.hookY * 100)}%</span>
              </span>
              <button
                className="btn-ghost px-2.5 py-1 text-xs"
                disabled={style.hookX === defaultStyle.hookX && style.hookY === defaultStyle.hookY}
                onClick={() => setStyle({ hookX: defaultStyle.hookX, hookY: defaultStyle.hookY })}
              >
                Reset
              </button>
            </div>
          </>
        )}
        <p className="text-[11px] text-ink3">Drag the caption or hook on the preview to move them. They snap to the centre; hold Alt to place freely.</p>
      </div>
    </div>
  );

  const framingTab = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <button className="btn-ghost text-xs" onClick={() => splitAt(current)}>
          Split at playhead <span className="font-mono text-ink3">{SPLIT_SHORTCUT}</span>
        </button>
        <button className="btn-ghost text-xs" disabled={selected === null || selected <= 0} onClick={() => selected !== null && mergeSection(selected, "left")}>
          Merge with previous
        </button>
        {!followsProject && (
          <button
            className="btn-quiet text-xs"
            onClick={resetLayout}
            title={projectFramed ? "Back to the framing every clip of this project gets" : "Back to automatic framing"}
          >
            {projectFramed ? "Use the project framing" : "Reset all to auto"}
          </button>
        )}
        {clipCount > 1 && (
          <button
            className="btn-ghost text-xs"
            disabled={busy}
            title="Give every clip of this project the framing of the section under the playhead (and new clips too); re-renders them all"
            onClick={() => setApplyAll(secIdx)}
          >
            Use for all {clipCount} clips…
          </button>
        )}
      </div>
      {sections.map((s, i) => {
        const chose = autoChoiceFor(s);
        const explain =
          s.mode === "auto"
            ? chose
              ? `Auto chose ${chose}${chose.includes("Two stacked") ? ": both speakers in frame" : chose === "Follow speaker" ? ": tracking whoever talks" : ""}.`
              : "Auto decides at render: follow the speaker, two stacked for two people, screen + speaker for a webcam over a screen (or an app screen or title card beside the speaker), whole frame when nobody is on screen."
            : `${MODE_EXPLAIN[s.mode] ?? ""} ${chose ? `Auto would choose ${chose}.` : ""}`;
        return (
          <div
            key={i}
            onClick={() => {
              setSelected(i);
              if (current < s.start || current >= s.end) seek(s.start);
            }}
            className={`flex cursor-pointer flex-col gap-1.5 rounded-[12px] p-2.5 ${selected === i ? "border-2 border-acc" : "border border-line"}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-ink2">
                {fmtPrecise(s.start - range[0])}–{fmtPrecise(s.end - range[0])}
              </span>
              <Select
                size="sm"
                className="ml-auto w-[9.5rem]"
                ariaLabel="Section mode"
                value={s.mode}
                onClick={(e) => e.stopPropagation()}
                onValueChange={(v) => setMode(i, v as SectionMode)}
                options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
              />
            </div>
            <p className="text-xs leading-snug text-ink2">{explain}</p>
            {(() => {
              const n = paneCount(s, i);
              const lay = layoutOf(s, i);
              if (!n && lay !== "fit") return null;
              const panes: Array<0 | 1> = n === 2 ? [0, 1] : n === 1 ? [0] : [];
              const cropBtn = (key: CropKey) => (
                <button
                  className="font-semibold text-acc-text"
                  title="Fix this pane to an exact part of the source"
                  onClick={(e) => {
                    e.stopPropagation();
                    openCrop(i, key);
                  }}
                >
                  Crop…
                </button>
              );
              return (
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-1 text-xs">
                  {lay === "stack" && (
                    <>
                      <span className="text-ink3">Screen</span>
                      <span className={`truncate font-mono ${s.contentCrop ? "text-ink" : "text-ink3"}`}>
                        {s.contentCrop ? `crop ${regionLabel(s.contentCrop)}` : "whole frame or what was detected"}
                      </span>
                      {cropBtn("contentCrop")}
                      <button
                        className="font-semibold text-acc-text disabled:invisible"
                        disabled={!s.contentCrop}
                        onClick={(e) => {
                          e.stopPropagation();
                          applyCrop(i, "contentCrop", null);
                        }}
                      >
                        Reset
                      </button>
                    </>
                  )}
                  {panes.map((pane) => {
                    const a = paneOf(s, pane);
                    const has = !!(a.offsetX || a.offsetY || a.subjectX !== undefined || a.crop);
                    const label = has ? adjustLabel({ offsetX: a.offsetX, offsetY: a.offsetY, subjectX: a.subjectX, crop: a.crop }) : "follows the speaker";
                    return (
                      <Fragment key={pane}>
                        <span className="text-ink3">{n === 2 ? PANE_NAME[pane] : lay === "stack" ? "Speaker" : "Crop"}</span>
                        <span
                          className={`truncate font-mono ${has ? "text-ink" : "text-ink3"}`}
                          title={a.subjectX !== undefined ? "Follows the person at this position (fixed there when nobody is found)" : undefined}
                        >
                          {label}
                        </span>
                        {cropBtn(pane === 0 ? "crop" : "crop2")}
                        <button
                          className="font-semibold text-acc-text disabled:invisible"
                          disabled={!has}
                          onClick={(e) => {
                            e.stopPropagation();
                            resetPane(i, pane);
                          }}
                        >
                          Reset
                        </button>
                      </Fragment>
                    );
                  })}
                  {!panes.length && (
                    <>
                      <span className="text-ink3">Crop</span>
                      <span className="truncate font-mono text-ink3">the whole frame</span>
                      {cropBtn("crop")}
                      <span />
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        );
      })}
      <p className="text-[11px] leading-snug text-ink3">
        Drag the picture to re-centre the section under the playhead; in a split, drag either speaker. Drop a pane on someone else and it follows them instead.
        On the timeline: drag a transition to move it, double-click to remove it, right-click for more.
      </p>
    </div>
  );

  const layersTab = (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-ghost text-xs" disabled={layers.length >= MAX_CLIP_LAYERS} onClick={() => setPicker({ kind: "asset", t: current })}>
          <ImageIcon className="h-3.5 w-3.5" /> Image or video
        </button>
        <button className="btn-ghost text-xs" disabled={layers.length >= MAX_CLIP_LAYERS} onClick={() => addTextLayer(current)}>
          <Type className="h-3.5 w-3.5" /> Text
        </button>
        <button
          className="btn-ghost text-xs"
          disabled={layers.length >= MAX_CLIP_LAYERS}
          onClick={() => setPicker({ kind: "audio", t: current })}
          title="Music or a sound effect from the playhead"
        >
          <MusicIcon className="h-3.5 w-3.5" /> Sound
        </button>
        <button className="btn-ghost text-xs" onClick={() => setTemplateOpen(true)} title="A saved set of layers, fitted to this clip's length">
          <LayoutTemplate className="h-3.5 w-3.5" /> Template
        </button>
        <span className="ml-auto text-[11px] text-ink3" title="Layers on this clip">
          {layers.length}/{MAX_CLIP_LAYERS}
        </span>
      </div>
      {layers.length === 0 && (
        <p className="text-xs leading-snug text-ink2">
          A logo, a sticker, a piece of b-roll, a line of text, music or a sound effect from your library, placed on the clip from the playhead, or a whole
          template of them fitted to the clip. Captions stay on top of images and video.
        </p>
      )}
      {[...layers]
        .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
        .map((l) => (
          <LayerCard
            key={l.id}
            layer={l}
            asset={l.kind === "text" ? undefined : assetById(l.assetId)}
            selected={l.id === selectedLayer}
            rangeStart={range[0]}
            rangeEnd={range[1]}
            loading={assetsLoading}
            onSelect={() => {
              setSelectedLayer(l.id);
              if (current < l.start || current > l.end) seek(l.start);
            }}
            onPatch={(patch, key) => patchLayer(l.id, patch, key)}
            onRemove={() => removeLayer(l.id)}
          />
        ))}
      {(layers.length > 0 || templateBumpers) && (
        <button
          className="btn-ghost self-start text-xs"
          onClick={() => setSaveTemplateOpen(true)}
          title="Save these layers, with the clip's intro and outro, as a template to use on other clips, whatever their length"
        >
          <LayoutTemplate className="h-3.5 w-3.5" /> Save as template…
        </button>
      )}
      <p className="text-[11px] leading-snug text-ink3">
        Drag a picture or text on the preview to move it, its corner to resize it. On the timeline: drag a block to move it, its edges to trim it, double-click
        the lane to add one.
      </p>
    </div>
  );
  /** A template into the document (layers and intro / outro, one undo step): the first new layer is selected and shown. */
  const applyTemplate = (template: Parameters<typeof applyTemplateLocally>[0], mode: Parameters<typeof applyTemplateLocally>[1]) => {
    const r = applyTemplateLocally(template, mode, layers, range, bumpers);
    if (!r) return;
    edit((d) => ({ layers: clampLayers(r.next, d.range), bumpers: r.bumpers }));
    const first = r.added[0];
    if (first) {
      setSelectedLayer(first.id);
      if (current < first.start || current > first.end) seek(first.start);
    }
    if (tab !== "layers" && tab !== "transcript") setTab("layers");
    setTemplateOpen(false);
  };

  const textTab = (
    <div className="flex flex-col gap-4">
      <Field label="Title" hint={`${title.length}/120`}>
        <input className="input" value={title} maxLength={120} onChange={(e) => edit({ title: e.target.value }, "title")} />
      </Field>
      <Field
        label="On-screen hook"
        hint={
          <span className={hookChanged ? "text-warn" : ""}>
            {hook.length}/80{hookChanged ? " · needs re-render" : ""}
          </span>
        }
      >
        <input className="input" value={hook} maxLength={80} onChange={(e) => edit({ hook: e.target.value }, "hook")} />
      </Field>
      <Field label="Post caption" hint={`${caption.length}/300 · no re-render needed`}>
        <textarea className="input resize-none" rows={4} value={caption} maxLength={300} onChange={(e) => edit({ caption: e.target.value }, "caption")} />
      </Field>
      <Field label="Hashtags" hint="no re-render needed">
        <div className="flex flex-wrap items-center gap-1.5 rounded-[10px] border border-line bg-panel p-1.5">
          {hashtags.map((h, i) => (
            <span key={`${h}${i}`} className="inline-flex items-center gap-1 rounded-full bg-acc-soft py-0.5 pl-2.5 pr-1 text-xs font-semibold text-acc-text">
              #{h}
              <button
                className="grid h-4 w-4 place-items-center rounded-full hover:bg-acc/20"
                aria-label={`Remove #${h}`}
                onClick={() => edit((d) => ({ hashtags: d.hashtags.filter((_, j) => j !== i) }))}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <input
            className="min-w-[90px] flex-1 bg-transparent px-1 py-0.5 text-xs outline-none placeholder:text-ink3"
            placeholder="#add"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === "," || e.key === " ") && tagDraft.trim()) {
                e.preventDefault();
                const t = tagDraft
                  .trim()
                  .replace(/^#+/, "")
                  .replace(/[^\p{L}\p{N}_]+/gu, "");
                if (t && !hashtags.includes(t)) edit((d) => ({ hashtags: [...d.hashtags, t] }));
                setTagDraft("");
              } else if (e.key === "Backspace" && !tagDraft && hashtags.length) edit((d) => ({ hashtags: d.hashtags.slice(0, -1) }));
            }}
          />
        </div>
      </Field>
    </div>
  );

  const cuts = useMemo(() => {
    const skipped = clip.diagnostics?.cuts.skipped ?? [];
    return flags
      .filter((f) => f.kind === "disfluency" && f.start >= range[0] - 0.01 && f.end <= range[1] + 0.05)
      .sort((a, b) => a.start - b.start)
      .map((f) => {
        const applied = f.status === "auto" || f.status === "accepted";
        const refused = applied ? skipped.find((s) => Math.abs(s.start - f.start) < 0.35) : undefined;
        const outcome = applied && clip.diagnostics ? cutState(f, [{ startSec: clip.startSec, endSec: clip.endSec, diagnostics: clip.diagnostics }]) : null;
        const unverified = outcome?.state === "unverified" ? outcome : undefined;
        const label = refused ? "▲ Kept in audio" : unverified ? "▲ Cut unverified" : applied ? "Cut" : f.status === "pending" ? "Needs review" : "Kept";
        const tone = refused || unverified || f.status === "pending" ? "bg-warn-soft" : applied ? "bg-ok-soft" : "bg-sunk";
        const reason = refused
          ? "The removal couldn’t be verified, so the audio was kept. Captions still drop the word."
          : unverified
            ? cutStateTitle(unverified)
            : f.status === "pending"
              ? "Waiting for your call in the project transcript."
              : f.status === "rejected"
                ? "You kept it."
                : f.subkind === "manual"
                  ? "You marked this to cut."
                  : `${f.subkind === "repair" ? "False start" : f.subkind === "repetition" ? "Repeated word" : "Filler"} · ${Math.round(f.confidence * 100)}% confident.`;
        return { f, label, tone, reason, refused, unverified: !!unverified };
      });
  }, [flags, range, clip.diagnostics]);
  const nCut = cuts.filter((c) => c.label === "Cut" || c.unverified).length;
  const nKept = cuts.filter((c) => c.refused).length;
  const nUnverified = cuts.filter((c) => c.unverified).length;
  const pauses = clip.diagnostics?.pauses;
  const cutsTab = (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-snug text-ink2">
        {cuts.length
          ? `${nCut} cut${nCut === 1 ? "" : "s"} applied${nUnverified ? ` (▲ ${nUnverified} without a seam check)` : ""}${nKept ? `; ${nKept} kept because removal couldn’t be verified. Captions still drop the word.` : "."}`
          : "No disfluencies in this range."}
        {pauses?.cuts
          ? ` ${pauses.cuts} pause${pauses.cuts === 1 ? "" : "s"} shortened to ${pauses.maxPause}s (${pauses.removedSec.toFixed(1)}s removed).`
          : ""}
      </p>
      {cuts.map(({ f, label, tone, reason }) => (
        <div
          key={f.id}
          role="button"
          tabIndex={0}
          onClick={() => seek(Math.max(range[0], f.start - 1))}
          onKeyDown={(e) => e.key === "Enter" && seek(Math.max(range[0], f.start - 1))}
          className="flex cursor-pointer flex-col gap-1 rounded-[12px] border border-line p-2.5 text-left hover:bg-sunk"
        >
          <div className="flex items-center gap-2">
            <s className="text-[13px] font-semibold">{f.heard}</s>
            <span className="font-mono text-[11px] text-ink3">{fmtPrecise(f.start - range[0])}</span>
            <span className={`ml-auto rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone}`}>{label}</span>
          </div>
          <span className="whitespace-pre-line text-xs leading-snug text-ink2">{reason}</span>
          <a
            href={`/p/${projectId}#fix=${f.id}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="w-max text-xs font-semibold text-acc-text no-underline"
            title="Review this cut in the project transcript (new tab)"
          >
            Open in transcript ↗
          </a>
        </div>
      ))}
      <p className="text-[11px] text-ink3">Accept or reject cuts in the project transcript; they apply to every clip that contains them.</p>
    </div>
  );

  const tabs: Array<[Tab, string]> = [
    ["captions", "Captions"],
    ["framing", "Framing"],
    ["layers", layers.length ? `Layers · ${layers.length}` : "Layers"],
    ["text", "Details"],
    ["cuts", "Cuts"],
  ];
  if (layout !== "transcript" || compact) tabs.push(["transcript", "Transcript"]);
  const activeTab: Tab = layout === "transcript" && !compact && tab === "transcript" ? "captions" : tab;

  const inspector = (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="shrink-0 border-b border-line">
        <div className="flex w-max gap-1 px-3 py-2">
          {tabs.map(([k, l]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`rounded-[8px] px-3 py-[7px] text-[13px] font-semibold whitespace-nowrap ${activeTab === k ? "bg-sunk text-ink" : "text-ink2 hover:text-ink"}`}
            >
              {l}
            </button>
          ))}
        </div>
      </ScrollArea>
      {activeTab === "transcript" ? (
        transcript
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-4">
            {activeTab === "captions" && captionsTab}
            {activeTab === "framing" && framingTab}
            {activeTab === "layers" && layersTab}
            {activeTab === "text" && textTab}
            {activeTab === "cuts" && cutsTab}
          </div>
        </ScrollArea>
      )}
    </div>
  );

  // ----- preview -----
  const len = range[1] - range[0];
  const tbtn = "grid h-[34px] min-w-[34px] place-items-center rounded-[10px] border border-line bg-panel px-2 text-[13px] text-ink hover:bg-sunk";
  const preview = (
    <div className={`flex min-h-0 min-w-0 flex-col items-center gap-2.5 px-4 pb-3 pt-3.5 ${compact ? "" : "flex-1"}`}>
      <div className={`relative flex w-full justify-center ${compact ? "h-[min(62dvh,520px)]" : "min-h-0 flex-1"}`}>
        <LivePreview
          clock={clock}
          playing={playing}
          framingAt={framingAt}
          rangeStart={range[0]}
          source={videoEl}
          srcW={srcW}
          srcH={srcH}
          style={style}
          words={clipWords}
          seams={seams}
          hook={hook}
          emphasis={emphasis}
          onPan={panPane}
          onPanEnd={panEnd}
          overlays={overlays}
          assetOverlaysAt={previewOverlaysAt}
          selectedOverlay={selectedLayer}
          onOverlaySelect={setSelectedLayer}
          onOverlayChange={(id, patch, key) => patchLayer(id, patch, key)}
          overlayMenu={overlayMenu}
          paneMenu={paneMenu}
          onHookChange={(t) => edit({ hook: t }, "hook")}
          still={still}
          alwaysShowHook={activeTab === "captions" && !playing}
          onStyleChange={(p) => setStyle(p, "drag-text")}
          showSafeZones={safe}
          platform={platform}
        />
        {buffering && (
          <div className="pointer-events-none absolute left-1/2 top-12 -translate-x-1/2 rounded-full bg-black/60 px-2.5 py-1 text-xs text-white">Loading…</div>
        )}
        {/* overlaid on the frame: a warning that pushed the transport down would move the buttons under the cursor */}
        {capWarn && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 z-10 w-[min(320px,90%)] -translate-x-1/2 rounded-[10px] bg-warn-soft/95 px-3 py-1.5 text-center text-xs text-ink shadow-pop">
            {capWarn}
          </div>
        )}
        <video ref={videoRef} src={sourceVideoUrl} preload="auto" playsInline className="pointer-events-none absolute h-px w-px opacity-0" />
      </div>
    </div>
  );
  // ----- the timeline's action bar: edit actions | transport | view tools -----
  const canRemove = !!selectedLayer || (selected !== null && selected > 0);
  const removeSelected = () => {
    if (selectedLayer) removeLayer(selectedLayer);
    else if (selected !== null && selected > 0) mergeSection(selected, "left");
  };
  const abtn =
    "inline-flex h-[30px] items-center gap-1 rounded-[8px] border border-line bg-panel px-2 text-xs text-ink hover:bg-sunk disabled:cursor-not-allowed disabled:text-ink3 disabled:hover:bg-panel";
  // the bar holds only what acts on the tracks; adding things lives on the lanes and in the inspector
  const actionBar = (
    <>
      <button className={abtn} onClick={() => splitAt(current)} title={`Split the framing at the playhead (${SPLIT_SHORTCUT})`}>
        <Scissors className="h-3.5 w-3.5" /> Split
      </button>
      <button
        className={abtn}
        disabled={!canRemove}
        onClick={removeSelected}
        title={
          selectedLayer
            ? "Remove the selected layer (Delete)"
            : selected !== null && selected > 0
              ? "Remove the selected transition (Delete)"
              : "Select a layer or a framing transition first"
        }
      >
        <Trash2 className="h-3.5 w-3.5" /> Remove
      </button>
    </>
  );
  /** In / out points, in the popover from the clip block's length label. */
  const nudge = (which: "in" | "out", d: number) => (which === "in" ? setIn(range[0] + d) : setOut(range[1] + d));
  const nb = "rounded-[7px] border border-line bg-panel px-1.5 py-1 font-mono text-[11px] text-ink hover:bg-sunk";
  const clipRangeEditor = () => (
    <div className="flex flex-col gap-2 text-xs" aria-label="Clip in and out points">
      {(["in", "out"] as const).map((k) => (
        <div key={k} className="flex items-center gap-1">
          <span className="w-7 font-semibold text-ink2">{k === "in" ? "In" : "Out"}</span>
          <button className={nb} onClick={() => nudge(k, -1)}>
            −1
          </button>
          <button className={nb} onClick={() => nudge(k, -0.1)}>
            −.1
          </button>
          <TimeField
            label={k === "in" ? "Clip start" : "Clip end"}
            value={k === "in" ? range[0] : range[1]}
            onCommit={(t) => (k === "in" ? setIn(t) : setOut(t))}
          />
          <button className={nb} onClick={() => nudge(k, 0.1)}>
            +.1
          </button>
          <button className={nb} onClick={() => nudge(k, 1)}>
            +1
          </button>
        </div>
      ))}
      <span className="text-[11px] text-ink3">{len.toFixed(1)}s · source seconds · I / O set them at the playhead</span>
    </div>
  );
  const transport = (
    <>
      <button className={tbtn} onClick={() => (videoRef.current?.pause(), seek(current - FRAME))} title="Previous frame (←)" aria-label="Previous frame">
        ◀︎❙
      </button>
      <button
        className="grid h-[34px] w-[44px] place-items-center rounded-[10px] bg-ink text-bg"
        onClick={togglePlay}
        title="Play / pause (Space)"
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? "❚❚" : "▶"}
      </button>
      <button className={tbtn} onClick={() => (videoRef.current?.pause(), seek(current + FRAME))} title="Next frame (→)" aria-label="Next frame">
        ❙▶︎
      </button>
      <span className="mx-1.5 min-w-[7.5rem] text-center font-mono text-xs text-ink2">
        {fmtPrecise(Math.max(0, current - range[0]))} / {fmtPrecise(len)}
      </span>
      <button className={tbtn} onClick={() => setIn(current)} title="Set the in point at the playhead (I)">
        [ In
      </button>
      <button className={tbtn} onClick={() => setOut(current)} title="Set the out point at the playhead (O)">
        Out ]
      </button>
    </>
  );
  // the canvas header: what the frame under the playhead is doing, and how it is viewed
  const chip = "inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 text-xs text-ink";
  const canvasHeader = (
    <div className={`flex w-full flex-wrap items-center gap-2 ${compact ? "" : "min-h-9"}`}>
      {curSec && (
        <span className={chip} title="Framing of the section under the playhead (Framing tab for all sections)">
          <Select
            size="sm"
            className="-ml-2 h-6 border-0 bg-transparent"
            ariaLabel="Section framing"
            value={curSec.mode}
            onValueChange={(v) => setMode(secIdx, v as SectionMode)}
            options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
          />
          {curSec.mode === "auto" && <span className="text-ink3">→ {layoutLabel(framing) ?? framing.layout}</span>}
        </span>
      )}
      <span
        className={chip}
        title={
          cropLayout
            ? framing.layout === "split"
              ? "Drag either speaker on the preview to re-centre that pane"
              : "Drag the picture to re-centre this section"
            : `Not adjustable in ${MODE_LABEL[framing.layout]}`
        }
      >
        Crop <span className="max-w-[12rem] truncate font-mono">{curSec && hasAdjust(curSec) ? adjustLabel(curSec) : "follows the speaker"}</span>
        <button className="font-semibold text-acc-text disabled:hidden" disabled={!curSec || !hasAdjust(curSec)} onClick={() => resetOffset(secIdx)}>
          Reset
        </button>
      </span>
      <span className="flex-1" />
      <Popover.Root>
        <Popover.Trigger asChild>
          <button className={chip} title="Safe zones, platform, burned-in text" aria-label="Preview options">
            <Eye className="h-3.5 w-3.5" /> {safe ? PLATFORM_NAME[platform] : "No safe zones"}
            {overlays.length > 0 && <span className="font-mono text-[10px] text-ink3">CC</span>}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={12}
            className="z-[80] flex w-[17rem] flex-col gap-3 rounded-[12px] border border-line bg-panel p-3 text-xs text-ink shadow-pop"
          >
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span>Safe zones</span>
              <input type="checkbox" checked={safe} onChange={(e) => setSafe(e.target.checked)} className="accent-[var(--acc)]" />
            </label>
            <Field label="Platform">
              <Select
                size="sm"
                disabled={!safe}
                ariaLabel="Platform"
                value={platform}
                onValueChange={(v) => setPlatform(v as Platform)}
                options={(Object.keys(PLATFORM_NAME) as Platform[]).map((k) => ({ value: k, label: PLATFORM_NAME[k] }))}
              />
            </Field>
            {overlays.length > 0 && (
              <div
                className="flex flex-col gap-1 border-t border-line pt-3"
                title="Text already in the video (captions, logos) is blurred so it doesn't clash with yours"
              >
                <span>
                  <span className="mr-1 font-mono text-[10px]">CC</span> Burned-in text is blurred in every clip
                </span>
                <button
                  className="w-max font-semibold text-acc-text disabled:opacity-50"
                  disabled={setSourceText.isPending}
                  onClick={() =>
                    setSourceText
                      .mutateAsync({ id: projectId, sourceText: "keep" })
                      .then((r) =>
                        qc
                          .invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) })
                          .then(() => toast(`Source text kept · re-rendering ${r.rerendered} clip${r.rerendered === 1 ? "" : "s"}`)),
                      )
                      .catch((err) => toast.error((err as Error).message))
                  }
                  title="Show the source's own text in every clip of this project (re-renders them)"
                >
                  Show it instead
                </button>
              </div>
            )}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
  /** The intro / outro choices, in the popover anchored on the block that was clicked on the timeline. */
  const bumperEditor = (slot: BumperSlot) => (
    <div className="flex flex-col gap-2.5" aria-label={`${slot === "intro" ? "Intro" : "Outro"} for this clip`}>
      <div className="flex h-5 items-center justify-between text-xs">
        <span className="font-semibold text-ink2">Intro and outro of this clip</span>
        <button
          className="text-acc-text hover:underline"
          onClick={() => {
            setSelectedBumper(null);
            setBumpersDialog(true);
          }}
          title="Intro and outro for the whole project"
        >
          Project settings…
        </button>
      </div>
      <BumperSelects
        reserveSec
        value={choicesFrom(bumpers)}
        onChange={(v) => edit({ bumpers: clipBumpersFrom(v) })}
        projectIntroId={settings.introAssetId}
        projectOutroId={settings.outroAssetId}
      />
      <p className="text-[11px] leading-snug text-ink3">
        {slot === "intro" ? "Plays before the clip." : "Plays after the clip."} Drag an image block's outer edge on the timeline to change how long it shows.
        Needs a re-render.
      </p>
    </div>
  );

  const timeline = (
    <LiveTimeline
      clock={clock}
      sourceDuration={durationSec}
      range={range}
      onRange={setRange}
      onSeek={seek}
      words={rawWords.length ? rawWords : words}
      cuts={cutSpans}
      sceneCuts={sceneCuts}
      sections={sections}
      onSections={setSections}
      onSplit={splitAt}
      onSetMode={setMode}
      onMerge={mergeSection}
      onResetLayout={resetLayout}
      onResetOffset={resetOffset}
      onSetCrop={(i) => openCrop(i)}
      onUndo={history.undo}
      onRedo={history.redo}
      canUndo={history.canUndo}
      canRedo={history.canRedo}
      selected={selected}
      onSelect={(i) => {
        setSelected(i);
        if (i !== null && tab === "transcript") setTab("framing");
      }}
      detected={clip.layoutSegments}
      toolbar={actionBar}
      transport={transport}
      snap={snap}
      onSnap={setSnap}
      compactHints={short || compact}
      layers={layerBlocks}
      selectedLayer={selectedLayer}
      onLayerSelect={(id) => {
        setSelectedLayer(id);
        if (!id) return;
        if (tab !== "layers" && tab !== "transcript") setTab("layers");
        // show it: park the playhead inside its window so the preview has it on screen
        const l = layers.find((x) => x.id === id);
        if (l && (current < l.start || current > l.end)) seek(l.start);
      }}
      onLayerChange={(id, r, key) => patchLayer(id, { start: r[0], end: r[1] }, key)}
      onLayerAdd={(t, kind) => {
        if (kind === "template") return setTemplateOpen(true);
        seek(t);
        if (kind === "text") addTextLayer(t);
        else setPicker({ kind, t });
      }}
      onLayerTemplate={() => setTemplateOpen(true)}
      onLayerRemove={removeLayer}
      renderClipEditor={clipRangeEditor}
      bumpers={bumperBlocks}
      selectedBumper={selectedBumper}
      onBumperSelect={setSelectedBumper}
      onBumperSeconds={setBumperSeconds}
      renderBumperEditor={bumperEditor}
    />
  );

  // ----- header -----
  const rendering = clip.status === "rendering" || clip.status === "pending";
  let dirtyLabel: string;
  let dirtyCls: string;
  if (changed) {
    dirtyLabel = `${dirtyCount} unsaved${needsRender ? " · needs re-render" : ""}`;
    dirtyCls = "bg-warn-soft";
  } else if (rendering) {
    dirtyLabel = clip.status === "pending" ? "Queued to render" : `Rendering ${Math.round((renderProgress ?? 0) * 100)}%`;
    dirtyCls = "bg-acc-soft";
  } else if (clip.status === "failed") {
    dirtyLabel = "▲ Render failed";
    dirtyCls = "bg-err-soft";
  } else {
    dirtyLabel = clip.status === "done" ? "● Rendered" : "● Saved";
    dirtyCls = "bg-ok-soft";
  }
  const hb =
    "grid h-[34px] w-[34px] place-items-center rounded-[10px] border border-line bg-panel text-ink hover:bg-sunk disabled:cursor-not-allowed disabled:text-ink3 disabled:hover:bg-panel";
  const header = (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 sm:gap-3 sm:px-4">
      <button className="btn-quiet px-2" onClick={requestExit} title="Back to the project">
        <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Project</span>
      </button>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] text-ink3">
          {projectTitle} · clip #{clip.index + 1}
        </div>
        <div className="truncate text-[15px] font-bold leading-tight">{title || "Untitled clip"}</div>
      </div>
      <button className={hb} disabled={!history.canUndo} onClick={history.undo} title={`Undo (${MOD}Z)`} aria-label="Undo">
        <Undo2 className="h-4 w-4" />
      </button>
      <button className={hb} disabled={!history.canRedo} onClick={history.redo} title={`Redo (${MOD}⇧Z)`} aria-label="Redo">
        <Redo2 className="h-4 w-4" />
      </button>
      <HeaderAlerts />
      <span className={`hidden whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold md:inline ${dirtyCls}`}>{dirtyLabel}</span>
      {!compact && (
        <button
          className={`${hb} ${layout === "transcript" ? "!border-acc !bg-acc-soft !text-acc-text" : ""}`}
          onClick={() => setLayout(layout === "transcript" ? "classic" : "transcript")}
          title={layout === "transcript" ? "Hide the transcript column" : "Show the transcript as a column"}
          aria-pressed={layout === "transcript"}
        >
          <PanelLeft className="h-4 w-4" />
        </button>
      )}
      <button
        className={`${hb} hidden sm:grid`}
        onClick={() =>
          navigator.clipboard
            .writeText(linkWith({ ...(tab !== "captions" ? { tab } : {}), ...(current > range[0] + 0.05 ? { t: fmtSec(current - range[0]) } : {}) }))
            .then(() => toast("Link copied"))
            .catch(() => toast.error("Couldn’t copy the link"))
        }
        title="Copy a link to this clip at the playhead"
        aria-label="Copy link"
      >
        <Link2 className="h-4 w-4" />
      </button>
      <button
        className={`${hb} hidden text-err sm:grid`}
        disabled={delClip.isPending}
        onClick={() => setConfirmDelete(true)}
        title="Delete clip"
        aria-label="Delete clip"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <button className={`${hb} hidden sm:grid`} onClick={() => setKeysOpen(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
        <Keyboard className="h-4 w-4" />
      </button>
      <ThemeToggle className="hidden sm:inline-flex" />
      <button
        className="btn-primary min-w-[5.5rem] justify-center sm:min-w-[148px]"
        disabled={busy || (!changed && clip.status !== "failed")}
        onClick={() => void save(needsRender || (!changed && clip.status === "failed"))}
        title={needsRender ? `Saves and re-renders the clip (${MOD}S)` : `Saves; text-only edits don’t need a re-render (${MOD}S)`}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        <span className="sm:hidden">{!changed && clip.status === "failed" ? "Retry" : "Save"}</span>
        <span className="hidden sm:inline">
          {!changed && clip.status === "failed"
            ? "Retry render"
            : needsRender
              ? styleScope === "all" && styleChanged
                ? "Save & re-render all"
                : "Save & re-render"
              : "Save"}
        </span>
      </button>
    </header>
  );

  const keyList: Array<[string, string]> = [
    ["Play / pause", "Space"],
    ["Previous / next frame", "← →"],
    ["Back / forward 1s", "⇧← ⇧→"],
    ["Set in / out at playhead", "I  O"],
    ["Split framing at playhead", `${MOD}B`],
    ["Remove selected layer / transition", "Delete"],
    ["Copy / paste the selected layer at the playhead", `${MOD}C  ${MOD}V`],
    ["Undo / redo", `${MOD}Z  ⇧${MOD}Z`],
    ["Save", `${MOD}S`],
    ["Snapping on / off", "S"],
    ["Disable snapping while dragging", "hold Alt"],
    ["Zoom timeline", `${MOD} + scroll`],
  ];
  useShortcuts("Clip editor", keyList);

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
        <div
          className="grid min-h-0 flex-1"
          style={{ gridTemplateColumns: layout === "transcript" ? "320px minmax(0,1fr) 380px" : "minmax(0,1fr) 380px", gridTemplateRows: "minmax(0,1fr) auto" }}
        >
          {layout === "transcript" && (
            <div className="flex min-h-0 flex-col border-r border-line bg-panel">
              <div className="shrink-0 border-b border-line px-4 py-3 text-[13px] font-bold">Transcript</div>
              {transcript}
            </div>
          )}
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

      <ProjectBumpersModal
        open={bumpersDialog}
        onOpenChange={setBumpersDialog}
        projectId={projectId}
        clipCount={clipCount}
        introId={settings.introAssetId}
        outroId={settings.outroAssetId}
        introSec={settings.introSec}
        outroSec={settings.outroSec}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this clip?"
        body={`“${title || "Untitled clip"}” is hidden from the project. Unsaved edits are discarded. ${keepWindow.hint()} Storage still counts until you delete it forever.`}
        confirm="Delete clip"
        danger
        onConfirm={() => {
          delClip.mutate(
            { id: clip.id },
            {
              onSuccess: (r) => {
                guard.allowLeave();
                onExit();
                notifyDeleted({
                  items: [{ kind: "clip", id: clip.id, title: title || "Untitled clip" }],
                  restorable: r.restorable,
                  storedBytes: r.storedBytes,
                  afterUndo: () => navigate(`/p/${projectId}/clips/${clip.id}`),
                });
              },
              onError: (e) => toast.error(e.message),
            },
          );
        }}
      />
      <ConfirmDialog
        open={applyAll !== null}
        onOpenChange={(o) => !o && setApplyAll(null)}
        title={`Use this framing for all ${clipCount} clips?`}
        body={(() => {
          const s = applyAll !== null ? sections[applyAll] : undefined;
          const what = s ? `${MODE_LABEL[s.mode] ?? s.mode}${hasAdjust(s) ? ` · ${adjustLabel(s)}` : ""}` : "";
          return `“${what}” becomes the framing of every clip in “${projectTitle}”, replacing any framing set on other clips, and of every clip added later. All ${clipCount} clips re-render.`;
        })()}
        confirm="Use for all clips"
        onConfirm={async () => {
          const s = applyAll !== null ? sections[applyAll] : undefined;
          setApplyAll(null);
          if (!s) return;
          try {
            const r = await applyFraming.mutateAsync({ id: projectId, reframe: s.mode, adjust: adjustOf(s) });
            // this clip now follows the project too: its timeline becomes the one section the project gives it
            edit({ sections: [{ start: range[0], end: range[1], mode: r.reframe as SectionMode, ...(r.adjust ?? {}) }] });
            setSelected(null);
            await qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
            toast(`Framing set for all ${clipCount} clips · re-rendering`);
          } catch (err) {
            toast.error((err as Error).message);
          }
        }}
      />
      {cropDialog && sections[cropDialog.section] && (
        <CropDialog
          open
          onOpenChange={(o) => !o && setCropDialog(null)}
          source={videoEl}
          srcW={srcW}
          srcH={srcH}
          panes={cropPanesFor(cropDialog.section)}
          initial={cropDialog.key}
          onApply={(key, region) => applyCrop(cropDialog.section, key, region)}
        />
      )}
      <ApplyTemplateDialog
        open={templateOpen}
        onOpenChange={setTemplateOpen}
        title="Apply a template to this clip"
        existing={existingOnClip(layers.length)}
        actions={[{ label: "Apply", primary: true, title: "The layers join this clip; save the clip to render them", run: applyTemplate }]}
        emptyExtra={
          layers.length > 0 ? (
            <button
              className="text-xs font-semibold text-acc-text"
              onClick={() => {
                setTemplateOpen(false);
                setSaveTemplateOpen(true);
              }}
            >
              or save this clip’s layers as one
            </button>
          ) : undefined
        }
      />
      <SaveAsTemplateDialog
        open={saveTemplateOpen}
        onOpenChange={setSaveTemplateOpen}
        layers={layers}
        range={range}
        defaultName={title}
        bumpers={templateBumpers}
      />

      <AssetFinderDialog
        open={picker?.kind === "asset"}
        onOpenChange={(o) => !o && setPicker(null)}
        title="Add to clip"
        kinds={["video", "image"]}
        onPick={(a) => {
          rememberPick(a);
          const t = picker?.t ?? current;
          addAssetLayer(a, t);
        }}
      />
      <AssetFinderDialog
        open={picker?.kind === "audio"}
        onOpenChange={(o) => !o && setPicker(null)}
        title="Add a sound"
        kind="audio"
        onPick={(a) => {
          rememberPick(a);
          const t = picker?.t ?? current;
          addSoundLayer(a, t);
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

      <Modal open={guard.open} onOpenChange={(o) => !o && guard.stay()} title="Unsaved changes">
        <p className="text-sm leading-relaxed text-ink2">
          You have {dirtyCount} unsaved change{dirtyCount === 1 ? "" : "s"} to this clip{needsRender ? ", and some need a re-render" : ""}.
        </p>
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <button className="btn-ghost" onClick={guard.stay}>
            Keep editing
          </button>
          <button className="btn-danger" onClick={guard.leave}>
            Discard
          </button>
          <button
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              if (await save(needsRender)) guard.leave();
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
