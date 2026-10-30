/**
 * Layer templates on clips (docs/specs/layer-templates.md, "What the user sees"). One dialog, `ApplyTemplateDialog`,
 * serves every place a template lands on a clip: the clip editor (local: the layers join the editor's document, saved
 * with the clip), a clip card's ⋯ menu and the selection bar (server: `layerTemplates.applyToClips`, one transaction).
 * It shows the templates as cards with a small map of where their layers sit and when, and asks Replace / Keep only
 * when the target already has layers. A template can also carry an intro / outro: applying it sets those slots on the
 * clips (the editor: in its document). `TemplateSelect` is the plain select the settings forms use.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  ASSET_OVERLAY_DEFAULT_W,
  MAX_CLIP_LAYERS,
  mergeTemplateBumpers,
  resolveTemplateLayers,
  templateBumperSlots,
  templateFromLayers,
  timingText,
  type ClipBumpers,
  type ClipLayer,
  type TemplateBumpers,
  type TemplateLayer,
} from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { Modal, Select, Skeleton, SkeletonRegion, type SelectOption } from "./ui";
import { ScrollArea } from "./scroll-area";

/** The user's layer templates (live ones in `data.templates`, deleted ones in `data.deleted`). */
export function useLayerTemplates() {
  const trpc = useTRPC();
  // the newest 500 templates (the server pages; `total` says how many there are in all)
  return useQuery(
    trpc.layerTemplates.list.queryOptions(
      { limit: 500 },
      { select: (d) => ({ templates: d.items, deleted: d.deleted, total: d.total, nextCursor: d.nextCursor }) },
    ),
  );
}
type Template = NonNullable<ReturnType<typeof useLayerTemplates>["data"]>["templates"][number];

export type ApplyMode = "replace" | "add";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/**
 * Choose a layer template in a form. `value` "" is the lead option's value (default "None"); pass `lead` to replace
 * it. While the list loads the trigger keeps its size and is disabled; a chosen template that was deleted since
 * stays visible as "Deleted template".
 */
export function TemplateSelect({
  value,
  onChange,
  lead,
  ariaLabel = "Layer template",
  className,
  size,
  manage = true,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  lead?: SelectOption[];
  ariaLabel?: string;
  className?: string;
  size?: "sm" | "md";
  manage?: boolean;
  disabled?: boolean;
}) {
  const list = useLayerTemplates();
  const live = list.data?.templates ?? [];
  const options: SelectOption[] = [...(lead ?? [{ value: "", label: "None" }]), ...live.map((t) => ({ value: t.id, label: t.name, hint: templateSummary(t) }))];
  const missing = value !== "" && !!list.data && !options.some((o) => o.value === value);
  if (missing) options.push({ value, label: "Deleted template", disabled: true });
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Select
        ariaLabel={ariaLabel}
        value={list.isPending ? "" : value}
        onValueChange={onChange}
        options={options}
        placeholder={list.isPending ? "Loading…" : live.length ? "Choose a template" : "No templates yet"}
        size={size}
        className={className}
        disabled={disabled || list.isPending}
      />
      {manage && (
        <Link to="/templates" className="self-start text-xs font-semibold text-acc-text no-underline">
          Manage templates
        </Link>
      )}
    </div>
  );
}

// ── the gallery ──────────────────────────────────────────────────────────────

/** Where a template's layers sit on the 9:16 frame: pictures as boxes at their size, text as a short bar, a sound as a strip along the bottom. */
export function TemplateMap({ layers, className = "" }: { layers: TemplateLayer[]; className?: string }) {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const hasAudio = layers.some((l) => l.kind === "audio");
  return (
    <div className={`relative aspect-[9/16] overflow-hidden rounded-[6px] border border-line bg-sunk ${className}`} aria-hidden>
      {layers.map((l) => {
        if (l.kind === "audio") return null;
        if (l.kind === "text")
          return (
            <div
              key={l.id}
              className="absolute rounded-[2px] bg-ink2"
              style={{ left: pct(l.x - 0.2), top: pct(l.y - 0.02), width: pct(0.4), height: pct(0.04) }}
            />
          );
        const w = l.w ?? ASSET_OVERLAY_DEFAULT_W;
        const h = (w * 9) / 16; // a square picture, as a fraction of the frame's height
        return (
          <div
            key={l.id}
            className="absolute rounded-[2px] border border-acc bg-acc-soft"
            style={{ left: pct(l.x - w / 2), top: pct(l.y - h / 2), width: pct(w), height: pct(h) }}
          />
        );
      })}
      {hasAudio && <div className="absolute inset-x-0 bottom-0 h-[6%] bg-acc-soft" />}
    </div>
  );
}

const SLOT_LABEL = { intro: "Intro", outro: "Outro" } as const;

/** "3 layers", "3 layers · intro + outro", "Outro only": what a template puts on a clip, in a few words. */
export function templateSummary(t: { layerCount: number; bumpers: TemplateBumpers | null }): string {
  const slots = templateBumperSlots(t.bumpers);
  if (!t.layerCount && slots.length) return slots.length === 2 ? "Intro + outro" : `${SLOT_LABEL[slots[0]!]} only`;
  return [t.layerCount ? plural(t.layerCount, "layer") : "No layers", slots.join(" + ")].filter(Boolean).join(" · ");
}

/** "Intro · Brand sting", "Outro · None": one line per slot the template sets. */
export function templateBumperLines(b: TemplateBumpers | null, names: Map<string, string>): string[] {
  return templateBumperSlots(b).map((s) => {
    const id = b![s];
    return `${SLOT_LABEL[s]} · ${id ? (names.get(id) ?? "Video or image") : "None"}`;
  });
}

/** "copia-qr · First 3 s", "“Link in bio” · Last 4 s", "Music · Whole clip": one line per layer, intro and outro first. */
function templateLines(t: { layers: TemplateLayer[]; bumpers: TemplateBumpers | null }, names: Map<string, string>): string[] {
  return [
    ...templateBumperLines(t.bumpers, names),
    ...t.layers.map((l) => {
      const what = l.kind === "text" ? `“${l.text}”` : (names.get(l.assetId) ?? (l.kind === "audio" ? "Sound" : "Picture"));
      return `${what} · ${timingText(l.timing)}`;
    }),
  ];
}

/** The asset names a set of templates refer to, layers and intro / outro (own uploads and shared imports; at most 40 ids per call). */
function useTemplateAssetNames(templates: Template[]) {
  const trpc = useTRPC();
  const ids = useMemo(
    () =>
      [
        ...new Set(
          templates.flatMap((t) => [
            ...t.layers.flatMap((l) => (l.kind === "text" ? [] : [l.assetId])),
            ...templateBumperSlots(t.bumpers).flatMap((s) => t.bumpers?.[s] ?? []),
          ]),
        ),
      ].slice(0, 40),
    [templates],
  );
  const q = useQuery({ ...trpc.library.get.queryOptions({ ids }), enabled: ids.length > 0 });
  return useMemo(() => new Map((q.data?.assets ?? []).map((a) => [a.id, a.name])), [q.data]);
}

/**
 * The templates as cards (map, name, what each layer is and when it shows), one chosen. Skeleton cards while the list
 * loads; a sentence and a link once it has resolved with none.
 */
export function TemplateGallery({ value, onChange, emptyExtra }: { value: string; onChange: (id: string) => void; emptyExtra?: React.ReactNode }) {
  const list = useLayerTemplates();
  const templates = list.data?.templates ?? [];
  const names = useTemplateAssetNames(templates);
  const card = "flex w-full flex-col gap-2 rounded-[12px] border p-2.5 text-left";
  if (list.isPending && !list.error)
    return (
      <SkeletonRegion label="Loading templates…" className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className={`${card} border-line`}>
            <Skeleton className="aspect-[9/16] w-full rounded-[6px]" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ))}
      </SkeletonRegion>
    );
  if (list.error) return <p className="text-sm text-err">{list.error.message}</p>;
  if (!templates.length)
    return (
      <div className="flex flex-col items-start gap-2 rounded-[12px] border border-dashed border-line p-4 text-sm">
        <b>No templates yet</b>
        <p className="text-xs leading-snug text-ink2">
          A template is a set of layers (a logo in the first seconds, a call to action at the end, a watermark, a music bed) that fits any clip length, with an
          intro and outro if you like.
        </p>
        <Link to="/templates" className="text-xs font-semibold text-acc-text no-underline">
          Build one on the Templates page
        </Link>
        {emptyExtra}
      </div>
    );
  return (
    <div role="radiogroup" aria-label="Templates" className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
      {templates.map((t) => {
        const on = t.id === value;
        const lines = templateLines(t, names);
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(t.id)}
            className={`${card} ${on ? "border-acc bg-acc-soft" : "border-line hover:bg-sunk"}`}
          >
            <TemplateMap layers={t.layers} className="w-full" />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{t.name}</div>
              <div className="text-[11px] text-ink3">{templateSummary(t)}</div>
            </div>
            {lines.length > 0 && (
              <ul className="flex flex-col gap-0.5 text-[11px] leading-snug text-ink2">
                {lines.slice(0, 3).map((s, i) => (
                  <li key={i} className="truncate">
                    {s}
                  </li>
                ))}
                {lines.length > 3 && <li className="text-ink3">+{lines.length - 3} more</li>}
              </ul>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── the dialog ───────────────────────────────────────────────────────────────

export interface ApplyAction {
  label: string;
  primary?: boolean;
  disabled?: boolean;
  title?: string | undefined;
  run: (template: Template, mode: ApplyMode) => void | Promise<unknown>;
}

/**
 * Pick a template and put it on one or more clips. `existing` says what the target already has ("This clip has 3
 * layers." / "4 of the 10 selected clips already have layers."): the Keep / Replace choice shows only then, so a
 * clean clip gets no question, and Keep is the default so a template never wipes hand-placed layers unasked. The
 * caller owns what "apply" means (the editor's document, or the server).
 */
export function ApplyTemplateDialog({
  open,
  onOpenChange,
  title,
  existing,
  actions,
  pending,
  emptyExtra,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  existing: string | null;
  actions: ApplyAction[];
  pending?: boolean;
  emptyExtra?: React.ReactNode;
}) {
  const list = useLayerTemplates();
  const [templateId, setTemplateId] = useState("");
  const [mode, setMode] = useState<ApplyMode>("add");
  const modeName = useId();
  // a fresh dialog each time it opens: the first template chosen, and the layers already there kept (replacing is the
  // opt-in, so a template never wipes hand-placed layers by default)
  useEffect(() => {
    if (open) {
      setTemplateId(list.data?.templates[0]?.id ?? "");
      setMode("add");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(() => {
    if (open && !templateId && list.data?.templates[0]) setTemplateId(list.data.templates[0].id);
  }, [open, templateId, list.data]);
  const template = list.data?.templates.find((t) => t.id === templateId);
  const slots = templateBumperSlots(template?.bumpers);
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} width={560}>
      <ScrollArea className="max-h-[min(52dvh,520px)] -mx-1 px-1">
        <TemplateGallery value={templateId} onChange={setTemplateId} emptyExtra={emptyExtra} />
      </ScrollArea>
      {/* always present, so choosing a template with an intro never moves the buttons */}
      <p className="min-h-4 text-xs text-ink3">{slots.length ? `Also sets the ${slots.join(" and ")}, replacing the clip’s own.` : ""}</p>
      {existing && (
        <div role="radiogroup" aria-labelledby={`${modeName}-l`} className="flex flex-col gap-1.5 rounded-[10px] bg-sunk p-2.5 text-xs">
          <span id={`${modeName}-l`} className="mb-0.5 text-ink2">
            {existing}
          </span>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" name={modeName} className="accent-[var(--acc)]" checked={mode === "add"} onChange={() => setMode("add")} />
            Keep them and add the template’s layers
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" name={modeName} className="accent-[var(--acc)]" checked={mode === "replace"} onChange={() => setMode("replace")} />
            Replace them with the template’s layers
          </label>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button className="btn-ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        {actions.map((a) => (
          <button
            key={a.label}
            className={`${a.primary ? "btn-ink" : "btn-ghost"} min-w-[6rem]`}
            disabled={!template || pending || a.disabled}
            title={!template ? "Choose a template" : a.title}
            onClick={() => template && void a.run(template, existing ? mode : "replace")}
          >
            {pending && a.primary ? "Applying…" : a.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** "This clip has 3 layers." or null for a clean clip. */
export const existingOnClip = (n: number) => (n ? `This clip has ${plural(n, "layer")}.` : null);

/**
 * Apply a template to clips on the server (`layerTemplates.applyToClips`): one transaction, the clips keep the layers
 * as their own, finished ones re-rendered only when asked. Used by a clip card's ⋯ menu and the selection bar.
 * `withLayers`: for one clip its layer count, for a selection the number of clips that already have layers.
 */
export function ApplyTemplateToClipsDialog({
  open,
  onOpenChange,
  projectId,
  clipIds,
  withLayers,
  rerenderable,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  clipIds: string[];
  withLayers: number;
  rerenderable: number;
  onDone?: () => void;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const run = useMutation(trpc.layerTemplates.applyToClips.mutationOptions());
  const one = clipIds.length === 1;
  const existing = one
    ? existingOnClip(withLayers)
    : withLayers
      ? `${withLayers} of the ${plural(clipIds.length, "selected clip")} already ${withLayers === 1 ? "has" : "have"} layers.`
      : null;
  const apply = (t: Template, mode: ApplyMode, rerender: boolean) =>
    run.mutateAsync(
      { templateId: t.id, projectId, clipIds, mode, rerender },
      {
        onSuccess: (r) => {
          void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
          const parts = [
            `Applied ${t.name} to ${plural(r.updated, "clip")}`,
            r.bumpers.length && r.updated ? `${r.bumpers.join(" and ")} set` : "",
            r.rerendered ? `re-rendering ${r.rerendered}` : "",
            r.skipped.length ? `${r.skipped.length} skipped (still preparing)` : "",
            r.layersSkipped ? `${plural(r.layersSkipped, "layer")} had no room` : "",
          ].filter(Boolean);
          toast(parts.join(" · "), { description: rerender || !r.updated ? undefined : "The changes show on the next render." });
          onOpenChange(false);
          onDone?.();
        },
        onError: (e) => toast.error(e.message),
      },
    );
  return (
    <ApplyTemplateDialog
      open={open}
      onOpenChange={onOpenChange}
      title={one ? "Apply a template to this clip" : `Apply a template to ${plural(clipIds.length, "clip")}`}
      existing={existing}
      pending={run.isPending}
      actions={[
        { label: "Apply", title: "The layers show on the next render", run: (t, m) => apply(t, m, false) },
        {
          label: one ? "Apply & re-render" : `Apply & re-render ${rerenderable}`,
          primary: true,
          disabled: !rerenderable,
          title: rerenderable ? undefined : one ? "This clip is not rendered yet" : "None of the selected clips is rendered yet",
          run: (t, m) => apply(t, m, true),
        },
      ]}
    />
  );
}

/** The selection bar's "Template…" action: a button and the server dialog for the selected clips. Pass `open` to drive it from the bar's ⋯ menu. */
export function BulkTemplateButton({
  projectId,
  clips,
  rerenderable,
  onDone,
  className,
  open: openProp,
  onOpenChange,
}: {
  projectId: string;
  clips: Array<{ id: string; layers?: unknown[] | null }>;
  rerenderable: number;
  onDone: () => void;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [inner, setInner] = useState(false);
  const open = openProp ?? inner;
  const setOpen = (next: boolean) => {
    onOpenChange?.(next);
    if (openProp === undefined) setInner(next);
  };
  return (
    <>
      {openProp === undefined && (
        <button className={className} title={`Apply a layer template to ${plural(clips.length, "clip")}`} onClick={() => setOpen(true)}>
          Template…
        </button>
      )}
      <ApplyTemplateToClipsDialog
        open={open}
        onOpenChange={setOpen}
        projectId={projectId}
        clipIds={clips.map((c) => c.id)}
        withLayers={clips.filter((c) => (c.layers?.length ?? 0) > 0).length}
        rerenderable={rerenderable}
        onDone={onDone}
      />
    </>
  );
}

/**
 * The editor's local apply: the template is resolved against the clip's range and written into the editor's document
 * (one undo step, saved with the clip; nothing reaches the server until the clip is saved), its intro / outro over the
 * clip's own choice. Returns the layers it added so the caller can select and show them.
 */
export function applyTemplateLocally(
  template: Template,
  mode: ApplyMode,
  layers: ClipLayer[],
  range: [number, number],
  bumpers: ClipBumpers,
): { next: ClipLayer[]; added: ClipLayer[]; noRoom: number; bumpers: ClipBumpers } | null {
  const resolved = resolveTemplateLayers(template.layers, { startSec: range[0], endSec: range[1] });
  const room = MAX_CLIP_LAYERS - (mode === "add" ? layers.length : 0);
  if (room <= 0) {
    toast(`A clip can have at most ${MAX_CLIP_LAYERS} layers`);
    return null;
  }
  const added = resolved.layers.slice(0, room);
  const noRoom = resolved.skipped.length + (resolved.layers.length - added.length);
  const slots = templateBumperSlots(template.bumpers);
  toast(
    `Applied “${template.name}” · ${plural(added.length, "layer")}${slots.length ? ` + ${slots.join(" and ")}` : ""}${noRoom ? ` (${noRoom} had no room on this clip)` : ""}`,
    { description: "Save the clip to render them." },
  );
  return { next: mode === "add" ? [...layers, ...added] : added, added, noRoom, bumpers: mergeTemplateBumpers(bumpers, template.bumpers) ?? {} };
}

/**
 * Name the editor's current layers and save them as a template (`templateFromLayers` decides each layer's timing), with
 * the intro / outro the clip renders with (`bumpers`: only the slots that have one).
 */
export function SaveAsTemplateDialog({
  open,
  onOpenChange,
  layers,
  range,
  defaultName,
  bumpers,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  layers: ClipLayer[];
  range: [number, number];
  defaultName: string;
  bumpers?: TemplateBumpers | null;
}) {
  const slots = templateBumperSlots(bumpers);
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName(defaultName.trim().slice(0, 120));
  }, [open, defaultName]);
  const create = useMutation({
    ...trpc.layerTemplates.create.mutationOptions(),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: trpc.layerTemplates.list.queryKey() });
      toast(`Saved “${r.name}” as a template`, { description: "Fix its timings on the Templates page." });
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Save as template">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim() || create.isPending) return;
          create.mutate({
            name: name.trim(),
            layers: templateFromLayers(layers, { startSec: range[0], endSec: range[1] }),
            bumpers: slots.length ? bumpers : null,
          });
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Name
          <input className="input" value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        <p className="text-xs leading-snug text-ink3">
          Saves {[layers.length ? `the ${plural(layers.length, "layer")}` : "", slots.length ? `the ${slots.join(" and ")}` : ""].filter(Boolean).join(" and ")}{" "}
          as they are in the editor now
          {layers.length ? ": a layer that spans the clip fills, the rest keep their length and anchor to the nearer edge." : "."}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className="btn-ink min-w-[6rem]" disabled={!name.trim() || create.isPending}>
            {create.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Project menu → Layer template…: the template new clips of this project start with. */
export function ProjectTemplateModal({
  open,
  onOpenChange,
  projectId,
  templateId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  templateId?: string | null | undefined;
}) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [v, setV] = useState(templateId ?? "");
  useEffect(() => {
    if (open) setV(templateId ?? "");
  }, [open, templateId]);
  const save = useMutation({
    ...trpc.projects.update.mutationOptions(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
      toast("Layer template saved");
      onOpenChange(false);
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Layer template">
      <TemplateSelect value={v} onChange={setV} />
      <p className="text-xs text-ink3">Applies to clips created from now on. Existing clips: select them and choose Template…, or use a clip's ⋯ menu.</p>
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button
          className="btn-ink min-w-[6rem]"
          disabled={save.isPending || v === (templateId ?? "")}
          onClick={() => save.mutate({ id: projectId, settings: { layerTemplateId: v || null } })}
        >
          {save.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </Modal>
  );
}
