/**
 * Bulletproof jump cuts.
 *
 * ASR word timestamps drift by up to a word for short function words, so cutting at them clips
 * neighbours. For every accepted deletion we therefore:
 *   1. re-align: transcribe a ~3 s window around it with word timestamps (short windows align far
 *      better than a 10-minute chunk) and locate the deleted words between their neighbours;
 *   2. snap: move each boundary to the quietest 5 ms frame in the gap next to the neighbour word,
 *      on a zero crossing;
 *   3. verify: render only the seam audio with the cut applied, transcribe it, and require that
 *      both neighbours are still heard and the deleted words are not. If the deleted word is
 *      still audible, retry with wider candidate seams (up to the neighbours) before giving up.
 * Any step that fails drops that cut. A leftover "pay" in the audio beats an amputated "against".
 */
import { spawn } from "node:child_process";
import type { Word } from "@reelsaw/shared";
import type { Logger } from "../log.js";

const SR = 16000;
const FRAME = 80; // 5 ms at 16 kHz
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']+/g, "");

export interface CutRange {
  start: number;
  end: number;
}
export interface RefineResult {
  cuts: CutRange[];
  skipped: Array<{ range: CutRange; reason: string }>;
}
export interface CutDeps {
  log?: Logger;
  ffmpegPath: string;
  /** transcribe an mp3 buffer; returns words with timestamps relative to the buffer start */
  transcribe: (audio: Buffer) => Promise<Word[]>;
  signal?: AbortSignal;
}

function runFfmpeg(ffmpegPath: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let err = "";
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-nostdin", ...args], { signal, stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg (${code}): ${err.slice(-300)}`))));
  });
}

const pcm = (d: CutDeps, source: string, start: number, duration: number) =>
  runFfmpeg(d.ffmpegPath, ["-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", source, "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "pipe:1"], d.signal).then(
    (b) => new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2)),
  );
const mp3 = (d: CutDeps, source: string, start: number, duration: number) =>
  runFfmpeg(d.ffmpegPath, ["-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", source, "-vn", "-ac", "1", "-ar", String(SR), "-b:a", "64k", "-f", "mp3", "pipe:1"], d.signal);

/** Just the removed audio, padded with silence so the recogniser has no surrounding words to lean on. */
const pieceMp3 = (d: CutDeps, source: string, start: number, duration: number) =>
  runFfmpeg(
    d.ffmpegPath,
    ["-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", source, "-vn", "-ac", "1", "-ar", String(SR), "-af", "adelay=400:all=1,apad=pad_dur=0.4", "-b:a", "64k", "-f", "mp3", "pipe:1"],
    d.signal,
  );

function editDistance(a: string, b: string) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}
/** Loose match for a word heard in isolation ("into" ≈ "in to", "intu"). */
function soundsLike(heard: string[], target: string) {
  const joined = heard.join("");
  if (joined.includes(target)) return true;
  return heard.some((h) => h.length > 0 && editDistance(h, target) <= Math.max(1, Math.floor(target.length / 3)));
}

/** Seam audio: [a0,a1] then [b0,b1] of the source with a 20 ms crossfade, as mp3. */
const seamMp3 = (d: CutDeps, source: string, a0: number, a1: number, b0: number, b1: number) =>
  runFfmpeg(
    d.ffmpegPath,
    [
      "-ss", Math.max(0, a0 - 0.5).toFixed(3), "-t", (b1 - a0 + 1).toFixed(3), "-i", source,
      "-filter_complex",
      `[0:a]atrim=start=${(a0 - Math.max(0, a0 - 0.5)).toFixed(3)}:end=${(a1 - Math.max(0, a0 - 0.5) + 0.02).toFixed(3)},asetpts=PTS-STARTPTS[x];` +
        `[0:a]atrim=start=${(b0 - Math.max(0, a0 - 0.5)).toFixed(3)}:end=${(b1 - Math.max(0, a0 - 0.5)).toFixed(3)},asetpts=PTS-STARTPTS[y];` +
        `[x][y]acrossfade=d=0.02:c1=tri:c2=tri[o]`,
      "-map", "[o]", "-ac", "1", "-ar", String(SR), "-b:a", "64k", "-f", "mp3", "pipe:1",
    ],
    d.signal,
  );

function rms(s: Int16Array, from: number, to: number) {
  let acc = 0;
  let n = 0;
  for (let i = Math.max(0, from); i < Math.min(s.length, to); i++) {
    acc += s[i]! * s[i]!;
    n++;
  }
  return n ? Math.sqrt(acc / n) : 0;
}

/** Quietest frame in [lo,hi] seconds (relative to `samples`), snapped to a zero crossing. */
function quietest(samples: Int16Array, lo: number, hi: number) {
  const a = Math.floor(lo * SR);
  const b = Math.floor(hi * SR);
  if (b - a < FRAME) return null;
  let best = -1;
  let level = Infinity;
  for (let i = a; i + FRAME <= b; i += FRAME / 2) {
    const l = rms(samples, i, i + FRAME);
    if (l < level) {
      level = l;
      best = i;
    }
  }
  if (best < 0) return null;
  const levels: number[] = [];
  for (let i = Math.max(0, a - 0.6 * SR); i + FRAME <= Math.min(samples.length, b + 0.6 * SR); i += FRAME) levels.push(rms(samples, i, i + FRAME));
  levels.sort((x, y) => x - y);
  const local = levels[Math.floor(levels.length * 0.6)] ?? 0;
  let z = best;
  for (let d = 0; d < SR * 0.002; d++) {
    if (best + d + 1 < samples.length && Math.sign(samples[best + d]!) !== Math.sign(samples[best + d + 1]!)) {
      z = best + d + 1;
      break;
    }
    if (best - d > 0 && Math.sign(samples[best - d - 1]!) !== Math.sign(samples[best - d]!)) {
      z = best - d;
      break;
    }
  }
  return { t: z / SR, level, local };
}

/** Find `deleted` tokens inside `aligned`, anchored by prev/next when available. Returns aligned indices. */
function locate(aligned: Word[], prev: Word | undefined, deleted: Word[], next: Word | undefined): { from: number; to: number; prevIdx?: number; nextIdx?: number } | null {
  const al = aligned.map((w) => norm(w.text));
  const del = deleted.map((w) => norm(w.text));
  const p = prev ? norm(prev.text) : null;
  const n = next ? norm(next.text) : null;
  let best: { from: number; to: number; prevIdx?: number; nextIdx?: number; score: number } | null = null;
  for (let i = 0; i + del.length <= al.length; i++) {
    if (!del.every((t, k) => al[i + k] === t)) continue;
    let score = 0;
    let prevIdx: number | undefined;
    let nextIdx: number | undefined;
    if (p !== null && i > 0 && al[i - 1] === p) {
      score++;
      prevIdx = i - 1;
    }
    if (n !== null && al[i + del.length] === n) {
      score++;
      nextIdx = i + del.length;
    }
    if (score === 0 && (p !== null || n !== null)) continue; // unanchored match: could be another occurrence
    if (!best || score > best.score) best = { from: i, to: i + del.length - 1, prevIdx, nextIdx, score };
  }
  return best;
}

export async function refineCuts(
  deps: CutDeps,
  source: string,
  clipStart: number,
  duration: number,
  ranges: CutRange[],
  words: Word[],
  opts: { quietRatio?: number; minCut?: number; verify?: boolean } = {},
): Promise<RefineResult> {
  const quietRatio = opts.quietRatio ?? 0.6;
  const minCut = opts.minCut ?? 0.05;
  const cuts: CutRange[] = [];
  const skipped: RefineResult["skipped"] = [];
  for (const r of ranges) {
    const deleted = words.filter((w) => w.start >= r.start - 0.02 && w.end <= r.end + 0.02);
    const prev = words.filter((w) => w.end <= r.start + 0.02 && w.start < r.start).sort((a, b) => b.end - a.end)[0];
    const next = words.filter((w) => w.start >= r.end - 0.02 && w.end > r.end).sort((a, b) => a.start - b.start)[0];
    if (!deleted.length) {
      skipped.push({ range: r, reason: "no words inside the span" });
      continue;
    }
    // 1. re-align on a short window
    const w0 = Math.max(0, r.start - 1.5);
    const w1 = Math.min(duration, r.end + 1.5);
    let aligned: Word[];
    try {
      aligned = (await deps.transcribe(await mp3(deps, source, clipStart + w0, w1 - w0))).map((w) => ({ ...w, start: w.start + w0, end: w.end + w0 }));
    } catch (err) {
      skipped.push({ range: r, reason: `re-alignment failed: ${(err as Error).message.slice(0, 80)}` });
      continue;
    }
    const loc = locate(aligned, prev, deleted, next);
    if (!loc) {
      skipped.push({ range: r, reason: `re-alignment could not find "${deleted.map((w) => w.text).join(" ")}" between its neighbours (heard: ${aligned.map((w) => w.text).join(" ")})` });
      continue;
    }
    const dStart = aligned[loc.from]!.start;
    const dEnd = aligned[loc.to]!.end;
    const prevEnd = loc.prevIdx !== undefined ? aligned[loc.prevIdx]!.end : prev ? prev.end : 0;
    const nextStart = loc.nextIdx !== undefined ? aligned[loc.nextIdx]!.start : next ? next.start : duration;
    // 1b. second opinion: whisper's word timings shift with where the window starts (seen: "into" at
    // 18.37-18.56 from one window, 18.52-18.90 from another, the latter right). Align again with a
    // differently placed window and feed both into the candidate search.
    let alt: { dStart: number; dEnd: number; prevStart: number; nextEnd: number } | null = null;
    try {
      const v0 = Math.max(0, r.start - 0.7);
      const v1 = Math.min(duration, r.end + 2.2);
      const aligned2 = (await deps.transcribe(await mp3(deps, source, clipStart + v0, v1 - v0))).map((w) => ({ ...w, start: w.start + v0, end: w.end + v0 }));
      const loc2 = locate(aligned2, prev, deleted, next);
      if (loc2)
        alt = {
          dStart: aligned2[loc2.from]!.start,
          dEnd: aligned2[loc2.to]!.end,
          prevStart: loc2.prevIdx !== undefined ? aligned2[loc2.prevIdx]!.start : -Infinity,
          nextEnd: loc2.nextIdx !== undefined ? aligned2[loc2.nextIdx]!.end : Infinity,
        };
    } catch {
      /* the first alignment alone still works */
    }
    // 2. snap each boundary into the gap beside the neighbour
    const samples = await pcm(deps, source, clipStart + w0, w1 - w0);
    const sLo = Math.max(w0, Math.min(prevEnd, dStart) - 0.04);
    const sHi = Math.min(dStart + 0.08, dEnd - minCut);
    const eLo = Math.max(dEnd - 0.08, dStart + minCut);
    const eHi = Math.min(w1, Math.max(nextStart, dEnd) + 0.04);
    const qs = sLo < sHi ? quietest(samples, sLo - w0, sHi - w0) : null;
    const qe = eLo < eHi ? quietest(samples, eLo - w0, eHi - w0) : null;
    if (!qs || !qe) {
      skipped.push({ range: r, reason: "no room between neighbouring words" });
      continue;
    }
    // no quiet gap on a side (words run together): fall back to the re-aligned word boundary there;
    // the crossfade hides the seam and verification below still has to pass
    const sQuiet = qs.level <= quietRatio * qs.local;
    const eQuiet = qe.level <= quietRatio * qe.local;
    const primary = { start: (sQuiet ? qs.t : dStart - w0) + w0, end: (eQuiet ? qe.t : dEnd - w0) + w0 };
    if (!sQuiet || !eQuiet) deps.log?.debug({ span: [r.start, r.end], noQuietGap: !sQuiet && !eQuiet ? "both" : !sQuiet ? "start" : "end" }, "no quiet gap, using aligned boundary");

    // Candidate seams, most conservative first. Coarticulated words ("disappear‿into") rarely split
    // cleanly at one boundary, so widen step by step towards each neighbour (never into it) and
    // keep the first candidate the verifier accepts.
    // Bounds: may reach into the neighbour's tail/head (alignment often glues a coarticulated
    // word onto its neighbour); the verifier's "neighbour still heard" check guards over-cutting.
    const prevStart = loc.prevIdx !== undefined ? aligned[loc.prevIdx]!.start : prev ? prev.start : 0;
    const nextEnd = loc.nextIdx !== undefined ? aligned[loc.nextIdx]!.end : next ? next.end : duration;
    let loBound = prevStart + 0.6 * Math.max(0, prevEnd - prevStart);
    let hiBound = nextEnd - 0.6 * Math.max(0, nextEnd - nextStart);
    if (alt) {
      // loosest bounds across both alignments; the neighbour checks catch over-cutting
      loBound = Math.min(loBound, alt.dStart - 0.05);
      hiBound = Math.max(hiBound, alt.dEnd + 0.08);
    }
    const cand: CutRange[] = [];
    const add = (st: number, en: number) => {
      const c = { start: Number(Math.max(loBound, st).toFixed(4)), end: Number(Math.min(hiBound, en).toFixed(4)) };
      if (c.end - c.start < minCut) return;
      if (cand.some((x) => Math.abs(x.start - c.start) < 0.012 && Math.abs(x.end - c.end) < 0.012)) return;
      cand.push(c);
    };
    add(primary.start, primary.end);
    add(dStart, dEnd);
    if (alt) {
      add(alt.dStart, alt.dEnd);
      add(alt.dStart - 0.03, alt.dEnd + 0.03);
      add(Math.min(dStart, alt.dStart), Math.max(dEnd, alt.dEnd));
    }
    add(r.start, r.end); // the original (chunk-timed) span
    // then a grid of small shifts around the aligned cut, nearest first: alignment can be off by a
    // syllable in either direction, and the verifier tells us which way is right
    const grid: CutRange[] = [];
    for (const ds of [0, 0.05, 0.1, -0.05, -0.1]) for (const de of [0, 0.06, 0.12, 0.18, 0.24, -0.06]) grid.push({ start: primary.start + ds, end: primary.end + de });
    grid.sort((x, y) => Math.abs(x.start - primary.start) + Math.abs(x.end - primary.end) - (Math.abs(y.start - primary.start) + Math.abs(y.end - primary.end)));
    for (const g of grid) add(g.start, g.end);
    add(prevEnd + 0.005, nextStart - 0.005); // everything between the neighbours
    const MAX_TRIES = opts.verify === false ? 1 : 8;

    let accepted: CutRange | null = null;
    const reasons: string[] = [];
    const del = deleted.map((w) => norm(w.text));
    type Verdict = { ok: boolean; prevOk: boolean; nextOk: boolean; partial: boolean };
    const verify = async (cut: CutRange): Promise<Verdict> => {
      const heard = (await deps.transcribe(await seamMp3(deps, source, clipStart + Math.max(0, cut.start - 1.2), clipStart + cut.start, clipStart + cut.end, clipStart + Math.min(duration, cut.end + 1.2)))).map((w) => norm(w.text));
      const stillThere = del.length === 1 ? heard.includes(del[0]!) && !(prev && norm(prev.text) === del[0]) && !(next && norm(next.text) === del[0]) : del.every((t, k) => heard.indexOf(t) >= 0 && (k === 0 || heard.indexOf(t) > heard.indexOf(del[k - 1]!)));
      const prevOk = !prev || heard.includes(norm(prev.text));
      const nextOk = !next || heard.includes(norm(next.text));
      // leftovers: anything heard between the neighbours (a cut that takes "in" but leaves "-to"
      // reads as "disappear to between": no whole "into", but not clean either)
      let leftover = "";
      if (prev && next && prevOk && nextOk) {
        const pi = heard.lastIndexOf(norm(prev.text), heard.indexOf(norm(next.text)));
        const ni = heard.indexOf(norm(next.text), Math.max(0, pi));
        if (pi >= 0 && ni > pi + 1) leftover = heard.slice(pi + 1, ni).join(" ");
      }
      if (prevOk && nextOk && !stillThere && !leftover) return { ok: true, prevOk, nextOk, partial: false };
      // The seam check can be fooled by the recogniser's language model ("disappear ___ between"
      // gets "into" filled back in). Cross-check acoustically: if the removed piece, heard on its
      // own, IS the deleted word(s), the cut is right.
      let removed: string[] = [];
      if (prevOk && nextOk && stillThere && !leftover) {
        removed = (await deps.transcribe(await pieceMp3(deps, source, clipStart + cut.start, cut.end - cut.start))).map((w) => norm(w.text)).filter(Boolean);
        if (del.every((t) => soundsLike(removed, t))) {
          deps.log?.info({ span: [r.start, r.end], seamHeard: heard.join(" "), removedHeard: removed.join(" ") }, "seam check fooled by language model; removed audio confirms the cut");
          return { ok: true, prevOk, nextOk, partial: false };
        }
      }
      reasons.push(`${cut.start.toFixed(3)}-${cut.end.toFixed(3)}: heard "${heard.join(" ")}" (prev ${prevOk ? "ok" : "lost"}, next ${nextOk ? "ok" : "lost"}, deleted ${stillThere ? "audible" : "gone"}${leftover ? `, leftover "${leftover}"` : ""}${removed.length ? `, removed piece "${removed.join(" ")}"` : ""})`);
      return { ok: false, prevOk, nextOk, partial: prevOk && nextOk };
    };

    // a) fixed candidates, nearest the alignments first
    let partial: CutRange | null = null;
    let tries = 0;
    try {
      for (const cut of cand) {
        if (tries >= MAX_TRIES) break;
        if (opts.verify === false) {
          accepted = cut;
          break;
        }
        tries++;
        const v = await verify(cut);
        if (v.ok) {
          accepted = cut;
          break;
        }
        if (v.partial && (!partial || cut.end > partial.end)) partial = cut;
      }
      // b) directed walk: the furthest-reaching cut that kept both neighbours but left part of the
      // word behind ("disappear to between") gets its end nudged forward until the leftover is gone
      // or the next word starts to suffer; whisper's word timings drift by ~100-200 ms between windows.
      const hardHi = Math.max(nextStart, alt ? alt.dEnd : 0) + 0.35;
      for (let k = 0; !accepted && partial && k < 6; k++) {
        const cut = { start: partial.start, end: Number((partial.end + 0.05).toFixed(4)) };
        if (cut.end > hardHi || cut.end > duration) break;
        const v = await verify(cut);
        if (v.ok) accepted = cut;
        else if (!v.nextOk) break;
        partial = cut;
      }
    } catch (err) {
      reasons.push(`verification error: ${(err as Error).message.slice(0, 80)}`);
    }
    if (!accepted) {
      skipped.push({ range: r, reason: `verification failed after ${reasons.length} attempt(s): ${reasons.join("; ")}` });
      continue;
    }
    deps.log?.debug({ span: [r.start, r.end], cut: [accepted.start, accepted.end], via: cand.includes(accepted) ? `candidate ${cand.indexOf(accepted) + 1}` : "directed walk", tries: reasons.length + 1 }, "cut accepted");
    const cut = accepted;
    cuts.push(cut);
  }
  return { cuts, skipped };
}
