/**
 * Ranges of a video (docs/specs/range-clipping.md): the parts of a long video a project fetches, transcribes, picks
 * from and counts, instead of all of it. A range is `[startSec, endSec)` on the source's clock with a mode: `find`
 * (pick moments inside it) or `clip` (the range is the clip). The web timeline, `check_source`, `create_project`,
 * `extend_project` and the CLI all plan through `planRanges`, so the price a person sees is the price charged.
 */
import { z } from "zod";
import { formatTime } from "./index.js";

export const RANGE_MODES = ["find", "clip"] as const;
export type RangeMode = (typeof RANGE_MODES)[number];

/** Seconds fetched and transcribed on each side of a range for context; never counted. */
export const RANGE_PAD_SEC = 15;
/** Ranges closer than this (after padding) are fetched as one download; still separate ranges, billed apart. */
export const RANGE_FETCH_GAP_SEC = 60;
/** The shortest range accepted. */
export const RANGE_MIN_SEC = 10;
/** The most ranges one request may carry. */
export const MAX_RANGES = 50;

export const rangeSchema = z.object({
  startSec: z.number().min(0).describe("Where the range starts, in seconds of the source video"),
  endSec: z.number().positive().describe("Where it ends, in seconds of the source video"),
  mode: z.enum(RANGE_MODES).default("find").describe('"find": pick moments inside it (default); "clip": the range is the clip, its ends snapped to sentences'),
  label: z.string().trim().max(120).optional().describe("A name shown with the range"),
  ref: z.string().trim().max(200).optional().describe("Your own id for it, returned on every clip from it and on clip webhooks"),
});
export type SourceRange = z.output<typeof rangeSchema>;
export type SourceRangeInput = z.input<typeof rangeSchema>;

export type Span = readonly [startSec: number, endSec: number];

/** Spans sorted and joined where they overlap or touch. */
export function mergeSpans(spans: readonly Span[], gapSec = 0): [number, number][] {
  const out: [number, number][] = [];
  for (const [s, e] of [...spans].filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s <= last[1] + gapSec) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** What of `spans` is not inside `minus`. */
export function subtractSpans(spans: readonly Span[], minus: readonly Span[]): [number, number][] {
  const cut = mergeSpans(minus);
  const out: [number, number][] = [];
  for (const [s0, e] of mergeSpans(spans)) {
    let s = s0;
    for (const [ms, me] of cut) {
      if (me <= s || ms >= e) continue;
      if (ms > s) out.push([s, ms]);
      s = Math.max(s, me);
      if (s >= e) break;
    }
    if (s < e) out.push([s, e]);
  }
  return out;
}

/** Total seconds the spans cover (overlaps once). */
export function spansSec(spans: readonly Span[]): number {
  return mergeSpans(spans).reduce((a, [s, e]) => a + (e - s), 0);
}

export interface PlannedRange {
  startSec: number;
  endSec: number;
  mode: RangeMode;
  label?: string;
  ref?: string;
  /** indexes of the requested ranges this one stands for (more than one when they overlapped) */
  inputs: number[];
  /** seconds of it that count: what is not already processed */
  billedSec: number;
}

/** What the planner changed in a request, said back to the person or the caller instead of done quietly. */
export type RangeChange =
  | { kind: "merged"; inputs: number[]; startSec: number; endSec: number }
  | { kind: "clamped"; input: number; endSec: number }
  | { kind: "exact_too_long"; inputs: number[]; maxClipSec: number }
  | { kind: "already_processed"; inputs: number[] };

export type RangeProblem =
  | { kind: "end_before_start"; input: number }
  | { kind: "past_end"; input: number; durationSec: number }
  | { kind: "too_short"; input: number; minSec: number }
  | { kind: "too_many"; count: number; max: number }
  | { kind: "none" };

export interface RangePlanOptions {
  /** the video's length; null when the site did not say (then ranges are checked once the file is known) */
  durationSec: number | null;
  /** the project's longest clip: an exact clip longer than this becomes a find range */
  maxClipSec: number;
  /** spans already processed (adding ranges to a project): they are neither fetched nor counted again */
  processed?: readonly Span[];
  padSec?: number;
  fetchGapSec?: number;
}

export type RangePlan =
  | {
      ok: true;
      ranges: PlannedRange[];
      /** what is downloaded and transcribed: the new time of every range, padded, close ones joined */
      fetch: [number, number][];
      /** seconds that count against minutes (padding and already-processed time excluded) */
      billedSec: number;
      changes: RangeChange[];
    }
  | { ok: false; problems: RangeProblem[] };

/** Validate, clamp, merge and price requested ranges. Pure: every surface calls it with the same inputs. */
export function planRanges(input: readonly SourceRangeInput[], o: RangePlanOptions): RangePlan {
  if (input.length === 0) return { ok: false, problems: [{ kind: "none" }] };
  if (input.length > MAX_RANGES) return { ok: false, problems: [{ kind: "too_many", count: input.length, max: MAX_RANGES }] };
  const pad = o.padSec ?? RANGE_PAD_SEC;
  const gap = o.fetchGapSec ?? RANGE_FETCH_GAP_SEC;
  const d = o.durationSec;
  const problems: RangeProblem[] = [];
  const changes: RangeChange[] = [];

  const ok: (PlannedRange & { order: number })[] = [];
  input.forEach((raw, i) => {
    const r = rangeSchema.parse(raw);
    if (r.endSec <= r.startSec) return void problems.push({ kind: "end_before_start", input: i });
    if (d !== null && r.startSec >= d) return void problems.push({ kind: "past_end", input: i, durationSec: d });
    let end = r.endSec;
    if (d !== null && end > d) {
      end = d;
      changes.push({ kind: "clamped", input: i, endSec: d });
    }
    if (end - r.startSec < RANGE_MIN_SEC) return void problems.push({ kind: "too_short", input: i, minSec: RANGE_MIN_SEC });
    ok.push({
      startSec: r.startSec,
      endSec: end,
      mode: r.mode,
      ...(r.label ? { label: r.label } : {}),
      ...(r.ref ? { ref: r.ref } : {}),
      inputs: [i],
      billedSec: 0,
      order: i,
    });
  });
  if (problems.length) return { ok: false, problems };

  // overlapping (or touching) ranges become one; find wins, since a clip inside a find range is found anyway
  const merged: (typeof ok)[number][] = [];
  for (const s of ok.sort((a, b) => a.startSec - b.startSec || a.order - b.order)) {
    const last = merged.at(-1);
    if (last && s.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, s.endSec);
      last.inputs.push(...s.inputs);
      if (s.mode === "find") last.mode = "find";
      if (!last.label && s.label) last.label = s.label;
      if (!last.ref && s.ref) last.ref = s.ref;
    } else merged.push({ ...s, inputs: [...s.inputs] });
  }
  for (const s of merged) if (s.inputs.length > 1) changes.push({ kind: "merged", inputs: s.inputs, startSec: s.startSec, endSec: s.endSec });
  for (const s of merged)
    if (s.mode === "clip" && s.endSec - s.startSec > o.maxClipSec) {
      s.mode = "find";
      changes.push({ kind: "exact_too_long", inputs: s.inputs, maxClipSec: o.maxClipSec });
    }

  const processed = o.processed ?? [];
  const fresh: [number, number][] = [];
  for (const s of merged) {
    const parts = subtractSpans([[s.startSec, s.endSec]], processed);
    s.billedSec = spansSec(parts);
    if (s.billedSec === 0) changes.push({ kind: "already_processed", inputs: s.inputs });
    fresh.push(...parts);
  }
  const padded = fresh.map(([s, e]): [number, number] => [Math.max(0, s - pad), d === null ? e + pad : Math.min(d, e + pad)]);
  const ranges = merged.map(({ order: _o, ...s }) => s);
  return {
    ok: true,
    ranges,
    fetch: mergeSpans(padded, gap),
    billedSec: ranges.reduce((a, s) => a + s.billedSec, 0),
    changes,
  };
}

/** `h:mm:ss`, `m:ss` or seconds (fractions allowed), as typed in a time field or on the CLI; null when it is none of those. */
export function parseClock(text: string): number | null {
  const parts = text.trim().split(":");
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  if (parts.length > 1 && parts.slice(1).some((p) => Number(p) >= 60)) return null;
  return parts.reduce((a, p) => a * 60 + Number(p), 0);
}

/**
 * One CLI `--range` value: `start-end` or `start-end:clip` (or `:find`), each end a clock (`1:15:00-1:30:00`).
 * Null when it does not parse.
 */
export function parseRangeArg(text: string): SourceRangeInput | null {
  const m = /^\s*([\d:.]+)\s*-\s*([\d:.]+)\s*(?::\s*(find|clip))?\s*$/.exec(text);
  const [, from, to, mode] = m ?? [];
  if (from === undefined || to === undefined) return null;
  const startSec = parseClock(from);
  const endSec = parseClock(to);
  if (startSec === null || endSec === null) return null;
  return { startSec, endSec, mode: (mode as RangeMode | undefined) ?? "find" };
}

/** One sentence per problem, for an API refusal or the CLI (the web words its own). */
export function rangeProblemMessage(p: RangeProblem): string {
  const which = "input" in p ? `Range ${p.input + 1}` : "";
  switch (p.kind) {
    case "none":
      return "Give at least one range.";
    case "too_many":
      return `${p.count} ranges were given; at most ${p.max} fit one request.`;
    case "end_before_start":
      return `${which} ends before it starts.`;
    case "past_end":
      return `${which} starts after the video ends (${formatTime(p.durationSec)}).`;
    case "too_short":
      return `${which} is shorter than ${p.minSec} seconds.`;
  }
}
