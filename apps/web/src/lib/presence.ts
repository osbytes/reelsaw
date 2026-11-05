import { useEffect } from "react";
import { useTRPCClient } from "./trpc";

/** Input older than this and the person has stepped away, even with the tab in front. */
const IDLE_MS = 2 * 60_000;
const BEAT_MS = 30_000;

/**
 * Tell the server the person is here (`me.presence`, apps/server/src/presence.ts), so a project that
 * finishes while they watch is not mailed to them as "finished while you were away". Only a visible
 * tab with input in the last IDLE_MS counts: polling and open event streams in a forgotten tab do not.
 * Beats every BEAT_MS while that holds, at once on the first input after a quiet spell, and once more
 * as the tab is hidden, so what they saw just before leaving counts as seen.
 */
export function usePresence(enabled: boolean) {
  const client = useTRPCClient();
  useEffect(() => {
    if (!enabled) return;
    let lastInput = Date.now();
    let lastBeat = 0;
    const here = () => document.visibilityState === "visible" && Date.now() - lastInput < IDLE_MS;
    const beat = () => {
      lastBeat = Date.now();
      client.me.presence.mutate().catch(() => {});
    };
    const onInput = () => {
      lastInput = Date.now();
      if (Date.now() - lastBeat >= BEAT_MS && document.visibilityState === "visible") beat();
    };
    const onVisibility = () => {
      // leaving the tab: what was on screen until now was seen. Coming back counts as input.
      if (document.visibilityState === "hidden") {
        if (Date.now() - lastInput < IDLE_MS) beat();
      } else onInput();
    };
    const timer = setInterval(() => {
      if (here()) beat();
    }, BEAT_MS);
    const inputs = ["pointerdown", "keydown", "wheel", "touchstart", "scroll"] as const;
    for (const e of inputs) window.addEventListener(e, onInput, { passive: true, capture: true });
    document.addEventListener("visibilitychange", onVisibility);
    if (here()) beat();
    return () => {
      clearInterval(timer);
      for (const e of inputs) window.removeEventListener(e, onInput, { capture: true });
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client, enabled]);
}
