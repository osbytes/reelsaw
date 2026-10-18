import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { ScrollArea } from "./scroll-area";
import * as Dialog from "@radix-ui/react-dialog";
import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp, ChevronsUpDown, MoreHorizontal } from "lucide-react";
import type { ProjectStatus, ClipStatus } from "@reelsaw/shared";

type Tone = "ok" | "acc" | "warn" | "err" | "idle";
const TONE_BG: Record<Tone, string> = { ok: "bg-ok-soft", acc: "bg-acc-soft", warn: "bg-warn-soft", err: "bg-err-soft", idle: "bg-sunk" };
const TONE_FG: Record<Tone, string> = { ok: "text-ok", acc: "text-acc-text", warn: "text-warn", err: "text-err", idle: "text-ink3" };

const STATUS: Record<ProjectStatus | ClipStatus, [glyph: string, word: string, tone: Tone]> = {
  queued: ["◷", "Queued", "warn"],
  pending: ["○", "Waiting", "idle"],
  ingesting: ["◔", "Downloading", "acc"],
  transcribing: ["◔", "Transcribing", "acc"],
  refining: ["◔", "Refining", "acc"],
  analyzing: ["◔", "Finding moments", "acc"],
  rendering: ["◔", "Rendering", "acc"],
  preparing: ["…", "Preparing", "acc"],
  done: ["●", "Ready", "ok"],
  failed: ["▲", "Failed", "err"],
};

export function statusMeta(status: ProjectStatus | ClipStatus) {
  return STATUS[status] ?? (["○", status, "idle"] as const);
}

/** Status indicator: a glyph and a word, never colour alone. */
export function StatusBadge({ status, label, tone }: { status: ProjectStatus | ClipStatus; label?: string; tone?: Tone }) {
  const [g, w, t] = statusMeta(status);
  return (
    <span className={`chip text-ink ${TONE_BG[tone ?? t]}`}>
      <span className="font-mono">{g}</span> {label ?? w}
    </span>
  );
}

/** Inline status: glyph + word in the tone colour, no background. */
export function StatusText({ status, label, className = "" }: { status: ProjectStatus | ClipStatus; label?: string; className?: string }) {
  const [g, w, t] = statusMeta(status);
  return (
    <span className={`text-xs font-semibold whitespace-nowrap ${TONE_FG[t]} ${className}`}>
      <span className="font-mono">{g}</span> {label ?? w}
    </span>
  );
}

export function Notice({ tone, glyph, children, className = "" }: { tone: Tone; glyph?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex items-start gap-2.5 rounded-[12px] px-3 py-2.5 text-[13px] leading-snug text-ink ${TONE_BG[tone]} ${className}`}>
      {glyph && <span className={`font-mono font-semibold ${TONE_FG[tone]}`}>{glyph}</span>}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-line2 border-t-acc" />;
}

/** Placeholder block for content that is still loading. Size it with the same classes as the real thing. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`block animate-pulse rounded bg-sunk motion-reduce:animate-none ${className}`} />;
}

/** Wraps a skeleton region so assistive tech hears one "Loading…" instead of nothing. */
export function SkeletonRegion({ children, label = "Loading…", className = "" }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function ProgressBar({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div className={`h-1 w-full overflow-hidden rounded-full bg-sunk ${className}`}>
      <div className="h-full rounded-full bg-acc transition-all" style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` }} />
    </div>
  );
}

/** Pill segmented control on a sunk track. */
export function Segmented<T extends string | number>({ value, options, onChange, className = "", size = "md" }: { value: T; options: Array<{ value: T; label: ReactNode; title?: string }>; onChange: (v: T) => void; className?: string; size?: "sm" | "md" }) {
  return (
    <div className={`seg ${className}`} role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-[8px] font-semibold whitespace-nowrap transition ${size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-[13px]"} ${o.value === value ? "bg-panel text-ink shadow-[0_1px_2px_rgba(0,0,0,.12)]" : "text-ink2 hover:text-ink"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

/** Centered confirm / info dialog in the design's style. */
export function Modal({ open, onOpenChange, title, children, width = 420 }: { open: boolean; onOpenChange: (o: boolean) => void; title: ReactNode; children: ReactNode; width?: number }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[71] flex max-h-[90vh] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-[18px] border border-line bg-panel p-5 text-ink shadow-pop outline-none" style={{ maxWidth: width }}>
          <Dialog.Title className="text-lg font-bold">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, body, confirm, danger, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; body: ReactNode; confirm: string; danger?: boolean; onConfirm: () => void }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title}>
      <Dialog.Description asChild>
        <p className="text-sm leading-relaxed text-ink2">{body}</p>
      </Dialog.Description>
      <div className="mt-1 flex justify-end gap-2">
        <button className="btn-ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </button>
        <button
          className={danger ? "btn bg-err font-semibold text-white hover:brightness-110" : "btn-ink"}
          onClick={() => {
            onConfirm();
            onOpenChange(false);
          }}
        >
          {confirm}
        </button>
      </div>
    </Modal>
  );
}

/** Radix Select never accepts "" as an item value, so "no choice" travels as this. */
const NONE = "__none__";

export type SelectOption = { value: string; label: ReactNode; hint?: string; disabled?: boolean };

/**
 * The one dropdown for choosing a value (never a native `<select>`). The trigger matches `.input`
 * (md) or a compact button (sm); give it a width via `className` so a longer label never shifts layout.
 * An option with value "" is allowed (it means "unset").
 */
export function Select({ value, onValueChange, options, placeholder, size = "md", className = "", ariaLabel, onClick }: { value: string; onValueChange: (v: string) => void; options: SelectOption[]; placeholder?: string; size?: "sm" | "md"; className?: string; ariaLabel: string; onClick?: (e: React.MouseEvent) => void }) {
  const cls = size === "sm" ? "rounded-[8px] px-2 py-1 text-xs" : "rounded-[10px] px-3 py-2 text-sm";
  return (
    <RadixSelect.Root value={value === "" ? NONE : value} onValueChange={(v) => onValueChange(v === NONE ? "" : v)}>
      <RadixSelect.Trigger
        aria-label={ariaLabel}
        onClick={onClick}
        className={`flex w-full items-center justify-between gap-2 border border-line bg-panel text-left text-ink outline-none transition focus:border-acc data-[placeholder]:text-ink3 data-[state=open]:border-acc disabled:cursor-not-allowed disabled:opacity-50 ${cls} ${className}`}
      >
        <span className="min-w-0 truncate">
          <RadixSelect.Value placeholder={placeholder} />
        </span>
        <RadixSelect.Icon asChild>
          <ChevronDown className="h-4 w-4 shrink-0 text-ink3" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content position="popper" sideOffset={6} collisionPadding={12} className="menu max-h-[min(20rem,var(--radix-select-content-available-height))] w-[max(var(--radix-select-trigger-width),12rem)] overflow-hidden p-0">
          <RadixSelect.ScrollUpButton className="flex h-6 items-center justify-center text-ink3">
            <ChevronUp className="h-4 w-4" />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="p-1.5">
            {options.map((o) => (
              <RadixSelect.Item key={o.value || NONE} value={o.value === "" ? NONE : o.value} disabled={o.disabled} className="menu-item pr-8 data-[state=checked]:font-semibold relative">
                <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                {o.hint && <span className="menu-hint">{o.hint}</span>}
                <RadixSelect.ItemIndicator className="absolute right-2.5 inline-flex">
                  <Check className="h-4 w-4" />
                </RadixSelect.ItemIndicator>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="flex h-6 items-center justify-center text-ink3">
            <ChevronDown className="h-4 w-4" />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  );
}

export type ComboboxOption = { value: string; label: string; hint?: string };

/**
 * The one single-choice picker with typeahead, for plain lists that are too long for a `Select`
 * (Radix Popover + cmdk). Same trigger as `Select`; give it a width via `className`. Rich rows
 * (thumbnails, badges) are a purpose-built picker such as BumperCombobox.
 */
export function Combobox({ value, onValueChange, options, placeholder = "Choose…", emptyText = "No matches", className = "", ariaLabel, size = "md" }: { value: string; onValueChange: (v: string) => void; options: ComboboxOption[]; placeholder?: string; emptyText?: string; className?: string; ariaLabel: string; size?: "sm" | "md" }) {
  const [open, setOpen] = useState(false);
  const cls = size === "sm" ? "rounded-[8px] px-2 py-1 text-xs" : "rounded-[10px] px-3 py-2 text-sm";
  const current = options.find((o) => o.value === value);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className={`flex w-full items-center justify-between gap-2 border border-line bg-panel text-left text-ink outline-none transition focus:border-acc data-[state=open]:border-acc disabled:cursor-not-allowed disabled:opacity-50 ${cls} ${className}`}
        >
          <span className={`min-w-0 truncate ${current ? "" : "text-ink3"}`}>{current?.label ?? placeholder}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-ink3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12} className="menu z-[80] w-[max(var(--radix-popover-trigger-width),12rem)] overflow-hidden p-0">
          <Command loop>
            <Command.Input placeholder="Type to filter…" className="w-full border-b border-line bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-ink3" />
            <ScrollArea className="max-h-[min(260px,calc(var(--radix-popover-content-available-height)-60px))]">
              <Command.List className="p-1.5">
                <Command.Empty className="px-3 py-6 text-center text-sm text-ink3">{emptyText}</Command.Empty>
                {options.map((o) => (
                  <Command.Item
                    key={o.value}
                    value={`${o.label} ${o.value}`}
                    onSelect={() => {
                      onValueChange(o.value);
                      setOpen(false);
                    }}
                    className="menu-item relative pr-8 data-[selected=true]:bg-sunk"
                  >
                    <span className={o.value === value ? "font-semibold" : ""}>{o.label}</span>
                    {o.hint && <span className="menu-hint">{o.hint}</span>}
                    {o.value === value && <Check className="absolute right-2.5 h-4 w-4" />}
                  </Command.Item>
                ))}
              </Command.List>
            </ScrollArea>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The ⋯ button that opens a row's or page's action menu (use as `DropdownMenu.Trigger asChild`). `sm` is the height of a `btn-ghost text-xs` row button (2rem), `md` of a header button (2.25rem); square. */
export const MoreButton = forwardRef<HTMLButtonElement, Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & { "aria-label": string; size?: "sm" | "md" }>(function MoreButton({ className = "", size = "sm", ...props }, ref) {
  return (
    <button ref={ref} type="button" title="More actions" {...props} className={`btn-ghost shrink-0 px-0 ${size === "sm" ? "h-8 w-8" : "h-9 w-9"} ${className}`}>
      <MoreHorizontal className="h-4 w-4" />
    </button>
  );
});
