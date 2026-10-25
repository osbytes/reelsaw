"use client";

// A rendered demo film on the page: muted, looping, autoplaying when allowed (the pattern every
// clipper's landing page uses), with a poster so nothing shifts while it loads. Pauses off screen,
// opens on the poster under prefers-reduced-motion. Clicking the picture opens it near full-screen
// in a <dialog>, because a 1920-wide film in a half-width card is too small to read; the small
// buttons toggle play / pause and expand for keyboards and screen readers.

import { Maximize2, Pause, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type Props = {
  src: string;
  poster: string;
  /** What a viewer sees, for people who can't. */
  label: string;
  width: number;
  height: number;
  /** Fetch eagerly (the hero) instead of when scrolled near. */
  priority?: boolean;
  className?: string;
};

export function DemoVideo({ src, poster, label, width, height, priority = false, className }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const big = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [wantsMotion, setWantsMotion] = useState(true);
  const [near, setNear] = useState(priority);
  const [open, setOpen] = useState(false);
  const visible = useRef(false);

  // The source is attached once the element is near the viewport, after the autoplay attribute has
  // had its chance: start it by hand when it can play, if it is on screen and motion is welcome.
  const onCanPlay = () => {
    const el = video.current;
    if (el && el.paused && visible.current && wantsMotion && !open) void el.play().catch(() => {});
  };

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setWantsMotion(!mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  // Autoplay can start before React attaches handlers: read the element's state, don't assume it.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const sync = () => setPlaying(!el.paused && !el.ended);
    sync();
    el.addEventListener("play", sync);
    el.addEventListener("pause", sync);
    el.addEventListener("ended", sync);
    return () => {
      el.removeEventListener("play", sync);
      el.removeEventListener("pause", sync);
      el.removeEventListener("ended", sync);
    };
  }, []);

  // Load when within a screen of the viewport; play only while visible (and not expanded).
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return;
        if (e.isIntersecting) setNear(true);
        visible.current = e.intersectionRatio > 0.2;
        if (!wantsMotion || open) return;
        if (visible.current) void el.play().catch(() => {});
        else el.pause();
      },
      { rootMargin: "400px 0px", threshold: [0, 0.2] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [wantsMotion, open]);

  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };

  // Expanded view: the same film in a modal dialog, picking up where the inline one was. The inline
  // one pauses meanwhile and resumes (if it was playing) from where the big one got to.
  const expand = () => {
    const d = dialog.current;
    const small = video.current;
    const large = big.current;
    if (!d || !small || !large) return;
    setNear(true);
    large.currentTime = small.currentTime;
    small.pause();
    setOpen(true);
    d.showModal();
    void large.play().catch((e: unknown) => console.warn("[demo-video] expand play", e));
  };

  const collapse = () => {
    const d = dialog.current;
    const small = video.current;
    const large = big.current;
    if (!d || !small || !large) return;
    small.currentTime = large.currentTime;
    large.pause();
    d.close();
    setOpen(false);
    if (wantsMotion && visible.current) void small.play().catch(() => {});
  };

  return (
    <div className={className} style={{ position: "relative", aspectRatio: `${width} / ${height}`, background: "#141416" }}>
      <video
        ref={video}
        src={near ? src : undefined}
        poster={poster}
        width={width}
        height={height}
        muted
        loop
        playsInline
        autoPlay={wantsMotion}
        preload={priority ? "auto" : "metadata"}
        aria-label={label}
        onCanPlay={onCanPlay}
        onClick={expand}
        className="block h-full w-full cursor-zoom-in"
      />
      <div className="absolute right-3 bottom-3 flex gap-2">
        <button
          type="button"
          onClick={toggle}
          aria-pressed={playing}
          aria-label={playing ? "Pause demo" : "Play demo"}
          className="grid h-9 w-9 place-items-center rounded-full bg-black/55 text-white/90 backdrop-blur-sm transition hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="ml-0.5 h-4 w-4" aria-hidden />}
        </button>
        <button
          type="button"
          onClick={expand}
          aria-label="Expand demo"
          className="grid h-9 w-9 place-items-center rounded-full bg-black/55 text-white/90 backdrop-blur-sm transition hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <Maximize2 className="h-4 w-4" aria-hidden />
        </button>
      </div>
      {!playing && !open && (
        <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm sm:h-16 sm:w-16">
            <Play className="ml-1 h-6 w-6" />
          </span>
        </div>
      )}

      <dialog
        ref={dialog}
        onClose={() => {
          // Escape closes a modal dialog by itself; keep React and the inline video in step.
          if (open) collapse();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) collapse();
        }}
        aria-label={label}
        className="m-auto max-h-none max-w-none bg-transparent p-0 backdrop:bg-black/85 backdrop:backdrop-blur-sm open:flex open:items-center open:justify-center"
        style={{ width: "100vw", height: "100dvh" }}
      >
        <div className="relative" style={{ width: `min(96vw, calc(96dvh * ${width} / ${height}))`, aspectRatio: `${width} / ${height}` }} onClick={(e) => e.stopPropagation()}>
          <video
            ref={big}
            src={src}
            poster={poster}
            width={width}
            height={height}
            muted
            loop
            playsInline
            preload="none" /* nothing is fetched until expand() calls play() */
            aria-hidden
            onClick={() => {
              const el = big.current;
              if (!el) return;
              if (el.paused) void el.play().catch(() => {});
              else el.pause();
            }}
            className="block h-full w-full cursor-pointer rounded-xl bg-[#141416] shadow-pop"
          />
          <button
            type="button"
            onClick={collapse}
            aria-label="Close"
            className="absolute -top-3 -right-3 grid h-10 w-10 place-items-center rounded-full bg-black/70 text-white backdrop-blur-sm transition hover:bg-black/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:top-3 sm:right-3"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
      </dialog>
    </div>
  );
}
