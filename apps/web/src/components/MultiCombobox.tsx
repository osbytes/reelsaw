import { useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { ScrollArea } from "./scroll-area";

export interface ComboOption {
  value: string;
  label: string;
  /** small leading text, e.g. an index */
  prefix?: string;
  /** trailing note, e.g. "failed" */
  hint?: ReactNode;
}

/**
 * Multi-select combobox (shadcn pattern: Radix Popover + cmdk). Type to filter, Enter/click toggles,
 * the popover stays open while picking. Selected items show as removable chips in the trigger.
 */
export function MultiCombobox({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder = "Search…",
  empty = "No matches",
  label,
}: {
  options: ComboOption[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  searchPlaceholder?: string;
  empty?: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.filter((o) => value.includes(o.value));
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
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
                    toggle(o.value);
                  }}
                >
                  <X className="h-3 w-3" />
                </span>
              </span>
            ))}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-ink3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          // above the dialog it lives in
          className="z-[80] w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-[12px] border border-line bg-panel text-ink shadow-pop"
        >
          <Command loop>
            <Command.Input placeholder={searchPlaceholder} className="w-full border-b border-line bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-ink3" />
            <ScrollArea className="max-h-[min(280px,calc(var(--radix-popover-content-available-height)-90px))]">
              <Command.List className="p-1">
                <Command.Empty className="px-3 py-6 text-center text-sm text-ink3">{empty}</Command.Empty>
                {options.map((o) => {
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
                })}
              </Command.List>
            </ScrollArea>
            <div className="flex min-h-[36px] items-center justify-between border-t border-line px-3 py-1.5 text-xs text-ink2">
              <span>{value.length ? `${value.length} selected` : "Pick any that show the problem"}</span>
              <span className="flex gap-1">
                {value.length > 0 && (
                  <button type="button" className="rounded-[6px] px-2 py-1 hover:bg-sunk" onClick={() => onChange([])}>
                    Clear
                  </button>
                )}
                <button type="button" className="rounded-[6px] px-2 py-1 font-semibold hover:bg-sunk" onClick={() => setOpen(false)}>
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
