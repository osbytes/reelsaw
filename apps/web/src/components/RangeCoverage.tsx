/**
 * A project that processed only part of its video (ranges, or the start of a long one; `rangeCoverage` in
 * packages/shared): how it says so on a Projects card and in a ⌘K row, so it is not mistaken for the whole video.
 */
import { Scissors } from "lucide-react";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { formatTime, type RangeCoverage } from "@reelsaw/shared";

/** "3 ranges · 4:30 of 1:02:33", or "20:00 of 1:02:33" for a video processed from its start only. */
export function CoverageText({ c }: { c: RangeCoverage }) {
  const done = formatTime(c.sec);
  const total = formatTime(c.durationSec);
  return c.ranges ? (
    <>
      <Plural value={c.ranges} one="# range" other="# ranges" /> ·{" "}
      <Trans>
        {done} of {total}
      </Trans>
    </>
  ) : (
    <Trans>
      {done} of {total}
    </Trans>
  );
}

/** The sentence a pointer or a screen reader gets: what was clipped, and that the rest was never fetched. */
function useCoverageTitle(c: RangeCoverage): string {
  const { t } = useLingui();
  const done = formatTime(c.sec);
  const total = formatTime(c.durationSec);
  return c.ranges
    ? t`Only ${done} of this ${total} video was clipped, in ranges. The rest was not downloaded or transcribed; add a range on the project page.`
    : t`Only the first ${done} of this ${total} video was clipped. Clip the rest on the project page.`;
}

/**
 * Over a Projects card's thumbnail: the length badge says how much was clipped, and a strip along the bottom edge
 * draws which parts. Takes the place of the plain length badge, so the card keeps its size.
 */
/** `strip: false` while the card's progress bar holds the bottom edge. */
export function CoverageBadge({ c, strip = true }: { c: RangeCoverage; strip?: boolean }) {
  const title = useCoverageTitle(c);
  const done = formatTime(c.sec);
  const total = formatTime(c.durationSec);
  const pct = (s: number) => `${(s / c.durationSec) * 100}%`;
  return (
    <>
      <span title={title} className="absolute bottom-2 end-2 flex items-center gap-1 rounded-[6px] bg-black/65 px-1.5 py-0.5 font-mono text-[11px] text-white">
        <Scissors aria-hidden="true" className="h-3 w-3" />
        <span className="sr-only">{title}</span>
        {/* only the time here, so it clears the clip fan; the card's detail line says how many ranges */}
        <span aria-hidden="true">
          <Trans>
            {done} of {total}
          </Trans>
        </span>
      </span>
      {/* the video's length, hatched, with the clipped parts solid: the timeline of the project page in small */}
      {strip && (
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[3px] bg-white/25">
          {c.spans.map(([s, e]) => (
            <span key={s} className="absolute inset-y-0 bg-acc" style={{ insetInlineStart: pct(s), width: pct(e - s), minWidth: 2 }} />
          ))}
        </div>
      )}
    </>
  );
}

/** "3 ranges · " before a Projects card's detail line; nothing for a video processed from its start only. */
export function RangesCount({ c }: { c: RangeCoverage | null }) {
  if (!c?.ranges) return null;
  return (
    <>
      <Plural value={c.ranges} one="# range" other="# ranges" />
      {" · "}
    </>
  );
}
