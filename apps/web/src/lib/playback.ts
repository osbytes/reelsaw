import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";

/**
 * A playhead position that changes every frame while playing. It lives outside React state so only
 * the components that draw it (timeline playhead, preview) re-render at frame rate; everything else
 * reads it on demand or follows a coarser state.
 */
export interface Clock {
  get: () => number;
  set: (t: number) => void;
  subscribe: (l: () => void) => () => void;
}

export function createClock(initial: number): Clock {
  let t = initial;
  const ls = new Set<() => void>();
  return {
    get: () => t,
    set: (next) => {
      if (next === t) return;
      t = next;
      for (const l of ls) l();
    },
    subscribe: (l) => {
      ls.add(l);
      return () => ls.delete(l);
    },
  };
}

export function useClock(clock: Clock): number {
  return useSyncExternalStore(clock.subscribe, clock.get);
}

export interface LoopSpec {
  /** what is looping (e.g. a transcript fix id) */
  key: string;
  start: number;
  end: number;
  /** server-rendered audio for the span (e.g. with a cut applied); plays instead of the video */
  src?: string;
}

export interface Playback {
  /** something is audible right now: the video, or the loop's audio */
  playing: boolean;
  loop: LoopSpec | null;
  /** the user paused the loop (Space / Play); false while it is still starting up */
  loopPaused: boolean;
  /** pause / resume whatever is active; a loop stays armed while paused */
  toggle: () => void;
  startLoop: (l: LoopSpec) => void;
  stopLoop: () => void;
  /** spread onto the source <video> so its play state is tracked */
  videoProps: { onPlay: () => void; onPause: () => void };
}

/**
 * One owner for what's audible on the project page: the source video, or a span of it on repeat
 * (straight from the video, or a server-rendered preview). Space, the Play button and the
 * transcript's play-in-context all go through it, so they always agree on what's playing.
 */
export function usePlayback(videoRef: RefObject<HTMLVideoElement | null>): Playback {
  const [loop, setLoop] = useState<LoopSpec | null>(null);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  // intent, not media state: media reports "paused" for a moment while a loop starts or wraps
  const [loopPaused, setLoopPaused] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loopRef = useRef(loop);
  loopRef.current = loop;

  const audio = () => {
    if (!audioRef.current) {
      const a = new Audio();
      a.loop = true;
      a.onplay = () => setAudioPlaying(true);
      a.onpause = () => setAudioPlaying(false);
      audioRef.current = a;
    }
    return audioRef.current;
  };

  // apply the loop: the video wraps inside the span, or the preview audio plays with the video paused
  useEffect(() => {
    const v = videoRef.current;
    if (!loop) return;
    if (loop.src) {
      v?.pause();
      const a = audio();
      if (a.src !== new URL(loop.src, location.href).href) a.src = loop.src;
      a.currentTime = 0;
      a.play().catch(() => {});
      return () => a.pause();
    }
    audioRef.current?.pause();
    if (!v) return;
    v.currentTime = loop.start;
    v.play().catch(() => {});
    // rAF keeps the wrap tight (timeupdate is ~4 Hz). Landing well outside the span means the user
    // sought elsewhere (scrubbing, ±5s, clicking a word), which ends the loop instead of yanking back.
    let raf = 0;
    const tick = () => {
      const t = v.currentTime;
      if (t < loop.start - 0.5 || t > loop.end + 0.5) {
        setLoop(null);
        return;
      }
      if (t >= loop.end) v.currentTime = loop.start;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loop, videoRef]);

  useEffect(() => () => audioRef.current?.pause(), []);

  return useMemo<Playback>(
    () => ({
      playing: loop?.src ? audioPlaying : videoPlaying,
      loop,
      loopPaused: !!loop && loopPaused,
      toggle: () => {
        const l = loopRef.current;
        const el = l?.src ? audioRef.current : videoRef.current;
        if (!el) return;
        if (el.paused) el.play().catch(() => {});
        else el.pause();
        if (l) setLoopPaused(el.paused); // already updated: play() and pause() flip it synchronously
      },
      startLoop: (l) => {
        setLoopPaused(false);
        setLoop(l);
      },
      stopLoop: () => {
        if (!loopRef.current) return;
        setLoopPaused(false);
        setLoop(null);
        audioRef.current?.pause();
        videoRef.current?.pause();
      },
      videoProps: { onPlay: () => setVideoPlaying(true), onPause: () => setVideoPlaying(false) },
    }),
    [loop, loopPaused, audioPlaying, videoPlaying, videoRef],
  );
}
