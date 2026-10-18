/**
 * creator-spans: where in an episode did the creator cut their own short from?
 *
 * Labels for the selection suite's `creator-picks` cases. A podcast that publishes both the full
 * episode and vertical shorts cut from it has already said which moments it thinks are worth a
 * short; this tool recovers those moments as episode time ranges by matching the short's words
 * to the episode's words:
 *
 *   1. fetch YouTube's json3 auto-captions (`en-orig`) for the short and for the episode (yt-dlp,
 *      cached on disk, with a pause between fetches: YouTube answers 429 after ~6 quick ones)
 *   2. word timings = event tStartMs + seg tOffsetMs
 *   3. index every 5-gram of episode words, look up every 5-gram of the short, and cluster the
 *      hits by offset (episode word index − short word index): one cluster per contiguous piece
 *      the creator kept. A cut that drops more than `gap` words starts a new piece; silence
 *      tightening inside a piece only nudges the offset by a few words and stays in it
 *   4. keep clusters with ≥ `minHits` hits (real pieces have 10-300, coincidental phrases 1-2) and
 *      snap each to the episode's word boundaries: [first matched word start, last matched word end]
 *   5. merge pieces ≤ `merge` s apart in the episode: that is one moment with its pauses tightened
 *      (a weak piece of 2+ hits joins only when it also continues its neighbour in the short)
 *
 * Output, one JSON line per short: `{ episodeId, shortId, hook: <short's title>, spans: [[s, e], …] }`.
 *
 * With `--fixture <name>` it also writes `eval/fixtures/selection/<name>/{transcript.json,picks.json}`:
 * the episode transcript (segments from the manual `en` track when the episode has one, else from
 * the auto track) restricted to ±`--pad` s around the labelled spans plus one `--negative` s stretch
 * far from them, so the committed caption text stays small.
 *
 *   pnpm --filter @reelsaw/server creator-spans <episodeId> <shortId>… [--fixture name] [--split dev|heldout]
 *        [--cache dir] [--sleep 12] [--min-hits 10] [--gap 20] [--merge 10] [--pad 600] [--negative 900]
 *
 * Shorts with a voice-over or text-to-speech will not match (nothing to align); check that every
 * short printed at least one span. Pick the episode by upload date: re-recorded or follow-up
 * episodes with the same guest exist (docs/EVALS.md, "creator picks").
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { TranscriptSegment } from "@reelsaw/shared";
import { exec, findEvalRoot } from "../framework.js";

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Json3Seg[];
}
export interface Json3 {
  events?: Json3Event[];
}

export interface CapWord {
  /** normalised token used for matching */
  key: string;
  /** the word as captioned */
  text: string;
  start: number;
  end: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']/g, "");
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Word timings from a json3 track. A word ends where the next one starts, or where its caption event ends. */
export function json3Words(j: Json3): CapWord[] {
  const out: CapWord[] = [];
  for (const ev of j.events ?? []) {
    const t0 = ev.tStartMs ?? 0;
    const evEnd = (t0 + (ev.dDurationMs ?? 0)) / 1000;
    for (const s of ev.segs ?? []) {
      const text = (s.utf8 ?? "").trim();
      const key = norm(text);
      if (!key) continue;
      out.push({ key, text, start: (t0 + (s.tOffsetMs ?? 0)) / 1000, end: evEnd });
    }
  }
  // a word ends where the next starts (roll-up events overlap), but a gap between events is a pause and stays
  for (let i = 0; i < out.length; i++) {
    const w = out[i]!;
    const next = out[i + 1];
    if (next && next.start > w.start) w.end = Math.min(w.end, next.start);
    if (w.end <= w.start) w.end = w.start + 0.05;
  }
  return out;
}

export interface AlignedSpan {
  start: number;
  end: number;
  hits: number;
  /** the short's own time range for this piece */
  shortStart: number;
  shortEnd: number;
  /** contiguous pieces merged into this span (> 1: the creator tightened pauses inside it) */
  pieces: number;
}

/** The pieces of `episode` the short was cut from (see the header for the method), in episode order. */
export function alignSpans(short: CapWord[], episode: CapWord[], o: { n?: number; minHits?: number; gap?: number; merge?: number } = {}): AlignedSpan[] {
  const n = o.n ?? 5;
  const merge = o.merge ?? 10;
  const minHits = o.minHits ?? 10;
  const gap = o.gap ?? 20;
  const gram = (ws: CapWord[], i: number) => ws.slice(i, i + n).map((w) => w.key).join(" ");
  const index = new Map<string, number[]>();
  for (let j = 0; j + n <= episode.length; j++) {
    const k = gram(episode, j);
    const list = index.get(k);
    if (list) list.push(j);
    else index.set(k, [j]);
  }
  const hits: Array<{ i: number; j: number; off: number }> = [];
  for (let i = 0; i + n <= short.length; i++) for (const j of index.get(gram(short, i)) ?? []) hits.push({ i, j, off: j - i });
  hits.sort((a, b) => a.off - b.off || a.i - b.i);
  const clusters: (typeof hits)[] = [];
  for (const h of hits) {
    const last = clusters.at(-1);
    if (last && h.off - last.at(-1)!.off <= gap) last.push(h);
    else clusters.push([h]);
  }
  const pieces = clusters
    .filter((c) => c.length >= 2)
    .map((c) => {
      const j0 = Math.min(...c.map((h) => h.j));
      const j1 = Math.max(...c.map((h) => h.j)) + n - 1;
      const i0 = Math.min(...c.map((h) => h.i));
      const i1 = Math.max(...c.map((h) => h.i)) + n - 1;
      return { start: r2(episode[j0]!.start), end: r2(episode[j1]!.end), hits: c.length, shortStart: r2(short[i0]!.start), shortEnd: r2(short[i1]!.end), pieces: 1, strong: c.length >= minHits };
    })
    .sort((a, b) => a.start - b.start);
  const spans: Array<AlignedSpan & { strong: boolean }> = [];
  for (const s of pieces) {
    // pieces a few seconds apart in the episode are one moment with its pauses tightened, not two picks.
    // A weak piece (a sentence trimmed mid-way leaves only a few 5-grams) joins only a neighbour it
    // continues in the short too (seamless speech there: a trim inside a sentence, allowed up to 2 × merge),
    // so a phrase repeated elsewhere in the episode never does.
    const last = spans.at(-1);
    const continues = last && Math.abs(s.shortStart - last.shortEnd) <= 2;
    const apart = last ? s.start - last.end : Infinity;
    const bothStrong = last && last.strong && s.strong;
    if (last && (bothStrong ? apart <= merge : continues && apart <= 2 * merge)) {
      Object.assign(last, { end: Math.max(last.end, s.end), hits: last.hits + s.hits, shortStart: Math.min(last.shortStart, s.shortStart), shortEnd: Math.max(last.shortEnd, s.shortEnd), pieces: last.pieces + 1, strong: last.strong || s.strong });
    } else spans.push({ ...s });
  }
  return spans.filter((s) => s.strong).map(({ strong: _s, ...s }) => s);
}

/**
 * Transcript segments (≈ sentences) from a json3 track, the shape the pipeline stores.
 * Manual tracks are punctuated: cues are joined until a sentence ends (or 15 s pass).
 * Auto tracks have no punctuation: words are joined into 4-10 s pieces, cut at the longest pause.
 */
export function json3Segments(j: Json3, track: "manual" | "auto"): TranscriptSegment[] {
  const segs: TranscriptSegment[] = [];
  const push = (start: number, end: number, text: string) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t && end > start) segs.push({ start: r2(start), end: r2(end), text: t });
  };
  if (track === "manual") {
    const cues = (j.events ?? [])
      .filter((e) => e.segs?.length && !e.aAppend)
      .map((e) => ({ start: (e.tStartMs ?? 0) / 1000, end: ((e.tStartMs ?? 0) + (e.dDurationMs ?? 0)) / 1000, text: (e.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\n/g, " ").trim() }))
      .filter((c) => c.text);
    for (let i = 0; i < cues.length - 1; i++) cues[i]!.end = Math.min(cues[i]!.end, cues[i + 1]!.start);
    let cur: { start: number; end: number; text: string } | null = null;
    for (const c of cues) {
      if (!cur) cur = { ...c };
      else {
        cur.end = c.end;
        cur.text += ` ${c.text}`;
      }
      if ((/[.?!…]["'”’)\]]?$/.test(cur.text) && cur.end - cur.start >= 1.5) || cur.end - cur.start >= 15) {
        push(cur.start, cur.end, cur.text);
        cur = null;
      }
    }
    if (cur) push(cur.start, cur.end, cur.text);
    return segs;
  }
  const words = json3Words(j);
  let from = 0;
  while (from < words.length) {
    let to = from;
    let cut = -1;
    let bestGap = -1;
    // grow to at most 10 s; past 4 s cut at the first real pause, else at the longest gap seen
    while (to < words.length && words[to]!.start - words[from]!.start < 10) {
      const next = words[to + 1];
      const pause = next ? next.start - words[to]!.start : Infinity;
      const dur = words[to]!.end - words[from]!.start;
      if (dur >= 2 && pause > bestGap) {
        bestGap = pause;
        cut = to;
      }
      if (dur >= 4 && pause >= 0.8) {
        cut = to;
        break;
      }
      to++;
    }
    if (to >= words.length) cut = words.length - 1;
    if (cut < from) cut = Math.min(words.length - 1, Math.max(from, to - 1));
    push(words[from]!.start, words[cut]!.end, words.slice(from, cut + 1).map((w) => w.text).join(" "));
    from = cut + 1;
  }
  return segs;
}

/**
 * Which parts of the episode a fixture keeps: ±pad around every labelled span (merged), plus one
 * `negative`-second stretch as far as possible from all of them. The negative stretch starts no
 * earlier than 300 s: cold opens replay the best moments and would be positives in disguise.
 */
export function fixtureWindows(spans: Array<[number, number]>, durationSec: number, pad = 600, negative = 900): { windows: Array<[number, number]>; negative: [number, number] | null } {
  const raw = spans.map(([s, e]) => [Math.max(0, s - pad), Math.min(durationSec, e + pad)] as [number, number]).sort((a, b) => a[0] - b[0]);
  const windows: Array<[number, number]> = [];
  for (const w of raw) {
    const last = windows.at(-1);
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else windows.push([...w]);
  }
  let best: [number, number] | null = null;
  let bestDist = -1;
  for (let s = 300; s + negative <= durationSec - 60; s += 30) {
    const e = s + negative;
    if (windows.some(([a, b]) => s < b && e > a)) continue;
    const dist = Math.min(...spans.map(([a, b]) => (e <= a ? a - e : s >= b ? s - b : 0)));
    if (dist > bestDist) {
      bestDist = dist;
      best = [s, e];
    }
  }
  return { windows, negative: best };
}

// ---------------------------------------------------------------- CLI

interface Info {
  id: string;
  title: string;
  duration?: number;
  upload_date?: string;
}

let fetched = 0;

/** json3 tracks + title for one video, from the cache or yt-dlp. Sleeps before every network fetch after the first. */
async function fetchCaptions(id: string, cache: string, pauseSec: number, manual: boolean) {
  const base = path.join(cache, id);
  const auto = `${base}.en-orig.json3`;
  const man = `${base}.en.json3`;
  const info = `${base}.info.json`;
  const need = !existsSync(auto) || !existsSync(info) || (manual && !existsSync(man));
  if (need) {
    if (fetched++ > 0) {
      process.stderr.write(`  waiting ${pauseSec}s before the next caption fetch (YouTube rate limit)\n`);
      await sleep(pauseSec * 1000);
    }
    process.stderr.write(`  fetching captions for ${id}\n`);
    const ytdlp = process.env.YTDLP_PATH || "yt-dlp";
    await fs.mkdir(cache, { recursive: true });
    await exec(ytdlp, ["--js-runtimes", "node", "-q", "--no-warnings", "--skip-download", "--write-info-json", "--write-auto-subs", ...(manual ? ["--write-subs"] : []), "--sub-langs", manual ? "en,en-orig" : "en-orig", "--sub-format", "json3", "-o", base, `https://www.youtube.com/watch?v=${id}`]);
  }
  const meta = JSON.parse(await fs.readFile(info, "utf8")) as Info & { subtitles?: Record<string, unknown> };
  return {
    info: { id: meta.id, title: meta.title, duration: meta.duration, upload_date: meta.upload_date } as Info,
    hasManual: !!meta.subtitles?.en,
    auto: JSON.parse(await fs.readFile(auto, "utf8")) as Json3,
    manual: existsSync(man) ? (JSON.parse(await fs.readFile(man, "utf8")) as Json3) : undefined,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  const ids: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) flags.set(a.slice(2), argv[++i] ?? "");
    else ids.push(a);
  }
  const [episodeId, ...shortIds] = ids;
  if (!episodeId || !shortIds.length) {
    console.error("usage: creator-spans <episodeId> <shortId>… [--fixture name] [--split dev|heldout] [--cache dir] [--sleep 12] [--min-hits 10] [--gap 20] [--merge 10] [--pad 600] [--negative 900]");
    process.exit(2);
  }
  const num = (k: string, d: number) => (flags.has(k) ? Number(flags.get(k)) : d);
  const root = findEvalRoot();
  const cache = path.resolve(flags.get("cache") ?? path.join(root, ".cache", "captions"));
  const pause = num("sleep", 12);
  const ep = await fetchCaptions(episodeId, cache, pause, true);
  const epWords = json3Words(ep.auto);
  const picks: Array<{ episodeId: string; shortId: string; hook: string; url: string; spans: Array<[number, number]>; hits: number[]; pieces: number[] }> = [];
  for (const shortId of shortIds) {
    const sh = await fetchCaptions(shortId, cache, pause, false);
    const spans = alignSpans(json3Words(sh.auto), epWords, { minHits: num("min-hits", 10), gap: num("gap", 20), merge: num("merge", 10) });
    if (!spans.length) process.stderr.write(`  ! ${shortId}: no span with ≥ ${num("min-hits", 10)} matching 5-grams (voice-over, wrong episode?)\n`);
    const pick = { episodeId, shortId, hook: sh.info.title, url: `https://www.youtube.com/shorts/${shortId}`, spans: spans.map((s) => [s.start, s.end] as [number, number]), hits: spans.map((s) => s.hits), pieces: spans.map((s) => s.pieces) };
    picks.push(pick);
    console.log(JSON.stringify({ episodeId, shortId, hook: pick.hook, spans: pick.spans, hits: pick.hits, pieces: pick.pieces, shortRanges: spans.map((s) => [s.shortStart, s.shortEnd]) }));
  }

  const name = flags.get("fixture");
  if (!name) return;
  const duration = ep.info.duration ?? epWords.at(-1)?.end ?? 0;
  const track = ep.manual && ep.hasManual ? "manual" : "auto";
  const all = json3Segments(track === "manual" ? ep.manual! : ep.auto, track);
  const { windows, negative } = fixtureWindows(
    picks.flatMap((p) => p.spans),
    duration,
    num("pad", 600),
    num("negative", 900),
  );
  const keep = [...windows, ...(negative ? [negative] : [])].sort((a, b) => a[0] - b[0]);
  // whole segments only, and only those that lie inside a kept window
  const segments = all.filter((s) => keep.some(([a, b]) => s.start >= a && s.end <= b));
  const dir = path.join(root, "fixtures", "selection", name);
  await fs.mkdir(dir, { recursive: true });
  const url = `https://www.youtube.com/watch?v=${episodeId}`;
  await fs.writeFile(
    path.join(dir, "transcript.json"),
    JSON.stringify({ source: url, title: ep.info.title, durationSec: duration, captionTrack: track === "manual" ? "en (manual)" : "en-orig (auto)", windows: keep, segments }) + "\n",
  );
  await fs.writeFile(
    path.join(dir, "picks.json"),
    JSON.stringify(
      {
        kind: "creator-picks",
        split: flags.get("split") ?? "dev",
        episode: { id: episodeId, url, title: ep.info.title, uploadDate: ep.info.upload_date, durationSec: duration },
        windows,
        negative,
        // a short that did not align is not a label (voice-over, or cut from another episode)
        picks: picks.filter((p) => p.spans.length).map(({ episodeId: _e, ...p }) => p),
        note: `Labels: the creator's own shorts, located in the episode by 5-gram alignment of YouTube auto-captions (apps/server/src/eval/tools/creator-spans.ts, min ${num("min-hits", 10)} hits, offset gap ${num("gap", 20)} words, pieces ≤ ${num("merge", 10)} s apart merged). Transcript: ${track === "manual" ? "the episode's manual en track" : "the episode's auto en-orig track (no punctuation; segments are pause-split)"}, kept only within ±${num("pad", 600)} s of the spans plus one ${num("negative", 900)} s stretch far from them. Re-check: run the tool again; spans should agree within ±2 s.`,
      },
      null,
      2,
    ) + "\n",
  );
  process.stderr.write(`  wrote ${path.relative(process.cwd(), dir)}: ${segments.length} segments in ${keep.length} window(s)\n`);
}

if (process.argv[1] && /creator-spans\.(ts|js)$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
