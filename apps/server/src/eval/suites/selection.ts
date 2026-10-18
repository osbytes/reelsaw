/**
 * selection: invariants of clip selection on a real stored transcript.
 *  - offline cases: transcript chunking (full coverage, bounded overlap and size, order), the
 *    "05:28 → 528" timestamp repair, and snapping candidates to sentence boundaries within the
 *    configured length.
 *  - `selection-model` (needs models): one real map call per chunk sample; every returned candidate
 *    must land inside its chunk (after repair) and survive snapping. Catches prompt / parsing drift.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { defaultProjectSettings, type ClipCandidate, type TranscriptSegment, type Word } from "@reelsaw/shared";
import { sentenceEndAfter } from "../../pipeline/thought.js";
import { chunkTranscript, repairTimestamps, mapChunk, type LlmOpts, type SelectContext } from "../../pipeline/select.js";
import { snapCandidate } from "../../pipeline/analyze.js";
import { isUnavailable, type CaseResult, type Suite, type EvalContext } from "../framework.js";
import { evalAi } from "../asr.js";

interface TranscriptFixture {
  title: string;
  durationSec: number;
  segments: TranscriptSegment[];
  /** word-level fixtures also run the "clip ends on a complete thought" cases */
  words?: Word[];
  sceneCuts?: number[];
  cases?: Array<{ id: string; propose: [number, number]; expectEnd: number; tolerance: number; windowStart: number }>;
}

async function fixtures(ctx: EvalContext) {
  const root = ctx.fixtures("selection");
  const out: Array<{ name: string; t: TranscriptFixture }> = [];
  for (const name of (await fs.readdir(root)).sort()) {
    const f = path.join(root, name, "transcript.json");
    try {
      out.push({ name, t: JSON.parse(await fs.readFile(f, "utf8")) as TranscriptFixture });
    } catch {
      /* not a transcript fixture */
    }
  }
  return out;
}

const cand = (startSec: number, endSec: number): ClipCandidate => ({ title: "t", hook: "h", startSec, endSec, score: 50, reasoning: "", caption: "", hashtags: [] });

export const selectionSuite: Suite = {
  name: "selection",
  description: "chunking, timestamp repair and sentence snapping invariants on a real transcript",
  needs: [],
  async run(ctx) {
    const out: CaseResult[] = [];
    // timestamp repair: small models write 05:28.0 as 528
    const repairCases: Array<[number, number, number, number]> = [
      [457, 528, 297, 328],
      [540, 607, 340, 367],
      [310, 350, 310, 350],
    ];
    const bad = repairCases.filter(([a, b, ea, eb]) => {
      const r = repairTimestamps(cand(a, b), { start: 300, end: 420 });
      return Math.abs(r.startSec - ea) > 0.01 || Math.abs(r.endSec - eb) > 0.01;
    });
    out.push({ id: "repair-mmss", pass: !bad.length, metrics: { cases: repairCases.length }, notes: bad.map((b) => `${b[0]}-${b[1]}`).join(", ") });

    for (const { name, t } of await fixtures(ctx)) {
      const segs = t.segments;
      const chunks = chunkTranscript(segs);
      const fails: string[] = [];
      // chunks span the whole transcript in order, without gaps, with bounded overlap and size
      const lastEnd = chunks.at(-1)?.end ?? 0;
      if (Math.abs(lastEnd - segs.at(-1)!.end) > 0.01) fails.push(`last chunk ends at ${lastEnd}, transcript at ${segs.at(-1)!.end}`);
      if (Math.abs(chunks[0]!.start - segs[0]!.start) > 0.01) fails.push("first chunk does not start at the first segment");
      for (let i = 1; i < chunks.length; i++) {
        if (chunks[i]!.start < chunks[i - 1]!.start) fails.push(`chunk ${i} starts before chunk ${i - 1}`);
        if (chunks[i]!.start > chunks[i - 1]!.end) fails.push(`gap between chunk ${i - 1} and ${i}`);
        const ov = (chunks[i - 1]!.end - chunks[i]!.start) / Math.max(1, chunks[i - 1]!.end - chunks[i - 1]!.start);
        if (ov > 0.4) fails.push(`chunk ${i} overlaps ${(ov * 100).toFixed(0)}%`);
      }
      const maxChars = Math.max(...chunks.map((c) => c.lines.join("\n").length));
      if (maxChars > 9000 * 1.6) fails.push(`chunk of ${maxChars} chars`);
      out.push({ id: `${name}/chunking`, pass: !fails.length, metrics: { chunks: chunks.length, maxChars, segments: segs.length }, notes: fails.join("; ") });

      // snapping: candidates at odd times snap to segment boundaries within the length range
      const settings = defaultProjectSettings;
      const starts = new Set(segs.map((s) => s.start));
      const ends = new Set(segs.map((s) => s.end));
      const snapFails: string[] = [];
      let tried = 0;
      // like a model: picks line timestamps, but a little off (±2 s), and a rough 35 s length
      for (let k = 0; k < 40; k++) {
        const seg = segs[Math.floor(((k + 0.5) / 40) * (segs.length - 1))]!;
        const jitter = (((k * 7919) % 400) / 100 - 2) * 0.9;
        const s0 = Math.max(0, seg.start + jitter);
        const c = snapCandidate(cand(s0, s0 + 35), segs, [], settings, t.durationSec);
        if (!c) continue;
        tried++;
        const len = c.endSec - c.startSec;
        if (len < settings.minClipSeconds - 0.01 || len > settings.maxClipSeconds + 0.7) snapFails.push(`${s0.toFixed(0)}s → length ${len.toFixed(1)}`);
        const onStart = c.startSec === 0 || [...starts].some((x) => Math.abs(x - 0.25 - c.startSec) < 0.02 || Math.abs(Math.max(0, x - 0.25) - c.startSec) < 0.02);
        const onEnd = Math.abs(c.endSec - t.durationSec) < 0.02 || [...ends].some((x) => Math.abs(x + 0.35 - c.endSec) < 0.02);
        if (!onStart || !onEnd) snapFails.push(`${s0.toFixed(1)}s → ${c.startSec}-${c.endSec} not on sentence boundaries`);
      }
      out.push({ id: `${name}/snapping`, pass: !snapFails.length && tried > 20, metrics: { candidates: tried }, notes: snapFails.slice(0, 4).join("; ") });

      // a clip ends on a complete thought: what the model proposed goes through the real snapper with words
      for (const k of t.cases ?? []) {
        const words = t.words ?? [];
        const c = snapCandidate(cand(k.propose[0], k.propose[1]), segs, t.sceneCuts ?? [], { ...settings, minClipSeconds: 20, maxClipSeconds: 60 }, t.durationSec, { words });
        const bad: string[] = [];
        if (!c) bad.push("candidate dropped");
        else {
          const lastIdx = words.map((w, i) => ((w.start + w.end) / 2 < c.endSec - 0.35 ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
          const signal = sentenceEndAfter(words, lastIdx);
          if (!signal) bad.push(`ends inside a sentence, on "${words[lastIdx]?.text}"`);
          if (Math.abs(c.endSec - k.expectEnd) > k.tolerance) bad.push(`end ${c.endSec} is ${(c.endSec - k.expectEnd).toFixed(2)} s from the user's ${k.expectEnd}`);
          if (c.startSec > k.windowStart + 0.5) bad.push(`starts at ${c.startSec}, after ${k.windowStart}`);
        }
        out.push({ id: `${name}/${k.id}`, pass: !bad.length, metrics: { start: c?.startSec ?? -1, end: c?.endSec ?? -1, expectEnd: k.expectEnd, offBy: c ? Number((c.endSec - k.expectEnd).toFixed(2)) : -1 }, notes: bad.join("; ") });
      }
    }
    return out;
  },
  summarize(results) {
    return { passRate: { value: Number((results.filter((r) => r.pass).length / (results.length || 1)).toFixed(2)), better: "higher" } };
  },
};

export const selectionModelSuite: Suite = {
  name: "selection-model",
  description: "one real map call per sampled chunk: candidates inside the chunk, parseable, snappable",
  needs: ["models"],
  async run(ctx) {
    const out: CaseResult[] = [];
    const cfg = ctx.config();
    let o: LlmOpts;
    try {
      o = { model: await evalAi(ctx).languageModel(), telemetry: false };
    } catch (err) {
      return [{ id: "(model)", pass: false, skipped: (err as Error).message.slice(0, 120) }];
    }
    for (const { name, t } of await fixtures(ctx)) {
      const chunks = chunkTranscript(t.segments);
      const pick = Number(ctx.opt("selection-chunks") ?? 1);
      for (const [i, ch] of chunks.slice(0, pick).entries()) {
        const sc: SelectContext = { title: t.title, durationSec: t.durationSec, minSec: defaultProjectSettings.minClipSeconds, maxSec: defaultProjectSettings.maxClipSeconds };
        const t0 = Date.now();
        try {
          const found = await ctx.cached(["map", cfg.AI_MODEL, ch.lines, sc], () => mapChunk(o, ch, sc));
          const outside = found.filter((c) => c.startSec < ch.start - 5 || c.endSec > ch.end + 5);
          const snapped = found.map((c) => snapCandidate(c, t.segments, [], defaultProjectSettings, t.durationSec)).filter(Boolean);
          // model-free quality proxies, comparable across models: how many proposals already respect the
          // length range, how many overlap another proposal (duplicates), and whether hooks are real
          const inRange = found.filter((c) => c.endSec - c.startSec >= sc.minSec && c.endSec - c.startSec <= sc.maxSec).length;
          const overlapping = found.filter((c, k) => found.some((d, j) => j !== k && Math.min(c.endSec, d.endSec) - Math.max(c.startSec, d.startSec) > 0.5 * Math.min(c.endSec - c.startSec, d.endSec - d.startSec))).length;
          const weakHooks = found.filter((c) => c.hook.trim().length < 12 || c.hook.trim().toLowerCase() === c.title.trim().toLowerCase()).length;
          const pass = found.length > 0 && !outside.length && snapped.length >= Math.ceil(found.length / 2);
          out.push({
            id: `${name}/chunk-${i}`,
            pass,
            metrics: { candidates: found.length, outside: outside.length, snappable: snapped.length, inRange, overlapping, weakHooks, sec: Number(((Date.now() - t0) / 1000).toFixed(1)) },
            notes: outside.map((c) => `${c.startSec}-${c.endSec}`).join(", "),
          });
        } catch (err) {
          if (isUnavailable(err)) out.push({ id: `${name}/chunk-${i}`, pass: false, skipped: `model unavailable: ${(err as Error).message.slice(0, 100)}` });
          else out.push({ id: `${name}/chunk-${i}`, pass: false, notes: (err as Error).message.slice(0, 160) });
        }
      }
    }
    return out;
  },
  summarize(results) {
    const n = (k: string) => results.reduce((a, r) => a + Number(r.metrics?.[k] ?? 0), 0);
    const candidates = n("candidates");
    const rate = (k: string) => Number((candidates ? n(k) / candidates : 0).toFixed(2));
    return {
      passRate: { value: Number((results.filter((r) => r.pass).length / (results.length || 1)).toFixed(2)), better: "higher" },
      candidatesPerChunk: { value: Number((candidates / (results.length || 1)).toFixed(1)), better: "higher" },
      inRangeRate: { value: rate("inRange"), better: "higher", tolerance: 0.1 },
      overlapRate: { value: rate("overlapping"), better: "lower", tolerance: 0.1 },
      weakHookRate: { value: rate("weakHooks"), better: "lower", tolerance: 0.1 },
    };
  },
};
