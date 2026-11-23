/**
 * The shadow timeline (docs/specs/range-clipping.md): the whole length of a video drawn before anything is downloaded,
 * with the ranges to clip on it. Click or tap empty time to add a range, drag a range's ends (or focus one and use the
 * arrow keys) to change it. The list under it types exact times and picks each range's mode.
 */
import { useRef, useState } from "react";
import { X } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { RANGE_MIN_SEC, formatTime, parseClock, type RangeMode, type ReplayPeak } from "@reelsaw/shared";
import { Segmented } from "./ui";

/** A range being drawn on New project, before the project exists. */
export interface DraftRange {
  key: string;
  startSec: number;
  endSec: number;
  mode: RangeMode;
}

/** How long a range made by a click on the timeline is. */
const NEW_RANGE_SEC = 180;

const newKey = () => Math.random().toString(36).slice(2, 10);

/** A range of `len` seconds centred on `at`, inside the video. */
function rangeAround(at: number, durationSec: number, len = NEW_RANGE_SEC): DraftRange {
  const width = Math.min(len, durationSec);
  const startSec = Math.max(0, Math.min(durationSec - width, at - width / 2));
  return { key: newKey(), startSec: Math.round(startSec), endSec: Math.round(startSec + width), mode: "find" };
}

/** Tick marks every 1, 5, 10, 15 or 30 minutes, or every hour: whichever gives at most seven. */
function ticks(durationSec: number): number[] {
  const step = [60, 300, 600, 900, 1800, 3600, 7200].find((s) => durationSec / s <= 7) ?? 7200;
  const out: number[] = [];
  for (let t = 0; t < durationSec - step / 3; t += step) out.push(t);
  return out;
}

export function RangeTimeline({
  durationSec,
  ranges,
  onChange,
  coverSec,
  fixed = [],
  marks = [],
  peaks = [],
  readOnly = false,
}: {
  durationSec: number;
  ranges: DraftRange[];
  onChange: (next: DraftRange[]) => void;
  /** Whole video: the start the minutes cover now is drawn instead of ranges, and the timeline is read-only. */
  coverSec?: number | null | undefined;
  /** time already processed (a project's ranges), drawn solid and not editable */
  fixed?: ReadonlyArray<{ startSec: number; endSec: number }>;
  /** clips, drawn as marks inside what was processed */
  marks?: ReadonlyArray<{ startSec: number; endSec: number }>;
  /** the video's Most replayed peaks, drawn under everything else as bars as tall as they are hot */
  peaks?: readonly ReplayPeak[];
  /** drawn only: no range is added or moved (the project page until "Add a range") */
  readOnly?: boolean;
}) {
  const { t } = useLingui();
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ key: string; end: "start" | "end" } | null>(null);
  const pct = (s: number) => `${Math.max(0, Math.min(100, (s / durationSec) * 100))}%`;
  const at = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || r.width <= 0) return 0;
    return Math.max(0, Math.min(durationSec, ((clientX - r.left) / r.width) * durationSec));
  };
  const whole = coverSec !== undefined || readOnly;
  const sorted = [...ranges].sort((a, b) => a.startSec - b.startSec);

  /** move one end of a range to `to`, keeping it at least RANGE_MIN_SEC long and inside the video */
  const moveEnd = (key: string, end: "start" | "end", to: number) =>
    onChange(
      ranges.map((r) => {
        if (r.key !== key) return r;
        const s = Math.round(to);
        return end === "start"
          ? { ...r, startSec: Math.max(0, Math.min(s, r.endSec - RANGE_MIN_SEC)) }
          : { ...r, endSec: Math.min(durationSec, Math.max(s, r.startSec + RANGE_MIN_SEC)) };
      }),
    );

  return (
    // time runs left to right on the track in every language, as on a video player's
    <div className="flex flex-col gap-1.5 pt-6" dir="ltr">
      <div
        ref={track}
        data-testid="range-track"
        className={`relative h-20 rounded-[10px] border border-line ${whole ? "" : "cursor-crosshair"}`}
        style={{ background: "repeating-linear-gradient(135deg, var(--sunk) 0 6px, var(--bg) 6px 12px)" }}
        onPointerDown={(e) => {
          if (whole || e.target !== e.currentTarget) return;
          onChange([...ranges, rangeAround(at(e.clientX), durationSec)]);
        }}
        onPointerMove={(e) => drag && moveEnd(drag.key, drag.end, at(e.clientX))}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
      >
        {peaks.map((p) => (
          <span
            key={`peak-${p.startSec}`}
            aria-hidden="true"
            className="pointer-events-none absolute bottom-0 rounded-t-[3px] bg-ink3/40"
            style={{ insetInlineStart: pct(p.startSec), width: pct(p.endSec - p.startSec), minWidth: 3, height: `${Math.round(25 + p.heat * 70)}%` }}
          />
        ))}
        {fixed.map((r) => (
          <div
            key={`${r.startSec}-${r.endSec}`}
            className="pointer-events-none absolute inset-y-0 rounded-[6px] border border-acc bg-acc-soft"
            style={{ insetInlineStart: pct(r.startSec), width: pct(r.endSec - r.startSec), minWidth: 4 }}
          />
        ))}
        {marks.map((c) => (
          <span
            key={`${c.startSec}-${c.endSec}`}
            className="pointer-events-none absolute top-3 bottom-3 rounded-[2px] bg-acc-text"
            style={{ insetInlineStart: pct(c.startSec), width: pct(c.endSec - c.startSec), minWidth: 3 }}
          />
        ))}
        {coverSec !== undefined && coverSec !== null && (
          <div className="pointer-events-none absolute inset-y-0 start-0 rounded-[8px] border-2 border-acc bg-acc-soft/60" style={{ width: pct(coverSec) }}>
            <span className="absolute -top-6 start-0 whitespace-nowrap text-xs font-semibold text-acc-text">
              {coverSec >= durationSec - 0.5 ? <Trans>The whole video</Trans> : <Trans>Clipped now: 0:00–{formatTime(coverSec)}</Trans>}
            </span>
          </div>
        )}
        {!whole &&
          sorted.map((r, i) => {
            const n = i + 1;
            return (
              <div
                key={r.key}
                className="absolute inset-y-0 rounded-[6px] border-2 border-acc bg-acc-soft/60"
                style={{ insetInlineStart: pct(r.startSec), width: pct(r.endSec - r.startSec), minWidth: 6 }}
              >
                <span className="absolute -top-6 -start-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-acc px-1.5 text-xs font-bold text-acc-ink">
                  {n}
                </span>
                {(["start", "end"] as const).map((end) => {
                  const value = end === "start" ? r.startSec : r.endSec;
                  return (
                    <div
                      key={end}
                      role="slider"
                      tabIndex={0}
                      aria-label={end === "start" ? t`Start of range ${n}` : t`End of range ${n}`}
                      aria-valuemin={0}
                      aria-valuemax={Math.round(durationSec)}
                      aria-valuenow={Math.round(value)}
                      aria-valuetext={formatTime(value)}
                      // 44 px to grab on a phone, a thin bar to see
                      className={`absolute inset-y-0 z-[1] flex w-11 cursor-ew-resize touch-none items-center justify-center ${end === "start" ? "-start-[22px]" : "-end-[22px]"}`}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        track.current?.setPointerCapture(e.pointerId);
                        setDrag({ key: r.key, end });
                      }}
                      onKeyDown={(e) => {
                        const step = e.shiftKey ? 10 : 1;
                        if (e.key === "ArrowLeft" || e.key === "ArrowDown") moveEnd(r.key, end, value - step);
                        else if (e.key === "ArrowRight" || e.key === "ArrowUp") moveEnd(r.key, end, value + step);
                        else return;
                        e.preventDefault();
                      }}
                    >
                      <span className="h-8 w-1.5 rounded-full bg-acc" />
                    </div>
                  );
                })}
              </div>
            );
          })}
      </div>
      <div aria-hidden="true" className="relative h-4 font-mono text-[11px] text-ink3">
        {ticks(durationSec).map((s) => (
          <span key={s} className="absolute top-0" style={{ insetInlineStart: pct(s) }}>
            {formatTime(s)}
          </span>
        ))}
        <span className="absolute end-0 top-0 bg-panel ps-1">{formatTime(durationSec)}</span>
      </div>
    </div>
  );
}

/** A time field: `h:mm:ss`, `m:ss` or seconds, committed on blur or Enter (an unreadable entry goes back). */
function ClockField({ value, onCommit, label }: { value: number; onCommit: (sec: number) => void; label: string }) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    const sec = text === null ? null : parseClock(text);
    if (sec !== null) onCommit(sec);
    setText(null);
  };
  return (
    <input
      className="input w-[88px] py-1.5 font-mono text-[13px]"
      aria-label={label}
      value={text ?? formatTime(value)}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

/** The ranges as rows: their times (typed), length, mode and remove; then a row that adds one by its times. */
export function RangeList({ durationSec, ranges, onChange }: { durationSec: number; ranges: DraftRange[]; onChange: (next: DraftRange[]) => void }) {
  const { t } = useLingui();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const sorted = [...ranges].sort((a, b) => a.startSec - b.startSec);
  const set = (key: string, patch: Partial<DraftRange>) => onChange(ranges.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const add = () => {
    const s = parseClock(from);
    const e = parseClock(to);
    const ends = formatTime(durationSec);
    const min = RANGE_MIN_SEC;
    if (s === null || e === null) return setProblem(t`Use h:mm:ss or m:ss, like 1:15:00.`);
    if (e <= s) return setProblem(t`The end has to come after the start.`);
    if (s >= durationSec) return setProblem(t`The video ends at ${ends}.`);
    if (Math.min(e, durationSec) - s < RANGE_MIN_SEC) return setProblem(t`A range needs at least ${min} seconds.`);
    onChange([...ranges, { key: newKey(), startSec: s, endSec: Math.min(e, durationSec), mode: "find" }]);
    setFrom("");
    setTo("");
    setProblem(null);
  };
  return (
    <div className="flex flex-col">
      {!sorted.length && (
        <p className="rounded-[10px] bg-sunk p-3 text-[13px] text-ink2">
          <Trans>No ranges yet. Click the timeline to add one, or type a start and end below.</Trans>
        </p>
      )}
      {sorted.map((r, i) => {
        const n = i + 1;
        return (
          <div key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-line border-b py-2.5">
            <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-acc px-1.5 text-xs font-bold text-acc-ink">{n}</span>
            <div className="flex items-center gap-1.5">
              <ClockField
                label={t`Start of range ${n}`}
                value={r.startSec}
                onCommit={(s) => set(r.key, { startSec: Math.max(0, Math.min(s, r.endSec - RANGE_MIN_SEC)) })}
              />
              <span className="text-ink3">–</span>
              <ClockField
                label={t`End of range ${n}`}
                value={r.endSec}
                onCommit={(s) => set(r.key, { endSec: Math.min(durationSec, Math.max(s, r.startSec + RANGE_MIN_SEC)) })}
              />
            </div>
            <span className="min-w-16 text-[13px] text-ink3">{formatTime(r.endSec - r.startSec)}</span>
            <Segmented
              size="sm"
              className="ms-auto"
              ariaLabel={t`Range ${n} mode`}
              value={r.mode}
              onChange={(mode) => set(r.key, { mode })}
              options={[
                { value: "find", label: t`Find clips` },
                { value: "clip", label: t`Exact clip` },
              ]}
            />
            <button
              type="button"
              className="btn-quiet flex h-11 w-11 items-center justify-center"
              aria-label={t`Remove range ${n}`}
              onClick={() => onChange(ranges.filter((x) => x.key !== r.key))}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-end gap-2 pt-3">
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink2">
          <Trans>Start</Trans>
          <input
            className="input w-[110px] py-2 font-mono text-[13px]"
            aria-label={t`Start of the new range`}
            placeholder={"1:40:00"}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink2">
          <Trans>End</Trans>
          <input
            className="input w-[110px] py-2 font-mono text-[13px]"
            aria-label={t`End of the new range`}
            placeholder={"1:52:00"}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button type="button" className="btn-ghost h-[38px] px-3.5 text-[13px]" onClick={add}>
          <Trans>Add range</Trans>
        </button>
        <span role="alert" className="min-h-[18px] basis-full text-xs text-err">
          {problem}
        </span>
      </div>
    </div>
  );
}

/**
 * The video's Most replayed peaks as chips, hottest first: each adds that stretch as an exact clip, or takes it away
 * again. Nothing when the site has no heatmap.
 */
export function PeakChips({ peaks, ranges, onChange }: { peaks: readonly ReplayPeak[]; ranges: DraftRange[]; onChange: (next: DraftRange[]) => void }) {
  const { t } = useLingui();
  if (!peaks.length) return null;
  const isOn = (p: ReplayPeak) => ranges.some((r) => r.startSec === p.startSec && r.endSec === p.endSec);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="me-1 text-xs font-semibold text-ink3">
        <Trans>Most replayed</Trans>
      </span>
      {peaks.map((p, i) => {
        const on = isOn(p);
        const n = i + 1;
        return (
          <button
            key={p.startSec}
            type="button"
            aria-pressed={on}
            aria-label={t`Most replayed #${n}`}
            className={`flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs ${on ? "border-acc bg-acc-soft text-acc-text" : "border-line bg-panel text-ink"}`}
            onClick={() =>
              onChange(
                on
                  ? ranges.filter((r) => !(r.startSec === p.startSec && r.endSec === p.endSec))
                  : [...ranges, { key: newKey(), startSec: p.startSec, endSec: p.endSec, mode: "clip" }],
              )
            }
          >
            <b>#{n}</b>
            <span className="font-mono">{formatTime(p.startSec)}</span>
          </button>
        );
      })}
    </div>
  );
}
