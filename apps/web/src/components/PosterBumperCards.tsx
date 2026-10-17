export interface SlotAsset {
  assetId: string;
  name: string;
  kind: "video" | "image";
  thumbnailUrl: string;
  withCount: number;
}
export interface SlotSummary {
  assetId: string;
  name: string;
  kind: "video" | "image";
  thumbnailUrl: string;
  withCount: number;
  total: number;
  otherCount: number;
  noneCount: number;
  assets: SlotAsset[];
}
export interface ProjectBumpers {
  intro: SlotSummary | null;
  outro: SlotSummary | null;
}

const MAX_CARDS = 3;

/** "Intro copia-qr · all 9 clips" / "Outro promo · 3 of 9 clips · 6 none" */
export function cardText(slot: "intro" | "outro", a: SlotAsset, s: SlotSummary) {
  const label = slot === "intro" ? "Intro" : "Outro";
  const all = a.withCount === s.total;
  const none = s.noneCount && !all ? ` · ${s.noneCount} none` : "";
  return `${label} ${a.name} · ${all ? `all ${s.total} clips` : `${a.withCount} of ${s.total} clips`}${none}`;
}

/** The same fan as the clip stack, at about a quarter of its size (17% of the poster), mirrored for the outro side. */
function Fan({ slot, summary }: { slot: "intro" | "outro"; summary: SlotSummary }) {
  const shown = summary.assets.slice(0, MAX_CARDS);
  const more = summary.assets.length - shown.length;
  const outro = slot === "outro";
  const text = shown.map((a) => cardText(slot, a, summary)).join("; ");
  return (
    <div
      role="img"
      aria-label={`${text}${more > 0 ? `; ${more} more` : ""}`}
      title={text}
      className={`absolute top-2 flex h-[17%] items-start ${outro ? "right-2 flex-row-reverse" : "left-2"}`}
    >
      {shown.map((a, i) => {
        const all = a.withCount === summary.total;
        return (
          <span
            key={a.assetId}
            className="relative h-full shrink-0 overflow-hidden rounded-[6px] bg-sunk shadow-[0_4px_12px_rgba(0,0,0,.45)] ring-2 ring-white/90 transition-transform duration-200 group-hover:translate-y-[2px]"
            style={{
              aspectRatio: "9 / 16",
              [outro ? "marginRight" : "marginLeft"]: i ? "-14%" : 0,
              zIndex: 10 - i,
              // the clip fan rotates around its centre; mirror the direction on the right edge
              transform: `rotate(${(outro ? -1 : 1) * (i - (shown.length - 1) / 2) * 4}deg)`,
            }}
          >
            {a.thumbnailUrl && <img src={a.thumbnailUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />}
            <span aria-hidden className="absolute bottom-0 right-0 rounded-tl-[4px] bg-black/75 px-[3px] text-[8px] leading-[11px] text-white">
              {all ? "●" : "◐"}
            </span>
          </span>
        );
      })}
      {more > 0 && <span className={`z-10 mt-1 rounded-full bg-black/70 px-1.5 py-0.5 font-mono text-[10px] text-white ${outro ? "mr-1.5" : "ml-1.5"}`}>+{more}</span>}
    </div>
  );
}

/**
 * The assets the project's clips use as intro (top-left) and outro (top-right), most used first, drawn like the
 * clip stack at the bottom. Purely visual: the whole poster is the project link, and the tooltip / aria-label carry
 * the coverage ("● all clips", "◐ some").
 */
export function PosterBumperCards({ bumpers }: { bumpers: ProjectBumpers }) {
  return (
    <>
      {bumpers.intro && bumpers.intro.assets.length > 0 && <Fan slot="intro" summary={bumpers.intro} />}
      {bumpers.outro && bumpers.outro.assets.length > 0 && <Fan slot="outro" summary={bumpers.outro} />}
    </>
  );
}
