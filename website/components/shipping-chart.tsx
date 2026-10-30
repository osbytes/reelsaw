"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatUtcDate, type ActivityDay, type ReleasesFeed } from "@/lib/releases-data";

const DAY_LABELS = ["", "Mon", "", "Wed", "", "Fri", ""] as const;
/** Level 0 uses line, not sunk, so empty days stay visible on a panel. */
const LEVEL_CLASS = ["bg-line", "bg-acc-soft", "bg-acc/40", "bg-acc/70", "bg-acc"] as const;

function utcLabel(day: string) {
  return formatUtcDate(day, true);
}

function commitsWord(n: number) {
  return n === 1 ? "1 commit" : `${n} commits`;
}

type CellAnchor = { top: number; bottom: number; cx: number };

const TIP_PAD = 8;

export function ShippingChart({ feed, onSelectRelease }: { feed: ReleasesFeed; onSelectRelease?: (tag: string) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [anchor, setAnchor] = useState<CellAnchor | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const cells = useRef(new Map<string, HTMLElement>());
  const leaveTimer = useRef<number>(0);
  const n = feed.weeks.length;
  const openDay = open ? feed.weeks.flatMap((w) => w.days).find((d) => d.date === open) : undefined;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(null);
        setPinned(false);
      }
    };
    const onDoc = (e: PointerEvent) => {
      const t = e.target as Node;
      if (root.current?.contains(t)) return;
      if ((t as HTMLElement).closest?.("[data-shipping-tip]")) return;
      setOpen(null);
      setPinned(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDoc);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDoc);
    };
  }, []);

  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const sync = () => {
      const el = cells.current.get(open);
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchor({ top: r.top, bottom: r.bottom, cx: r.left + r.width / 2 });
    };
    sync();
    window.addEventListener("scroll", sync, true);
    window.addEventListener("resize", sync);
    return () => {
      window.removeEventListener("scroll", sync, true);
      window.removeEventListener("resize", sync);
    };
  }, [open]);

  const cancelLeave = () => {
    if (leaveTimer.current) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = 0;
  };

  const hoverIn = (date: string) => {
    cancelLeave();
    if (!pinned) setOpen(date);
  };

  const hoverOut = () => {
    if (pinned) return;
    cancelLeave();
    leaveTimer.current = window.setTimeout(() => setOpen(null), 140);
  };

  return (
    <div ref={root} className="flex w-fit max-w-full flex-col gap-1.5">
      <h2 id="activity-title" className="sr-only">
        Shipping activity
      </h2>
      <div className="overflow-x-auto overflow-y-visible">
        <div
          role="grid"
          aria-labelledby="activity-title"
          className="inline-grid gap-[2px] [--cell:9px] min-[400px]:[--cell:10px] sm:gap-[3px] sm:[--cell:11px]"
          style={{ gridTemplateColumns: `1.15rem repeat(${n}, var(--cell))` }}
        >
          <div className="col-start-1 row-start-1" />
          {feed.months.map((m) => (
            <div
              key={`${m.label}-${m.weekIndex}`}
              className="h-3 text-[10px] leading-3 text-ink3"
              style={{ gridColumn: m.weekIndex + 2, gridRow: 1 }}
              aria-hidden
            >
              {m.label}
            </div>
          ))}
          {DAY_LABELS.map((d, i) => (
            <div key={i} className="self-center text-[9px] leading-none text-ink3" style={{ gridColumn: 1, gridRow: i + 2 }} aria-hidden>
              {d}
            </div>
          ))}
          {feed.weeks.map((w, wi) =>
            w.days.map((day, di) => (
              <Cell
                key={day.date}
                day={day}
                row={di + 2}
                col={wi + 2}
                open={open === day.date}
                register={(el) => {
                  if (el) cells.current.set(day.date, el);
                  else cells.current.delete(day.date);
                }}
                onHover={() => hoverIn(day.date)}
                onLeave={hoverOut}
                onToggle={() => {
                  if (open === day.date && pinned) {
                    setPinned(false);
                    setOpen(null);
                    return;
                  }
                  setOpen(day.date);
                  setPinned(true);
                }}
              />
            )),
          )}
        </div>
      </div>
      <Legend />
      {mounted &&
        openDay &&
        anchor &&
        createPortal(
          <Tip
            day={openDay}
            anchor={anchor}
            onEnter={cancelLeave}
            onLeave={hoverOut}
            onSelectRelease={(tag) => {
              setPinned(false);
              setOpen(null);
              onSelectRelease?.(tag);
            }}
          />,
          document.body,
        )}
    </div>
  );
}

function Cell({
  day,
  row,
  col,
  open,
  register,
  onHover,
  onLeave,
  onToggle,
}: {
  day: ActivityDay;
  row: number;
  col: number;
  open: boolean;
  register: (el: HTMLElement | null) => void;
  onHover: () => void;
  onLeave: () => void;
  onToggle: () => void;
}) {
  const shipped = day.releases.length > 0;
  const live = day.inWindow && !day.future;
  const label = live
    ? `${utcLabel(day.date)}: ${commitsWord(day.commits)}${shipped ? `, shipped ${day.releases.map((r) => r.version).join(", ")}` : ""}`
    : utcLabel(day.date);
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: the button inside the cell takes focus (ARIA grid pattern)
    <div role="gridcell" className="relative" style={{ gridColumn: col, gridRow: row }}>
      <button
        ref={register}
        type="button"
        disabled={!live}
        aria-label={label}
        aria-expanded={open}
        onClick={live ? onToggle : undefined}
        onPointerEnter={live ? onHover : undefined}
        onPointerLeave={onLeave}
        className={`relative block size-[var(--cell)] rounded-[2px] sm:rounded-[3px] ${live ? LEVEL_CLASS[day.level] : "bg-transparent"} ${live ? "hover:outline hover:outline-1 hover:outline-offset-0 hover:outline-ink3" : ""} ${open ? "outline outline-1 outline-offset-0 outline-ink" : ""} disabled:cursor-default`}
      >
        {shipped && live && (
          <span
            className="pointer-events-none absolute top-1/2 left-1/2 size-[42%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-acc shadow-[0_0_0_1px_var(--acc-ink)]"
            aria-hidden
          />
        )}
      </button>
    </div>
  );
}

function Tip({
  day,
  anchor,
  onEnter,
  onLeave,
  onSelectRelease,
}: {
  day: ActivityDay;
  anchor: CellAnchor;
  onEnter: () => void;
  onLeave: () => void;
  onSelectRelease?: (tag: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const header = document.querySelector("header");
    const insetTop = Math.max(TIP_PAD, (header?.getBoundingClientRect().bottom ?? 0) + TIP_PAD);
    const insetBottom = vh - TIP_PAD;
    const insetLeft = TIP_PAD;
    const insetRight = vw - TIP_PAD;
    el.style.maxHeight = `${Math.max(80, insetBottom - insetTop)}px`;
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const spaceAbove = anchor.top - insetTop - TIP_PAD;
    const spaceBelow = insetBottom - anchor.bottom - TIP_PAD;
    const placeBelow = spaceAbove < th && spaceBelow > spaceAbove;
    const top = Math.min(Math.max(placeBelow ? anchor.bottom + TIP_PAD : anchor.top - TIP_PAD - th, insetTop), Math.max(insetTop, insetBottom - th));
    const left = Math.min(Math.max(anchor.cx - tw / 2, insetLeft), Math.max(insetLeft, insetRight - tw));
    setBox({ left, top });
  }, [anchor, day.date, day.commits, day.releases.length]);

  return (
    <div
      ref={ref}
      role="tooltip"
      data-shipping-tip
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      className="fixed z-[80] w-max max-w-[min(16rem,calc(100vw-1.5rem))] overflow-y-auto rounded-[12px] border border-line bg-panel px-3 py-2 text-left text-xs text-ink shadow-pop"
      style={{ left: box?.left ?? 0, top: box?.top ?? 0, visibility: box ? "visible" : "hidden" }}
    >
      <p className="font-semibold">{utcLabel(day.date)}</p>
      <p className="mt-0.5 text-ink2">{commitsWord(day.commits)}</p>
      {day.releases.length > 0 && (
        <ul className="mt-1.5 flex max-h-40 flex-col gap-1 overflow-y-auto">
          {day.releases.map((r) => (
            <li key={r.tag}>
              <button
                type="button"
                className="font-semibold text-acc-text hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectRelease?.(r.tag);
                }}
              >
                Shipped {r.version}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] leading-none text-ink3">
      <span className="flex items-center gap-1">
        Less
        {LEVEL_CLASS.map((c, i) => (
          <span key={i} className={`inline-block size-2.5 rounded-[2px] ${c}`} />
        ))}
        More
      </span>
      <span className="flex items-center gap-1">
        <span className="relative inline-block size-2.5 rounded-[2px] bg-acc-soft">
          <span className="absolute top-1/2 left-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-acc" />
        </span>
        Release
      </span>
    </div>
  );
}
