import { useMemo, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Music } from "lucide-react";
import { createFuzzy, Highlight } from "../lib/fuzzy";
import { formatTag } from "../lib/library";
import { ScrollArea } from "./scroll-area";
import { Skeleton } from "./ui";

// Rich rows (thumbnails, badges) live here; for a plain list with typeahead use `Combobox` in ui.tsx.

/** What the combobox needs to know about a library asset (a subset of the `library.list` row). */
export interface PickerAsset {
  id: string;
  kind: "video" | "image" | "audio";
  name: string;
  durationSec: number;
  width: number;
  height: number;
  usedBy: number;
  thumbnailUrl?: string;
  mime?: string | null;
}

/** A choice that is not an asset: "Project default (name)", "None", "Leave as it is". */
export interface FixedOption {
  value: string;
  label: string;
  hint?: string;
  icon: ReactNode;
}

export const durationText = (sec: number) => `${sec.toFixed(sec % 1 ? 1 : 0)} s`;
export const assetFacts = (a: PickerAsset) => `${a.kind} · ${durationText(a.durationSec)} · ${a.width}×${a.height}`;

/** The 9:16 thumbnail in a fixed box, so nothing moves while the image loads. */
export function Thumb({ asset, className = "h-9 w-5" }: { asset: Pick<PickerAsset, "name" | "thumbnailUrl"> & { kind?: PickerAsset["kind"] }; className?: string }) {
  return (
    <span className={`relative inline-grid shrink-0 place-items-center overflow-hidden rounded-[4px] border border-line bg-sunk text-ink3 ${className}`}>
      {asset.kind === "audio" ? <Music className="h-3 w-3" aria-hidden /> : asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" /> : null}
    </span>
  );
}
/** "2:31" for music, "4 s" for the short intros and outros. */
export const clockText = (sec: number) => (sec >= 60 ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}` : durationText(sec));

const Badge = ({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "acc" }) => (
  <span className={`shrink-0 rounded-[5px] px-1 py-px text-[10px] font-semibold ${tone === "acc" ? "bg-acc-soft text-acc-text" : "bg-sunk text-ink2"}`}>{children}</span>
);

/** Facts and badges of one asset, shared by the combobox rows. */
function AssetLine({ a, isDefault, slot }: { a: PickerAsset; isDefault: boolean; slot: string }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-ink3">
      <Badge>{formatTag(a.mime) ?? a.kind}</Badge>
      <span className="font-mono">{a.kind === "audio" ? clockText(a.durationSec) : a.kind === "image" ? `shows ${durationText(a.durationSec)} · ${a.width}×${a.height}` : `${durationText(a.durationSec)} · ${a.width}×${a.height}`}</span>
      {isDefault && <Badge tone="acc">default {slot}</Badge>}
      {a.usedBy > 0 && <span>used by {a.usedBy}</span>}
    </span>
  );
}

/**
 * One picker for every intro / outro choice (Radix Popover + cmdk, like MultiCombobox): fixed options
 * on top, then the library with thumbnail, kind, length, size and badges. Typing fuzzy-filters.
 * `known` also holds deleted assets so a project that still uses one shows its name.
 */
export function BumperCombobox({
  value,
  onChange,
  fixed,
  assets,
  known = assets,
  defaultId,
  slot,
  label,
  className = "",
  loading = false,
}: {
  loading?: boolean;
  value: string;
  onChange: (v: string) => void;
  fixed: FixedOption[];
  assets: PickerAsset[];
  known?: PickerAsset[];
  /** the user's default asset for this slot, badged in the list */
  defaultId?: string | null;
  /** what is being picked ("intro", "outro", "overlay"): names the search box and the default badge */
  slot: string;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const fuzzy = useMemo(
    () => ({
      assets: createFuzzy(assets, [{ name: "name", weight: 2 }, { name: "kind", weight: 0.5 }, { name: "mime", weight: 0.3 }]),
      fixed: createFuzzy(fixed, ["label", "hint"], { minMatchCharLength: 1 }),
    }),
    [assets, fixed],
  );
  const pickedFixed = fixed.find((f) => f.value === value);
  const pickedAsset = pickedFixed ? undefined : known.find((a) => a.id === value);
  const removed = pickedAsset && !assets.some((a) => a.id === pickedAsset.id);
  const shownFixed = q.trim() ? fuzzy.fixed.search(q).map((r) => r.item) : fixed;
  const shownAssets = q.trim() ? fuzzy.assets.search(q).map((r) => ({ item: r.item, matches: r.matches })) : assets.map((item) => ({ item, matches: undefined }));
  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };
  const row = "flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-sm data-[selected=true]:bg-sunk";
  return (
    <Popover.Root open={open} onOpenChange={(o) => (setOpen(o), o && setQ(""))}>
      <Popover.Trigger asChild>
        <button type="button" role="combobox" aria-expanded={open} aria-label={label} className={`input flex h-[38px] w-full min-w-0 items-center gap-2 py-1 text-left ${className}`}>
          {pickedFixed ? (
            <span className="grid h-6 w-5 shrink-0 place-items-center text-ink2">{pickedFixed.icon}</span>
          ) : pickedAsset ? (
            <Thumb asset={pickedAsset} className="h-7 w-4" />
          ) : (
            <span className="h-7 w-4 shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {pickedFixed ? pickedFixed.label : pickedAsset ? `${pickedAsset.name}${removed ? " (deleted)" : ""}` : loading ? <Skeleton className="h-3.5 w-28" /> : <span className="text-ink3">Choose…</span>}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-ink3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          // React bubbles events through the portal to the opener's ancestors (the timeline pans on wheel)
          onWheel={(e) => e.stopPropagation()}
          // above the dialogs and popovers it lives in
          className="z-[80] w-[max(var(--radix-popover-trigger-width),18rem)] max-w-[calc(100vw-24px)] overflow-hidden rounded-[12px] border border-line bg-panel text-ink shadow-pop"
        >
          <Command loop shouldFilter={false} value={undefined}>
            <Command.Input value={q} onValueChange={setQ} placeholder={`Search ${slot}s…`} className="w-full border-b border-line bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-ink3" />
            <ScrollArea className="max-h-[min(320px,calc(var(--radix-popover-content-available-height)-60px))]">
              <Command.List className="p-1">
                {!loading && <Command.Empty className="px-3 py-6 text-center text-sm text-ink3">No matches</Command.Empty>}
                {shownFixed.map((f) => (
                  <Command.Item key={`f-${f.value}`} value={`f-${f.value}`} onSelect={() => pick(f.value)} className={row}>
                    <span className="grid h-9 w-5 shrink-0 place-items-center text-ink2">{f.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">{f.label}</span>
                      {f.hint && <span className="block truncate text-[11px] text-ink3">{f.hint}</span>}
                    </span>
                    {f.value === value && <Check className="h-4 w-4 shrink-0 text-acc-text" />}
                  </Command.Item>
                ))}
                {shownFixed.length > 0 && shownAssets.length > 0 && <div className="mx-1.5 my-1 h-px bg-line" role="separator" />}
                {shownAssets.map(({ item: a, matches }) => (
                  <Command.Item key={a.id} value={`a-${a.id}`} onSelect={() => pick(a.id)} className={row}>
                    <Thumb asset={a} className="h-9 w-5" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold">
                        <Highlight text={a.name} matches={matches} k="name" />
                      </span>
                      <AssetLine a={a} isDefault={a.id === defaultId} slot={slot} />
                    </span>
                    {a.id === value && <Check className="h-4 w-4 shrink-0 text-acc-text" />}
                  </Command.Item>
                ))}
                {loading && (
                  <div role="status" aria-busy="true">
                    <span className="sr-only">Loading library…</span>
                    {["w-2/3", "w-1/2", "w-3/5"].map((w, i) => (
                      <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                        <Skeleton className="h-9 w-5 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="flex h-5 items-center">
                            <Skeleton className={`h-3.5 ${w}`} />
                          </span>
                          <span className="flex h-4 items-center">
                            <Skeleton className="h-2.5 w-1/3" />
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </Command.List>
            </ScrollArea>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
