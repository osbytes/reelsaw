import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
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
