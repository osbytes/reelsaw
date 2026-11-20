"use client";

// The hero's right column, built to say what happened at a glance: the long source on top with the stretch
// the clip came from marked on its timeline, and the 9:16 clip Reelsaw made from it underneath, with what the
// pipeline did pointed out beside it (hook, framing, captions). Plays through the run's picks on its own; a dot
// picks one and stops the cycling. The source tile plays the same seconds as the clip, uncut.

import { useCallback, useState } from "react";
import { DEMO_RUN, HERO_ORDER, clipPoster, clipVideo, fmtTime } from "@/content/demo";
import { LoopVideo } from "./loop-video";

const { source } = DEMO_RUN;
const picks = HERO_ORDER.map((rank) => DEMO_RUN.picks.find((p) => p.rank === rank)!);

/** How long the hook shows with default settings (hookSeconds). */
const HOOK_SECONDS = 3.5;

/** What the pipeline did, at the height (fraction of the 9:16 frame) where it shows with default settings. */
const CALLOUTS: { y: number; title: string; body: string; until?: number }[] = [
  { y: 0.16, title: "Hook", body: "written by the model", until: HOOK_SECONDS },
  { y: 0.42, title: "Framing", body: "follows whoever speaks" },
  { y: 0.72, title: "Captions", body: "timed to every word" },
];

export function HeroReel() {
  const [i, setI] = useState(0);
  const [held, setHeld] = useState(false);
  // the clip's playhead, in half seconds: the Hook callout dims once the hook has left the frame
  const [t, setT] = useState(0);
  const onTime = useCallback((v: number) => setT(Math.floor(v * 2) / 2), []);
  const pick = picks[i]!;
  const left = (pick.start / source.seconds) * 100;
  const width = Math.max(((pick.end - pick.start) / source.seconds) * 100, 3);

  return (
    <figure className="mx-auto flex w-full max-w-[460px] flex-col items-center gap-3">
      {/* Where it came from */}
      <div className="flex w-full max-w-[400px] items-center gap-3 rounded-[14px] border border-line bg-panel p-2 pr-3 shadow-pop">
        <div className="relative aspect-video w-[44%] shrink-0 overflow-hidden rounded-[9px] bg-film">
          <LoopVideo
            key={`${pick.file}-src`}
            src={clipVideo(`${pick.file}-before`)}
            poster={clipPoster(`${pick.file}-before`)}
            play
            eager={i === 0}
            label={`The original 16:9 video at ${fmtTime(pick.start)}`}
            className="block h-full w-full object-cover"
          />
          <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">{source.length}</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="truncate text-xs font-semibold text-ink">
            A {Math.round(source.seconds / 60)}-minute {source.kind}
          </p>
          <div className="relative h-2 rounded-full bg-sunk ring-1 ring-line" aria-hidden>
            <span className="absolute -inset-y-0.5 rounded-full bg-acc transition-[left,width] duration-500" style={{ left: `${left}%`, width: `${width}%` }} />
          </div>
          <p className="font-mono text-[11px] text-ink3">
            clip from {fmtTime(pick.start)}–{fmtTime(pick.end)}
          </p>
        </div>
      </div>

      <svg
        width="14"
        height="22"
        viewBox="0 0 14 22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        className="text-acc-text"
        aria-hidden
      >
        <path d="M7 1v18M2 14l5 6 5-6" />
      </svg>

      {/* What it became */}
      <div className="relative w-[70%] max-w-[270px] sm:ml-[150px] sm:w-[270px]">
        <ul className="absolute top-0 right-full hidden h-full w-[150px] sm:block" aria-label="What Reelsaw did">
          {CALLOUTS.map((c) => (
            <li
              key={c.title}
              className={`absolute right-0 flex -translate-y-1/2 items-center gap-2 transition-opacity duration-500 ${c.until !== undefined && t >= c.until ? "opacity-35" : ""}`}
              style={{ top: `${c.y * 100}%` }}
            >
              <span className="text-right leading-tight">
                <span className="block text-xs font-semibold text-ink">{c.title}</span>
                <span className="block text-[11px] text-ink3">{c.body}</span>
              </span>
              <span className="h-px w-5 bg-acc/60" aria-hidden />
              <span className="-mr-1 h-2 w-2 shrink-0 rounded-full bg-acc ring-4 ring-acc-soft" aria-hidden />
            </li>
          ))}
        </ul>
        <div className="relative aspect-[9/16] w-full overflow-hidden rounded-[20px] border border-line bg-film shadow-pop ring-1 ring-acc/30">
          <LoopVideo
            key={pick.file}
            src={clipVideo(pick.file)}
            poster={clipPoster(pick.file)}
            play
            eager={i === 0}
            loop={held}
            onEnded={() => {
              setI((n) => (n + 1) % picks.length);
              setT(0);
            }}
            onTime={onTime}
            label={`The vertical clip Reelsaw rendered from it, with the hook “${pick.hook}” and word-highlight captions`}
            className="block h-full w-full object-cover"
          />
          <span className="absolute top-3 right-3 rounded-full bg-black/60 px-2.5 py-1 text-xs font-semibold text-white backdrop-blur-sm">
            Pick #{pick.rank} of {DEMO_RUN.clips}
          </span>
        </div>
      </div>

      <figcaption className="flex w-full max-w-[400px] flex-col items-center gap-2 text-center sm:ml-[150px] sm:max-w-[270px]">
        {/* Every reason sits in the same cell, only the current one visible, so the box is always as tall as the
            longest and the page under it never moves when the pick changes. */}
        <div className="grid w-full">
          {picks.map((p, k) => (
            <p
              key={p.file}
              aria-hidden={k !== i}
              className={`col-start-1 row-start-1 text-sm leading-snug text-ink2 text-pretty transition-opacity duration-300 ${k === i ? "" : "invisible opacity-0"}`}
            >
              <span className="font-semibold text-ink">Why this moment: </span>
              {p.why}
            </p>
          ))}
        </div>
        <div className="flex gap-1.5" role="group" aria-label="Show a pick">
          {picks.map((p, k) => (
            <button
              key={p.file}
              type="button"
              onClick={() => {
                setI(k);
                setHeld(true);
                setT(0);
              }}
              aria-label={`Pick #${p.rank}: ${p.hook}`}
              aria-pressed={k === i}
              className="grid h-6 place-items-center px-0.5"
            >
              <span className={`block h-1.5 rounded-full transition-all ${k === i ? "w-6 bg-acc" : "w-1.5 bg-line2 hover:bg-ink3"}`} />
            </button>
          ))}
        </div>
      </figcaption>
    </figure>
  );
}
