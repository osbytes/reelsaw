import { Thumb } from "./BumperCombobox";

export interface SlotSummary {
  assetId: string;
  name: string;
  kind: "video" | "image";
  thumbnailUrl: string;
  withCount: number;
  total: number;
  otherCount: number;
  noneCount: number;
}
export interface ProjectBumpers {
  intro: SlotSummary | null;
  outro: SlotSummary | null;
}

const plural = (n: number) => `${n} clip${n === 1 ? "" : "s"}`;

/** "Outro copia-qr on 3 of 9 clips · 6 clips: none · 1 clip: other asset" */
export function coverageText(slot: "intro" | "outro", s: SlotSummary) {
  const label = slot === "intro" ? "Intro" : "Outro";
  const parts = [`${label} ${s.name} on ${s.withCount} of ${s.total} clips`];
  if (s.noneCount) parts.push(`${plural(s.noneCount)}: none`);
  if (s.otherCount) parts.push(`${plural(s.otherCount)}: other asset`);
  return parts.join(" · ");
}

/**
 * Which intro and outro a project's clips carry, one chip per slot. The line has a fixed height in
 * every card, empty or not, so cards never change height. Each chip opens the project's intro / outro
 * dialog. Full coverage is "● all clips"; partial is "◐ 3 of 9" and also gets a dashed border.
 */
export function BumperChips({ bumpers, onOpen }: { bumpers: ProjectBumpers; onOpen: () => void }) {
  const slots = (["intro", "outro"] as const).flatMap((slot) => (bumpers[slot] ? [{ slot, s: bumpers[slot]! }] : []));
  return (
    // a row that would wrap scrolls sideways instead (principles: rows at 390 px)
    <div className="flex h-8 items-center gap-1.5 overflow-x-auto px-3.5 [scrollbar-width:none]">
      {slots.map(({ slot, s }) => {
        const all = s.withCount === s.total && !s.otherCount && !s.noneCount;
        const text = coverageText(slot, s);
        return (
          <button
            key={slot}
            type="button"
            title={text}
            aria-label={`${text}. Edit intro and outro`}
            onClick={onOpen}
            className={`flex h-8 min-w-0 shrink-0 items-center gap-1 rounded-full border bg-sunk py-0 pl-1 pr-2 text-[11px] leading-none text-ink2 hover:border-line2 hover:text-ink ${all ? "border-line" : "border-dashed border-line2"}`}
          >
            <Thumb asset={s} className="h-6 w-3.5 !rounded-[3px]" />
            <span className="font-semibold text-ink">{slot === "intro" ? "Intro" : "Outro"}</span>
            <span className="max-w-[7rem] truncate">{s.name}</span>
            <span className="shrink-0 whitespace-nowrap font-mono text-[10px]">{all ? "● all clips" : `◐ ${s.withCount} of ${s.total}`}</span>
          </button>
        );
      })}
    </div>
  );
}
