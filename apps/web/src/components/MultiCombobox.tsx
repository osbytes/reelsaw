import { useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Plus, X } from "lucide-react";
import { ScrollArea } from "./scroll-area";

export interface ComboOption {
  value: string;
  label: string;
  /** small leading text, e.g. an index */
  prefix?: string;
  /** trailing note, e.g. "failed" */
  hint?: ReactNode;
}

export interface Creatable {
  /** Typed text → the value to add, or null when it can't be one (empty after cleanup). Default: trimmed text. */
  normalize?: (q: string) => string | null;
  /** The noun in "Create tag: …". */
  noun?: string;
}

const ci = (s: string) => s.toLocaleLowerCase();

/**
 * Multi-select combobox (shadcn pattern: Radix Popover + cmdk). Type to filter, Enter/click toggles,
 * the popover stays open while picking, Backspace in an empty search drops the last pick. What was
 * picked when it opened is listed first (Linear's label picker), frozen so rows don't jump while
 * toggling. With `creatable`, a search that matches no option offers "Create …: text" as the last
 * row; a created value needs no option and shows as its own chip.
 *
 * The trigger lists the picks as removable chips; pass `trigger` for a different one (e.g. a "+").
 */
export function MultiCombobox({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder = "Search…",
  empty = "No matches",
  label,
  creatable,
  footerHint,
  disabled,
  trigger,
}: {
  options: ComboOption[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  searchPlaceholder?: string;
  empty?: string;
  label: string;
  creatable?: boolean | Creatable;
  /** footer text while nothing is picked */
  footerHint?: ReactNode;
  disabled?: boolean;
  trigger?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pinned, setPinned] = useState<string[]>([]);
  const byValue = new Map(options.map((o) => [o.value, o]));
  const optionFor = (v: string): ComboOption => byValue.get(v) ?? { value: v, label: v };
  const selected = value.map(optionFor);
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  const create = creatable ? (creatable === true ? {} : creatable) : null;
  const draft = create ? (create.normalize ? create.normalize(q) : q.trim() || null) : null;
  const draftTaken = draft != null && [...options.map((o) => o.value), ...options.map((o) => o.label), ...value].some((x) => ci(x) === ci(draft));
  const offerCreate = draft != null && !draftTaken;

  const onOpenChange = (o: boolean) => {
    if (o) setPinned(value);
    else setQ("");
    setOpen(o);
  };
  const top = pinned.map(optionFor);
  const rest = options.filter((o) => !pinned.includes(o.value));

  const row = (o: ComboOption) => {
    const on = value.includes(o.value);
    return (
      <Command.Item
        key={o.value}
        value={`${o.prefix ?? ""} ${o.label} ${o.value}`}
        onSelect={() => toggle(o.value)}
        className="flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-sm data-[selected=true]:bg-sunk"
      >
        <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-[4px] border ${on ? "border-acc bg-acc text-white" : "border-line"}`}>{on && <Check className="h-3 w-3" />}</span>
        {o.prefix && <span className="w-6 shrink-0 text-right font-mono text-xs text-ink3">{o.prefix}</span>}
        <span className="min-w-0 flex-1 truncate">{o.label}</span>
        {o.hint && <span className="shrink-0 text-xs text-ink3">{o.hint}</span>}
      </Command.Item>
    );
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger asChild disabled={disabled}>
        {trigger ?? (
          <button type="button" role="combobox" aria-expanded={open} aria-label={label} className="input flex min-h-[38px] items-center gap-1.5 py-1 text-left">
            <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              {selected.length === 0 && <span className="text-ink3">{placeholder}</span>}
              {selected.map((o) => (
                <span key={o.value} className="inline-flex max-w-full items-center gap-1 rounded-[6px] bg-acc-soft py-0.5 pl-1.5 pr-0.5 text-xs font-semibold text-acc-text">
                  <span className="truncate">
                    {o.prefix ? `${o.prefix} ` : ""}
                    {o.label}
                  </span>
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={`Remove ${o.label}`}
                    className="grid h-4 w-4 shrink-0 place-items-center rounded-[4px] hover:bg-acc/20"
                    onPointerDown={(e) => {
                      // remove without opening the list
                      e.preventDefault();
                      e.stopPropagation();
                      if (!disabled) toggle(o.value);
                    }}
                  >
                    <X className="h-3 w-3" />
                  </span>
                </span>
              ))}
            </span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 text-ink3" />
          </button>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          // above the dialog it lives in
          className="z-[80] w-[max(var(--radix-popover-trigger-width),240px)] overflow-hidden rounded-[12px] border border-line bg-panel text-ink shadow-pop"
        >
          <Command loop>
            <Command.Input
              value={q}
              onValueChange={setQ}
              placeholder={searchPlaceholder}
              aria-label={label}
              className="w-full border-b border-line bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-ink3"
              onKeyDown={(e) => {
                if (e.key === "Backspace" && !q && value.length) onChange(value.slice(0, -1));
              }}
            />
            <ScrollArea className="max-h-[min(280px,calc(var(--radix-popover-content-available-height)-90px))]">
              <Command.List className="p-1">
                <Command.Empty className="px-3 py-6 text-center text-sm text-ink3">{empty}</Command.Empty>
                {top.length > 0 && (
                  <>
                    <Command.Group>{top.map(row)}</Command.Group>
                    {rest.length > 0 && <Command.Separator className="-mx-1 my-1 h-px bg-line" />}
                  </>
                )}
                <Command.Group>{rest.map(row)}</Command.Group>
                {offerCreate && (
                  <Command.Item
                    forceMount
                    value={`create-new ${draft}`}
                    onSelect={() => {
                      onChange([...value, draft]);
                      setQ("");
                    }}
                    className="flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-sm data-[selected=true]:bg-sunk"
                  >
                    <Plus className="h-4 w-4 shrink-0 text-ink3" />
                    <span className="min-w-0 flex-1 truncate">
                      Create {create?.noun ?? "new"}: <span className="text-ink3">“{draft}”</span>
                    </span>
                  </Command.Item>
                )}
              </Command.List>
            </ScrollArea>
            <div className="flex min-h-[36px] items-center justify-between border-t border-line px-3 py-1.5 text-xs text-ink2">
              <span>{value.length ? `${value.length} selected` : (footerHint ?? "None selected")}</span>
              <span className="flex gap-1">
                {value.length > 0 && (
                  <button type="button" className="rounded-[6px] px-2 py-1 hover:bg-sunk" onClick={() => onChange([])}>
                    Clear
                  </button>
                )}
                <button type="button" className="rounded-[6px] px-2 py-1 font-semibold hover:bg-sunk" onClick={() => onOpenChange(false)}>
                  Done
                </button>
              </span>
            </div>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
