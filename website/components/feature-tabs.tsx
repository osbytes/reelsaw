"use client";

// "See it": one feature at a time, each with real output or the real screen, at a size you can read. Plays
// through the tabs on its own while on screen until someone picks one; a tab is a deep link (#see-reframe).
// Every panel's media sits in the same 2:1 box (4:3 on phones), so switching tabs never moves the page.

import Image, { type StaticImageData } from "next/image";
import { ArrowRight } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import editor from "@/public/editor.png";
import transcriptFixes from "@/public/transcript-fixes.png";
import workspace from "@/public/workspace.png";
import { CAPTIONS_FILE, REFRAMES, clipPoster, clipVideo } from "@/content/demo";
import { LoopVideo, useInView, useReducedMotion } from "./loop-video";

const HASH = "see-";
const ADVANCE_MS = 9000;

type Tab = { id: string; label: string; title: string; body: string; media: (on: boolean) => ReactNode };

function Shot({ src, alt }: { src: StaticImageData; alt: string }) {
  return <Image src={src} alt={alt} sizes="(max-width: 1024px) 100vw, 800px" className="h-full w-full object-contain object-top" />;
}

/** Where the crop centres at `t` seconds into the excerpt (the last point at or before t). */
function trackAt(track: [number, number][], t: number): number {
  let x = track[0]![1];
  for (const [at, v] of track) if (at <= t) x = v;
  return x;
}

function Reframe({ on }: { on: boolean }) {
  const [k, setK] = useState(0);
  const [t, setT] = useState(0);
  // quarter seconds are enough for a marker that jumps at a speaker change, and React skips equal values
  const onTime = useCallback((v: number) => setT(Math.floor(v * 4) / 4), []);
  const r = REFRAMES[k]!;
  const x = r.track ? trackAt(r.track, t) : null;
  return (
    <div className="flex h-full w-full items-center justify-center gap-3 p-3 sm:gap-6 sm:p-6">
      <div className="flex min-w-0 flex-[1.7] flex-col gap-2">
        <div className="relative aspect-video overflow-hidden rounded-[10px] border border-line bg-film">
          <LoopVideo
            key={r.file}
            src={clipVideo(`${r.file}-before`)}
            poster={clipPoster(`${r.file}-before`)}
            play={on}
            onTime={r.track ? onTime : undefined}
            className="block h-full w-full object-cover"
          />
          <span className="absolute top-2 left-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] font-semibold text-white">16:9 source</span>
          {x !== null && (
            <span
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-acc px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-acc-ink shadow-pop transition-[left] duration-300"
              style={{ left: `${x * 100}%`, top: `${(r.y ?? 0.35) * 100}%` }}
            >
              speaking
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Example">
          {REFRAMES.map((e, j) => (
            <button
              key={e.file}
              type="button"
              onClick={() => {
                setK(j);
                setT(0);
              }}
              aria-pressed={j === k}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${j === k ? "border-acc bg-acc-soft text-acc-text" : "border-line text-ink2 hover:bg-sunk"}`}
            >
              {e.title}
            </button>
          ))}
        </div>
        <p className="hidden font-mono text-[11px] text-ink3 sm:block">
          {r.layout} · {r.reason}
        </p>
      </div>
      <ArrowRight className="h-5 w-5 shrink-0 text-acc-text" aria-hidden />
      <div className="relative aspect-[9/16] h-full max-h-full overflow-hidden rounded-[12px] border border-acc bg-film">
        <LoopVideo key={r.file} src={clipVideo(r.file)} poster={clipPoster(r.file)} play={on} className="block h-full w-full object-cover" />
        <span className="absolute right-2 bottom-2 rounded-md bg-acc px-1.5 py-0.5 text-[11px] font-semibold text-acc-ink">{r.layout}</span>
      </div>
    </div>
  );
}

const TABS: Tab[] = [
  {
    id: "moments",
    label: "Finds the moments",
    title: "Every pick scored, ranked and explained",
    body: "The model reads the timed transcript, keeps the moments that stand on their own and ranks them head to head. Each clip arrives with its score, the rubric behind it and a one-line reason, so you can disagree with it in a click.",
    media: () => <Shot src={workspace} alt="Project workspace: the source and its transcript on the left, rendered clips with score and layout on the right" />,
  },
  {
    id: "reframe",
    label: "Reframes any shot",
    title: "A layout for every shot, not one crop for the whole video",
    body: "A 1.2 MB face detector on the CPU picks a layout at every cut and keeps the crop on whoever is talking, even when two people share one wide shot. Slides keep their webcam tile underneath. Override it per project, clip or section.",
    media: (on) => <Reframe on={on} />,
  },
  {
    id: "captions",
    label: "Captions that read",
    title: "Built to be read with the sound off",
    body: "Word-by-word highlight timed by forced alignment, key words coloured and enlarged, a hook written for the first seconds, limits on words per line and time on screen, and the source's own burned-in subtitles found and blurred.",
    media: (on) => {
      return (
        <div className="flex h-full w-full items-center justify-center p-3 sm:p-6">
          <div className="aspect-[9/16] h-full overflow-hidden rounded-[12px] border border-line bg-film">
            <LoopVideo src={clipVideo(CAPTIONS_FILE)} poster={clipPoster(CAPTIONS_FILE)} play={on} className="block h-full w-full object-cover" />
          </div>
        </div>
      );
    },
  },
  {
    id: "fixes",
    label: "Fixes you can check",
    title: "Every automatic fix, shown where you read",
    body: "Filler words and false starts cut, misheard names corrected from your vocabulary, long pauses shortened. Each one sits inline in the transcript with accept and reject, and your decisions survive a re-run.",
    media: () => <Shot src={transcriptFixes} alt="Transcript with a misheard name corrected inline, its accept and reject controls, and the list of fixes" />,
  },
  {
    id: "editor",
    label: "A real editor",
    title: "An editor for when the first cut isn't the one",
    body: "Live 9:16 preview, a multi-lane timeline with snapping, frame-accurate trims, layout sections, layers, music and fades, undo and redo. Keyboard first.",
    media: () => <Shot src={editor} alt="Clip editor with a live 9:16 preview, captions panel and multi-lane timeline" />,
  },
];

export function FeatureTabs() {
  const [active, setActive] = useState(0);
  const [touched, setTouched] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const { visible } = useInView(box, 0.4);
  const reduced = useReducedMotion();

  const select = useCallback((k: number, focus = false) => {
    setActive(k);
    setTouched(true);
    if (focus) tabs.current[k]?.focus();
    history.replaceState(null, "", `#${HASH}${TABS[k]!.id}`);
  }, []);

  // A deep link (#see-captions) opens its tab and scrolls to it.
  useEffect(() => {
    const open = () => {
      const id = window.location.hash.slice(1);
      if (!id.startsWith(HASH)) return;
      const k = TABS.findIndex((t) => t.id === id.slice(HASH.length));
      if (k < 0) return;
      setActive(k);
      setTouched(true);
      box.current?.scrollIntoView({ block: "start" });
    };
    open();
    window.addEventListener("hashchange", open);
    return () => window.removeEventListener("hashchange", open);
  }, []);

  useEffect(() => {
    if (touched || reduced || !visible) return;
    const t = setTimeout(() => setActive((k) => (k + 1) % TABS.length), ADVANCE_MS);
    return () => clearTimeout(t);
  }, [active, touched, reduced, visible]);

  const onKey = (e: KeyboardEvent) => {
    const step = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (step) {
      e.preventDefault();
      select((active + step + TABS.length) % TABS.length, true);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      select(e.key === "Home" ? 0 : TABS.length - 1, true);
    }
  };

  const tab = TABS[active]!;
  return (
    <div ref={box} className="grid scroll-mt-24 grid-cols-1 gap-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-10">
      <div
        role="tablist"
        aria-label="Features"
        aria-orientation="vertical"
        onKeyDown={onKey}
        className="-mx-5 flex gap-2 overflow-x-auto px-5 [scrollbar-width:none] sm:-mx-8 sm:px-8 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0"
      >
        {TABS.map((t, k) => (
          <button
            key={t.id}
            ref={(el) => {
              tabs.current[k] = el;
            }}
            id={`${HASH}${t.id}`}
            type="button"
            role="tab"
            aria-selected={k === active}
            aria-controls="see-panel"
            tabIndex={k === active ? 0 : -1}
            onClick={() => select(k)}
            className={`relative shrink-0 overflow-hidden rounded-[10px] border px-3.5 py-2.5 text-left text-sm font-semibold whitespace-nowrap transition lg:whitespace-normal ${k === active ? "border-acc bg-acc-soft text-acc-text" : "border-line bg-panel text-ink2 hover:bg-sunk hover:text-ink"}`}
          >
            {t.label}
            {/* How long until the next tab, while it is still playing through on its own */}
            {k === active && !touched && !reduced && visible && (
              <span
                key={active}
                aria-hidden
                className="absolute inset-x-0 bottom-0 h-0.5 origin-left animate-[see-progress_linear_forwards] bg-acc"
                style={{ animationDuration: `${ADVANCE_MS}ms` }}
              />
            )}
          </button>
        ))}
      </div>

      <div id="see-panel" role="tabpanel" aria-labelledby={`${HASH}${tab.id}`} className="flex min-w-0 flex-col gap-5">
        <div className="flex min-h-[13rem] flex-col gap-2 sm:min-h-[10rem] lg:min-h-[8.5rem]">
          <h3 className="text-[22px] leading-tight font-bold tracking-tight text-balance sm:text-[26px]">{tab.title}</h3>
          <p className="max-w-[68ch] text-[15px] leading-relaxed text-ink2 text-pretty">{tab.body}</p>
        </div>
        <div className="card aspect-[4/3] overflow-hidden bg-sunk shadow-pop sm:aspect-[2/1]">
          {TABS.map((t, k) => (
            <div key={t.id} hidden={k !== active} className="h-full w-full">
              {t.media(k === active)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
