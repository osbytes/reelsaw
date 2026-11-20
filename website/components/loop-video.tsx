"use client";

// A short muted clip on the page: poster first (so nothing shifts), the file fetched only when it is near the
// viewport, and playing only while the parent says so, it is on screen and the visitor has not asked for
// reduced motion. Every demo clip on the home page goes through this one element.

import { useEffect, useRef, useState, type RefObject } from "react";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}

/** Whether `ref` is on screen (at least `threshold` of it), and whether it has ever come within `margin` of it. */
export function useInView(ref: RefObject<Element | null>, threshold = 0.35, margin = "600px 0px"): { visible: boolean; near: boolean } {
  const [visible, setVisible] = useState(false);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nearIo = new IntersectionObserver(([e]) => e?.isIntersecting && setNear(true), { rootMargin: margin });
    const seenIo = new IntersectionObserver(([e]) => setVisible(!!e && e.intersectionRatio >= threshold), { threshold: [0, threshold] });
    nearIo.observe(el);
    seenIo.observe(el);
    return () => {
      nearIo.disconnect();
      seenIo.disconnect();
    };
  }, [ref, threshold, margin]);
  return { visible, near };
}

type Props = {
  src: string;
  poster: string;
  /** The parent wants it playing (the active pick, the open tab). */
  play: boolean;
  /** What it shows, for people who can't see it; omit when the text around it already says. */
  label?: string;
  loop?: boolean;
  onEnded?: () => void;
  /** Fetch at once (above the fold) instead of when scrolled near. */
  eager?: boolean;
  /** Called every frame while it plays, with the playhead in seconds (for overlays drawn over it). */
  onTime?: (t: number) => void;
  className?: string;
};

export function LoopVideo({ src, poster, play, label, loop = true, onEnded, eager = false, onTime, className }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const { visible, near } = useInView(ref, 0.25);
  const reduced = useReducedMotion();
  const live = play && visible && !reduced;
  const attached = eager || near;

  useEffect(() => {
    const el = ref.current;
    if (!el || !attached) return;
    if (live) void el.play().catch(() => {});
    else el.pause();
  }, [live, attached]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onTime || !live) return;
    let raf = 0;
    const tick = () => {
      onTime(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [onTime, live]);

  return (
    <video
      ref={ref}
      src={attached ? src : undefined}
      poster={poster}
      muted
      loop={loop}
      playsInline
      preload={eager ? "auto" : "metadata"}
      onEnded={onEnded}
      onCanPlay={(e) => {
        if (live) void e.currentTarget.play().catch(() => {});
      }}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={className}
    />
  );
}
