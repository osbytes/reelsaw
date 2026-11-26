/**
 * Event-loop delay: how late timers and I/O callbacks run because something held the loop (a sync parse, a big JSON
 * stringify, worker CPU in this process). A slow request with a high delay was waiting for the loop, not the database.
 *
 *   reelsaw.event_loop.delay   s   stat (gauge: p99 and max over the last window)
 *
 * The histogram is read and reset every WINDOW_MS; the last few windows are kept so a request can ask what the loop
 * looked like while it ran (`recentLoopDelayMs`).
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { gauge } from "./metrics.js";

const WINDOW_MS = 10_000;
/** windows kept: a slow request (≥2 s) is covered by the last 30 s */
const KEEP = 3;

interface Window {
  p99Ms: number;
  maxMs: number;
}

let hist: ReturnType<typeof monitorEventLoopDelay> | undefined;
let timer: NodeJS.Timeout | undefined;
let windows: Window[] = [];

const ms = (ns: number) => Math.round(ns / 1e6);

function roll(): void {
  if (!hist) return;
  // an empty window (no samples yet) reads max 0, not a huge sentinel
  windows = [...windows, { p99Ms: hist.count ? ms(hist.percentile(99)) : 0, maxMs: hist.count ? ms(hist.max) : 0 }].slice(-KEEP);
  hist.reset();
}

/** Start sampling (once per process). Safe to call again. */
export function startLoopLagMonitor(): void {
  if (hist) return;
  hist = monitorEventLoopDelay({ resolution: 20 });
  hist.enable();
  timer = setInterval(roll, WINDOW_MS);
  timer.unref();
  gauge(
    "reelsaw.event_loop.delay",
    "s",
    () => {
      const w = windows.at(-1);
      return w
        ? [
            [w.p99Ms / 1000, { stat: "p99" }],
            [w.maxMs / 1000, { stat: "max" }],
          ]
        : [];
    },
    "How late this process's event loop ran callbacks over the last window",
  );
}

/** The worst event-loop delay in ms over the kept windows and the current one; undefined before the monitor starts. */
export function recentLoopDelayMs(): number | undefined {
  if (!hist) return undefined;
  const current = hist.count ? ms(hist.max) : 0;
  return Math.max(current, ...windows.map((w) => w.maxMs));
}

/** Test hook. */
export function stopLoopLagMonitor(): void {
  hist?.disable();
  if (timer) clearInterval(timer);
  hist = undefined;
  timer = undefined;
  windows = [];
}
