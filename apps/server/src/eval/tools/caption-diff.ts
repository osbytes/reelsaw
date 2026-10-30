/**
 * caption-diff: disfluency candidates (and reference text) from a video's two YouTube caption tracks.
 *
 * YouTube keeps two English tracks for some videos: the ASR track (`en-orig`, verbatim, with word
 * timings and every um / uh / restart) and a human track (`en`, clean verbatim: fillers and false
 * starts removed). Aligning the two shows which ASR words a human editor dropped. Those insertions
 * are disfluency CANDIDATES, not labels: an editor also drops real words for brevity, and keeps
 * emphasis such as "very, very". A person reads every candidate before it becomes a fixture
 * (docs/EVALS.md, "Building disfluency cases from caption diffs").
 *
 *   npx tsx src/eval/tools/caption-diff.ts <videoId> [--dir <cache>] [--from <s>] [--to <s>] [--window 30] [--out file.json]
 *   npx tsx src/eval/tools/caption-diff.ts <videoId> --dir <cache> --kept [...]           # look-alikes the human KEPT (keep candidates)
 *   npx tsx src/eval/tools/caption-diff.ts <videoId> --dir <cache> --ref <start>-<end>     # human words in a time range
 *
 * Tracks are fetched with yt-dlp (YTDLP_PATH, default `yt-dlp`) into --dir and reused from there.
 * The human track is fetched with `--write-subs` only, so a video without one fails instead of
 * silently diffing ASR against ASR. The two fetches sleep 10 s apart (YouTube rate-limits captions).
 *
 * Alignment is a word-level LCS over normalised words (lowercase, no punctuation), computed in
 * overlapping blocks and committed up to a run of matches, so a 90-minute episode stays fast.
 */
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "../framework.js";

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

interface Json3 {
  events?: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string; tOffsetMs?: number }> }>;
}

/** Lowercase, drop apostrophes, split on anything that is not a letter or digit (same rules as the transcription suite). */
export const normWord = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** Speaker-change marks and sound tags carry no words. */
const NON_WORD = /^(>>+|\[[^\]]*\]|\([^)]*\)|♪+)$/;

/**
 * Words with times from a json3 caption track. ASR tracks carry a time per word (tStartMs +
 * tOffsetMs); human tracks carry one time per caption line, so their words are spread across the
 * line in proportion to their character offset (good to ~1 s; `align` snaps matched words to ASR times).
 */
export function parseJson3(doc: Json3): TimedWord[] {
  const out: TimedWord[] = [];
  for (const e of doc.events ?? []) {
    if (!e.segs) continue;
    const t0 = (e.tStartMs ?? 0) / 1000;
    const dur = (e.dDurationMs ?? 0) / 1000;
    const timed = e.segs.length > 1 || e.segs.some((s) => s.tOffsetMs !== undefined);
    if (timed) {
      const segs = e.segs.map((s) => ({ text: (s.utf8 ?? "").trim(), at: t0 + (s.tOffsetMs ?? 0) / 1000 })).filter((s) => s.text && !NON_WORD.test(s.text));
      segs.forEach((s, i) => {
        for (const piece of s.text.split(/\s+/)) if (piece && !NON_WORD.test(piece)) out.push({ text: piece, start: s.at, end: segs[i + 1]?.at ?? t0 + dur });
      });
      continue;
    }
    const line = (e.segs[0]?.utf8 ?? "").replace(/\s+/g, " ").trim();
    if (!line) continue;
    const pieces = line.split(" ").filter((p) => !NON_WORD.test(p));
    let pos = 0;
    const total = pieces.join(" ").length || 1;
    for (const p of pieces) {
      out.push({ text: p, start: t0 + (dur * pos) / total, end: t0 + (dur * (pos + p.length)) / total });
      pos += p.length + 1;
    }
  }
  // ASR word ends: never past the next word's start
  for (let i = 0; i + 1 < out.length; i++) if (out[i]!.end > out[i + 1]!.start && out[i + 1]!.start >= out[i]!.start) out[i]!.end = out[i + 1]!.start;
  return out;
}

interface Token {
  norm: string;
  word: number;
}

const tokenize = (words: TimedWord[]): Token[] => words.flatMap((w, i) => normWord(w.text).map((norm) => ({ norm, word: i })));

/** Exact LCS of a[ai..ae) and b[bi..be); ties put unmatched b tokens as early as possible (the earlier copy of a repeat is the reparandum). */
function lcsBlock(a: Token[], ai: number, ae: number, b: Token[], bi: number, be: number): Array<[number, number]> {
  const n = ae - ai;
  const m = be - bi;
  const w = m + 1;
  const t = new Uint16Array((n + 1) * w);
  for (let i = 1; i <= n; i++) {
    const an = a[ai + i - 1]!.norm;
    for (let j = 1; j <= m; j++) {
      t[i * w + j] = an === b[bi + j - 1]!.norm ? t[(i - 1) * w + j - 1]! + 1 : Math.max(t[(i - 1) * w + j]!, t[i * w + j - 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[ai + i - 1]!.norm === b[bi + j - 1]!.norm && t[i * w + j] === t[(i - 1) * w + j - 1]! + 1) {
      pairs.push([ai + i - 1, bi + j - 1]);
      i--;
      j--;
    } else if (t[i * w + j - 1]! >= t[(i - 1) * w + j]!) j--;
    else i--;
  }
  return pairs.reverse();
}

export interface Alignment {
  auto: TimedWord[];
  manual: TimedWord[];
  autoTokens: Token[];
  manualTokens: Token[];
  /** matched token pairs [manualToken, autoToken], increasing in both */
  pairs: Array<[number, number]>;
}

/**
 * Align the human track (a) against the ASR track (b). Blocks of `block` human tokens are aligned
 * exactly against the ASR tokens in the same time span (± `marginSec`); each block commits its
 * matches up to the last run of 3 matches before its final quarter, and the next block starts there.
 */
export function align(manual: TimedWord[], auto: TimedWord[], opts: { block?: number; marginSec?: number } = {}): Alignment {
  const block = opts.block ?? 400;
  const margin = opts.marginSec ?? 30;
  const a = tokenize(manual);
  const b = tokenize(auto);
  const pairs: Array<[number, number]> = [];
  let ai = 0;
  let bi = 0;
  while (ai < a.length && bi < b.length) {
    const ae = Math.min(a.length, ai + block);
    const until = manual[a[ae - 1]!.word]!.end + margin;
    let be = bi;
    while (be < b.length && auto[b[be]!.word]!.start <= until) be++;
    be = Math.max(be, Math.min(b.length, bi + 1));
    const got = lcsBlock(a, ai, ae, b, bi, be);
    const last = ae === a.length;
    let commit = got.length;
    if (!last) {
      const limit = ai + Math.floor(block * 0.75);
      commit = 0;
      for (let k = 2; k < got.length; k++) {
        const run = got[k]![0] - got[k - 2]![0] === 2 && got[k]![1] - got[k - 2]![1] === 2;
        if (got[k]![0] < limit && run) commit = k + 1;
      }
      if (commit === 0) commit = Math.min(got.length, Math.max(1, got.findLastIndex((p) => p[0] < limit) + 1));
    }
    const taken = got.slice(0, commit);
    pairs.push(...taken);
    if (last) break;
    const lastPair = taken.at(-1);
    if (lastPair) {
      ai = lastPair[0] + 1;
      bi = lastPair[1] + 1;
    } else ai = ae; // nothing matched in this block (e.g. a section the human track skips)
  }
  return { auto, manual, autoTokens: b, manualTokens: a, pairs };
}

export interface Candidate {
  /** stable id: <videoId>-<start ms> */
  id: string;
  videoId: string;
  /** dropped ASR words (original spelling) and their time span */
  text: string;
  start: number;
  end: number;
  /** rough class to speed up reading; the human label decides */
  guess: "filler" | "repetition" | "other" | "kept-repeat" | "kept-marker";
  /** ±`window` ASR words with timings, and the dropped words' position in it (the disfluency fixture shape) */
  words: TimedWord[];
  target: { index: number; span: number };
  /** the human track's words around the same spot, for reading */
  human: string;
}

const FILLERS = new Set(["um", "uh", "er", "ah", "erm", "hmm", "mm", "uhm", "eh"]);
/** words a disfluency detector is tempted by; when the human track keeps one, it is a `keep` candidate */
const MARKERS = new Set(["like", "so", "right", "well", "actually", "basically", "just", "really", "very", "kind", "sort", "mean", "know"]);

function candidateAt(al: Alignment, videoId: string, first: number, span: number, manualAt: number, guess: Candidate["guess"], win: number): Candidate {
  const lo = Math.max(0, first - win);
  const hi = Math.min(al.auto.length, first + span + win);
  const picked = al.auto.slice(first, first + span);
  const human = al.manualTokens
    .slice(Math.max(0, manualAt - 8), manualAt + 8)
    .map((t, i, arr) => (i > 0 && arr[i - 1]!.word === t.word ? null : al.manual[t.word]!.text))
    .filter(Boolean)
    .join(" ");
  return {
    id: `${videoId}-${Math.round(picked[0]!.start * 1000)}`,
    videoId,
    text: picked.map((w) => w.text).join(" "),
    start: picked[0]!.start,
    end: picked.at(-1)!.end,
    guess,
    words: al.auto.slice(lo, hi).map((w) => ({ text: w.text, start: round(w.start), end: round(w.end) })),
    target: { index: first - lo, span },
    human,
  };
}

const inRange = (t: number, opts: { from?: number | undefined; to?: number | undefined }) => (opts.from === undefined || t >= opts.from) && (opts.to === undefined || t < opts.to);

/** ASR words that the human track has no counterpart for, grouped into runs (pure insertions only: substitutions are mis-hearings, not disfluencies). */
export function insertions(al: Alignment, videoId: string, opts: { window?: number; from?: number | undefined; to?: number | undefined } = {}): Candidate[] {
  const win = opts.window ?? 30;
  const autoWordMatched = new Set<number>();
  for (const [, a] of al.pairs) autoWordMatched.add(al.autoTokens[a]!.word);
  const out: Candidate[] = [];
  for (let k = 0; k < al.pairs.length; k++) {
    const prev: [number, number] = k === 0 ? [-1, -1] : al.pairs[k - 1]!;
    const cur = al.pairs[k]!;
    if (cur[1] - prev[1] - 1 <= 0 || cur[0] - prev[0] - 1 > 0) continue; // nothing dropped, or a substitution
    // whole ASR words strictly inside the gap
    const wordIds = [...new Set(al.autoTokens.slice(prev[1] + 1, cur[1]).map((t) => t.word))].filter((w) => !autoWordMatched.has(w));
    if (!wordIds.length) continue;
    const first = wordIds[0]!;
    const span = wordIds.at(-1)! - first + 1;
    if (!inRange(al.auto[first]!.start, opts)) continue;
    const norms = al.auto.slice(first, first + span).flatMap((w) => normWord(w.text));
    const after = al.auto.slice(first + span, first + span + norms.length).flatMap((w) => normWord(w.text));
    const guess = norms.every((n) => FILLERS.has(n)) ? "filler" : norms.join(" ") === after.slice(0, norms.length).join(" ") ? "repetition" : "other";
    out.push(candidateAt(al, videoId, first, span, prev[0] + 1, guess, win));
  }
  return out;
}

/**
 * The other side: ASR words the human track KEPT although they look like disfluencies (an immediate
 * repeat such as "very, very", or a discourse marker such as "like" / "so"). These are `keep`
 * candidates; reading decides (a clean-verbatim editor sometimes keeps a filler).
 */
export function kept(al: Alignment, videoId: string, opts: { window?: number; from?: number | undefined; to?: number | undefined } = {}): Candidate[] {
  const win = opts.window ?? 30;
  const manualOf = new Map<number, number>(); // auto word → manual token
  for (const [m, a] of al.pairs) if (!manualOf.has(al.autoTokens[a]!.word)) manualOf.set(al.autoTokens[a]!.word, m);
  const out: Candidate[] = [];
  for (let i = 0; i < al.auto.length; i++) {
    const m = manualOf.get(i);
    if (m === undefined || !inRange(al.auto[i]!.start, opts)) continue;
    const n = normWord(al.auto[i]!.text).join(" ");
    const next = al.auto[i + 1] ? normWord(al.auto[i + 1]!.text).join(" ") : "";
    if (n && n === next && manualOf.has(i + 1)) out.push(candidateAt(al, videoId, i, 1, m, "kept-repeat", win));
    else if (MARKERS.has(n)) out.push(candidateAt(al, videoId, i, 1, m, "kept-marker", win));
  }
  return out;
}

/** The human track's words whose (ASR-snapped) time falls in [from, to): the reference text of a window. */
export function humanWordsIn(al: Alignment, from: number, to: number): TimedWord[] {
  const snapped = new Map<number, number>();
  for (const [m, a] of al.pairs) {
    const mw = al.manualTokens[m]!.word;
    if (!snapped.has(mw)) snapped.set(mw, al.auto[al.autoTokens[a]!.word]!.start);
  }
  return al.manual.filter((w, i) => {
    const t = snapped.get(i) ?? w.start;
    return t >= from && t < to;
  });
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch (or reuse) `<dir>/<id>.en.json3` (human) and `<dir>/<id>.en-orig.json3` (ASR). Some videos
 * have no `en-orig` track (only machine translations): with `requireAuto: false` that returns
 * `auto: null` instead of failing.
 */
export async function fetchTracks(videoId: string, dir: string, opts: { requireAuto?: boolean; ytdlp?: string } = {}): Promise<{ manual: string; auto: string | null }> {
  const ytdlp = opts.ytdlp ?? (process.env.YTDLP_PATH || "yt-dlp");
  await fs.mkdir(dir, { recursive: true });
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const manual = path.join(dir, `${videoId}.en.json3`);
  const auto = path.join(dir, `${videoId}.en-orig.json3`);
  const base = ["-q", "--no-warnings", "--skip-download", "--sub-format", "json3", "-o", path.join(dir, "%(id)s")];
  let fetched = false;
  if (!existsSync(manual)) {
    // --write-subs alone: human tracks only, never an ASR fallback
    await exec(ytdlp, [...base, "--write-subs", "--sub-langs", "en", url]);
    if (!existsSync(manual)) throw new Error(`${videoId} has no human (manual) English caption track`);
    fetched = true;
  }
  if (!existsSync(auto)) {
    if (fetched) await sleep(10_000);
    try {
      await exec(ytdlp, [...base, "--write-auto-subs", "--sub-langs", "en-orig", url]);
    } catch (err) {
      if (opts.requireAuto !== false) throw err;
    }
    if (!existsSync(auto)) {
      if (opts.requireAuto === false) return { manual, auto: null };
      throw new Error(`${videoId} has no en-orig ASR caption track`);
    }
  }
  return { manual, auto };
}

/** Align a video's two tracks. Without an ASR track (`requireAuto: false`) the alignment is empty and human words keep their line-interpolated times. */
export async function diffVideo(videoId: string, dir: string, opts: { requireAuto?: boolean } = {}) {
  const files = await fetchTracks(videoId, dir, opts);
  const manual = parseJson3(JSON.parse(await fs.readFile(files.manual, "utf8")) as Json3);
  const auto = files.auto ? parseJson3(JSON.parse(await fs.readFile(files.auto, "utf8")) as Json3) : [];
  return align(manual, auto);
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const videoId = argv.find((a, i) => !a.startsWith("--") && !(i > 0 && argv[i - 1]!.startsWith("--")));
  if (!videoId) {
    console.error("usage: caption-diff.ts <videoId> [--dir <cache>] [--from s] [--to s] [--window 30] [--kept] [--out file] | --ref <start>-<end>");
    process.exit(2);
  }
  const dir = opt("dir") ?? path.join(process.cwd(), ".caption-diff");
  const ref = opt("ref");
  const al = await diffVideo(videoId, dir, { requireAuto: !ref });
  if (ref) {
    if (!al.auto.length) console.error(`${videoId}: no ASR track; human words keep their caption-line times (±1 s at the edges)`);
    const [a, b] = ref.split("-").map(Number);
    console.log(humanWordsIn(al, a!, b!).map((w) => w.text).join(" "));
    return;
  }
  const from = opt("from");
  const to = opt("to");
  const range = { window: Number(opt("window") ?? 30), from: from ? Number(from) : undefined, to: to ? Number(to) : undefined };
  const cands = argv.includes("--kept") ? kept(al, videoId, range) : insertions(al, videoId, range);
  const summary = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    autoWords: al.auto.length,
    humanWords: al.manual.length,
    matchedTokens: al.pairs.length,
    candidates: cands.length,
    byGuess: cands.reduce<Record<string, number>>((acc, c) => ((acc[c.guess] = (acc[c.guess] ?? 0) + 1), acc), {}),
  };
  const out = opt("out");
  if (out) {
    await fs.writeFile(out, JSON.stringify({ ...summary, candidates: cands }, null, 1));
    console.log(JSON.stringify(summary));
  } else console.log(JSON.stringify({ ...summary, candidates: cands }, null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error((err as Error).message);
    process.exit(1);
  });
}
