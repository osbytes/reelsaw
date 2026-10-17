import { useMemo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronsUpDown, Download } from "lucide-react";
import { ScrollArea } from "./scroll-area";

export interface PickerModel {
  id: string;
  label: string;
  note?: string;
  installed?: boolean;
}
export interface PickerProvider {
  provider: string;
  title: string;
  available: boolean;
  reason?: string;
  source: "live" | "installed" | "static";
  selfHosted?: { baseUrl: string; server: "ollama" | "speaches" | "openai-compatible"; canPull: boolean };
  models: PickerModel[];
  error?: string;
}

/**
 * Single-select model picker grouped by provider (Radix Popover + cmdk). Type to filter across every
 * provider; a provider without its key is listed greyed with the variable to set; a self-hosted model
 * that is not installed shows a download action instead of being selectable. A typed id that matches
 * nothing can still be chosen ("Use <id>"), since registries lag behind new releases.
 */
export function ModelPicker({
  value,
  onChange,
  providers,
  loading,
  onPull,
  pulling,
  label,
  placeholder = "Pick a model",
}: {
  value: string;
  onChange: (id: string) => void;
  providers: PickerProvider[];
  loading?: boolean;
  /** download onto a self-hosted server; shown for models with installed === false */
  onPull?: (id: string) => void;
  /** ids with a download in progress */
  pulling?: Set<string>;
  label: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const known = useMemo(() => new Map(providers.flatMap((p) => p.models.map((m) => [m.id, { ...m, provider: p }] as const))), [providers]);
  const current = known.get(value);
  const typed = query.trim();
  const canUseTyped = /^[a-z0-9_-]+:\S+$/i.test(typed) && !known.has(typed);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" role="combobox" aria-expanded={open} aria-label={label} className="input flex min-h-[38px] items-center gap-2 py-1 text-left">
          <span className="flex min-w-0 flex-1 flex-col">
            <span className={`truncate font-mono text-xs ${value ? "" : "text-ink3"}`}>{value || placeholder}</span>
            {current?.note && <span className="truncate text-[11px] text-ink3">{current.note}</span>}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-ink3" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12} className="z-[80] w-[var(--radix-popover-trigger-width)] min-w-[360px] overflow-hidden rounded-[12px] border border-line bg-panel text-ink shadow-pop">
          <Command loop>
            <Command.Input value={query} onValueChange={setQuery} placeholder="Search models, or type provider:model…" className="w-full border-b border-line bg-transparent px-3 py-2.5 text-sm outline-none placeholder:text-ink3" />
            <ScrollArea className="max-h-[min(360px,calc(var(--radix-popover-content-available-height)-60px))]">
              <Command.List className="p-1">
                <Command.Empty className="px-3 py-6 text-center text-sm text-ink3">{loading ? "Asking providers…" : "No matches"}</Command.Empty>
                {canUseTyped && (
                  <Command.Group>
                    <Command.Item
                      value={typed}
                      onSelect={() => {
                        onChange(typed);
                        setOpen(false);
                      }}
                      className="flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-sm data-[selected=true]:bg-sunk"
                    >
                      <span className="w-4" />
                      <span className="min-w-0 flex-1 truncate">
                        Use <span className="font-mono text-xs">{typed}</span>
                      </span>
                      <span className="shrink-0 text-xs text-ink3">not in any listing; checked on save</span>
                    </Command.Item>
                  </Command.Group>
                )}
                {providers.map((p) => (
                  <Command.Group
                    key={p.provider}
                    heading={
                      <span className="flex items-baseline justify-between gap-2">
                        <span>{p.title}</span>
                        <span className="truncate font-normal normal-case text-ink3">{p.error ? p.error : !p.available ? p.reason : p.source === "installed" ? `${p.models.filter((m) => m.installed).length} installed` : p.source === "live" ? "live listing" : ""}</span>
                      </span>
                    }
                    className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink3"
                  >
                    {p.models.map((m) => {
                      const on = m.id === value;
                      const needsPull = m.installed === false;
                      const busy = pulling?.has(m.id);
                      return (
                        <Command.Item
                          key={m.id}
                          value={`${p.title} ${m.label} ${m.id} ${m.note ?? ""}`}
                          disabled={!p.available}
                          onSelect={() => {
                            if (needsPull) {
                              if (!busy) onPull?.(m.id);
                              return;
                            }
                            onChange(m.id);
                            setOpen(false);
                          }}
                          className="flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-sm data-[disabled=true]:cursor-not-allowed data-[selected=true]:bg-sunk data-[disabled=true]:opacity-50"
                        >
                          <span className="grid h-4 w-4 shrink-0 place-items-center text-acc">{on && <Check className="h-4 w-4" />}</span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-mono text-xs">{m.label}</span>
                            {m.note && <span className="block truncate text-[11px] text-ink3">{m.note}</span>}
                          </span>
                          {needsPull && (
                            <span className={`inline-flex shrink-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] font-semibold ${busy ? "text-ink3" : "bg-acc-soft text-acc-text"}`}>
                              <Download className="h-3 w-3" />
                              {busy ? "downloading…" : "download"}
                            </span>
                          )}
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ))}
              </Command.List>
            </ScrollArea>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
