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

function Column({ slot, summary, onOpen }: { slot: "intro" | "outro"; summary: SlotSummary; onOpen: () => void }) {
  const shown = summary.assets.slice(0, MAX_CARDS);
  const more = summary.assets.length - shown.length;
  const label = slot === "intro" ? "Intro" : "Outro";
  return (
    <div className={`pointer-events-none absolute top-2 flex h-[50%] flex-col ${slot === "intro" ? "left-2 items-start" : "right-2 items-end"}`}>
      {shown.map((a, i) => {
        const all = a.withCount === summary.total;
        const text = cardText(slot, a, summary);
        return (
          <button
            key={a.assetId}
            type="button"
            title={text}
            aria-label={`${text}. Edit intro and outro`}
            onClick={onOpen}
            className={`pointer-events-auto relative h-[34%] shrink-0 overflow-hidden rounded-[6px] bg-sunk shadow-[0_4px_12px_rgba(0,0,0,.45)] ring-2 ring-white/90 transition-transform duration-200 hover:z-20 hover:scale-110 focus-visible:z-20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-acc ${i ? "-mt-1.5" : ""}`}
            style={{ aspectRatio: "9 / 16", zIndex: 10 - i }}
          >
            {a.thumbnailUrl && <img src={a.thumbnailUrl} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />}
            <span aria-hidden className="absolute bottom-0 right-0 rounded-tl-[4px] bg-black/75 px-[3px] text-[8px] leading-[11px] text-white">
              {all ? "●" : "◐"}
            </span>
          </button>
        );
      })}
      {more > 0 && (
        <button
          type="button"
          title={`${more} more ${slot} ${more === 1 ? "asset" : "assets"}`}
          aria-label={`${more} more ${label.toLowerCase()} ${more === 1 ? "asset" : "assets"}. Edit intro and outro`}
          onClick={onOpen}
          className="pointer-events-auto z-0 mt-1 rounded-full bg-black/70 px-1.5 py-0.5 font-mono text-[10px] leading-none text-white"
        >
          +{more}
        </button>
      )}
    </div>
  );
}

/**
 * Small cards on the poster's top corners: the assets the project's clips use as intro (left) and outro (right),
 * most used first. Rendered as a sibling over the card's link (an overlay with `pointer-events-none`; only the cards take clicks),
 * so a click opens the intro / outro dialog without navigating. Same size and look as the clip stack's thumbnails.
 */
export function PosterBumperCards({ bumpers, onOpen }: { bumpers: ProjectBumpers; onOpen: () => void }) {
  if (!bumpers.intro?.assets.length && !bumpers.outro?.assets.length) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 aspect-video">
      {bumpers.intro && bumpers.intro.assets.length > 0 && <Column slot="intro" summary={bumpers.intro} onOpen={onOpen} />}
      {bumpers.outro && bumpers.outro.assets.length > 0 && <Column slot="outro" summary={bumpers.outro} onOpen={onOpen} />}
    </div>
  );
}
