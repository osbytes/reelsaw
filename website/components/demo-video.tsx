"use client";

// A rendered demo film on the page: muted, looping, autoplaying when allowed (the pattern every
// clipper's landing page uses), with a poster so nothing shifts while it loads. Pauses off screen,
// opens on the poster under prefers-reduced-motion, and the whole picture toggles play / pause
// (a real button does the same for keyboards and screen readers).

import { Pause, Play } from "lucide-react";
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
  const [playing, setPlaying] = useState(false);
  const [wantsMotion, setWantsMotion] = useState(true);
  const [near, setNear] = useState(priority);
  const visible = useRef(false);

  // The source is attached once the element is near the viewport, after the autoplay attribute has
  // had its chance: start it by hand when it can play, if it is on screen and motion is welcome.
  const onCanPlay = () => {
    const el = video.current;
    if (el && el.paused && visible.current && wantsMotion) void el.play().catch(() => {});
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

  // Load when within a screen of the viewport; play only while visible.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (!e) return;
        if (e.isIntersecting) setNear(true);
        visible.current = e.intersectionRatio > 0.2;
        if (!wantsMotion) return;
        if (visible.current) void el.play().catch(() => {});
        else el.pause();
      },
      { rootMargin: "400px 0px", threshold: [0, 0.2] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [wantsMotion]);

  const toggle = () => {
    const el = video.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
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
        onClick={toggle}
        className="block h-full w-full cursor-pointer"
      />
      <button
        type="button"
        onClick={toggle}
        aria-pressed={playing}
        aria-label={playing ? "Pause demo" : "Play demo"}
        className="absolute right-3 bottom-3 grid h-9 w-9 place-items-center rounded-full bg-black/55 text-white/90 backdrop-blur-sm transition hover:bg-black/75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        {playing ? <Pause className="h-4 w-4" aria-hidden /> : <Play className="ml-0.5 h-4 w-4" aria-hidden />}
      </button>
      {!playing && (
        <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="grid h-14 w-14 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm sm:h-16 sm:w-16">
            <Play className="ml-1 h-6 w-6" />
          </span>
        </div>
      )}
    </div>
  );
}
