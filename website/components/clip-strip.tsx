"use client";

import { msg, plural } from "@lingui/core/runtime-macro";
import { t, rich } from "@/lib/i18n";
// One source, the clips it became: the 16:9 video on the left, its picks on the right, in the model's order.
// Only one clip plays at a time (the one under the pointer or keyboard focus; on a phone, the one scrolled
// into the middle of the row), so the section is calm and light.

import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { DEMO_RUN, clipPoster, clipVideo } from "@/content/demo";
import { LoopVideo } from "./loop-video";

const { source, picks } = DEMO_RUN;

export function ClipStrip() {
  const [active, setActive] = useState(0);
  const row = useRef<HTMLOListElement>(null);

  // Phones: the row scrolls sideways; the card nearest the middle is the one playing.
  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const cards = Array.from(el.children) as HTMLElement[];
    const io = new IntersectionObserver(
      (entries) => {
        if (el.scrollWidth <= el.clientWidth + 1) return; // not scrolling: the pointer decides
        const best = entries.filter((e) => e.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (best) setActive(cards.indexOf(best.target as HTMLElement));
      },
      { root: el, threshold: [0.6, 0.9] },
    );
    for (const c of cards) io.observe(c);
    return () => io.disconnect();
  }, []);

  return (
    <div className="grid grid-cols-1 items-center gap-6 lg:grid-cols-[260px_auto_minmax(0,1fr)] lg:gap-5">
      <figure className="mx-auto flex w-full max-w-[340px] flex-col gap-2 lg:max-w-none">
        <div className="relative aspect-video overflow-hidden rounded-[14px] border border-line bg-film">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/clips/source.jpg" alt="" className="block h-full w-full object-cover" />
          <span className="absolute right-2 bottom-2 rounded-md bg-black/70 px-1.5 py-0.5 font-mono text-xs text-white">{source.length}</span>
        </div>
        <figcaption className="text-xs leading-snug text-ink3">
          {rich(msg`The whole <0/>, 16:9. <1/> came out of it.`, {
            0: source.kind,
            1: <span className="text-ink2">{t(msg`${plural({ clips: DEMO_RUN.clips }, { one: "# clip", other: "# clips" })}`)}</span>,
          })}
        </figcaption>
      </figure>

      <ArrowRight className="mx-auto h-5 w-5 rotate-90 text-acc-text lg:rotate-0" aria-hidden />

      <ol
        ref={row}
        aria-label={t(msg`Clips Reelsaw picked from it, in its own order`)}
        className="-mx-5 flex snap-x snap-mandatory gap-4 overflow-x-auto px-5 pb-2 [scrollbar-width:none] sm:-mx-8 sm:px-8 lg:mx-0 lg:grid lg:grid-cols-4 lg:overflow-visible lg:px-0 lg:pb-0"
      >
        {picks.map((p, k) => (
          <li
            key={p.file}
            className="flex w-[62vw] max-w-[230px] shrink-0 snap-center flex-col gap-2.5 lg:w-auto lg:max-w-none"
            onPointerEnter={() => setActive(k)}
            onFocus={() => setActive(k)}
          >
            <button
              type="button"
              onClick={() => setActive(k)}
              aria-pressed={k === active}
              aria-label={t(msg`Play pick #${{ rank: p.rank }}: ${{ hook: p.hook }}`)}
              className={`relative block aspect-[9/16] w-full overflow-hidden rounded-[14px] border bg-film transition ${k === active ? "border-acc shadow-pop" : "border-line"}`}
            >
              <LoopVideo src={clipVideo(p.file)} poster={clipPoster(p.file)} play={k === active} className="block h-full w-full object-cover" />
              <span className="absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white backdrop-blur-sm">
                #{p.rank}
              </span>
            </button>
            <p className="text-[13px] leading-snug text-ink2 text-pretty">
              <span className="font-semibold text-ink">{/[.?!]$/.test(p.hook) ? p.hook : `${p.hook}.`}</span> {p.why}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}
