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
 * Any step that fails drops an automatic cut. A leftover "pay" in the audio beats an amputated "against".
 * A cut the user made is different: it is never dropped. The seams may move by MANUAL_NUDGE to reach a
 * clean boundary; if the search cannot confirm any seam it is applied at the word timings the user set,
 * marked `verified: false` with the reason.
 */
import { spawn } from "node:child_process";
import { normalizeToken, normalizeTokens, normalizeWithSpans, type Word } from "@reelsaw/shared";
import type { Logger } from "../log.js";
import { supports } from "./language.js";

const SR = 16000;
const FRAME = 80; // 5 ms at 16 kHz
const norm = normalizeToken;
/** How far a manual cut's seams may move from where the user set them to reach a clean boundary. */
export const MANUAL_NUDGE = 0.12;

export interface CutRange {
  start: number;
  end: number;
  /** the user made this cut: it is applied, never dropped (see refineCuts) */
  manual?: boolean;
}
/** A cut that will be applied. `verified: false` means the seam could not be checked against the audio; `reason` says why. */
export interface AppliedCut extends CutRange {
  verified: boolean;
  reason?: string;
}
export interface RefineResult {
  cuts: AppliedCut[];
  skipped: Array<{ range: CutRange; reason: string }>;
}
export interface CutDeps {
  log?: Logger | undefined;
  /** called before each verification so long searches show progress (cut index, total, attempt) */
  onProgress?: ((cut: number, total: number, attempt: number) => void) | undefined;
  ffmpegPath: string;
  /** transcribe an mp3 buffer; returns words with timestamps relative to the buffer start */
  transcribe: (audio: Buffer) => Promise<Word[]>;
  /** CTC forced alignment (16 kHz float PCM + known words → spans relative to the PCM start) */
  align?: (pcm: Float32Array, words: string[]) => Promise<Array<{ text: string; start?: number; end?: number; score?: number }>>;
  signal?: AbortSignal | undefined;
  /** spoken language of the transcript; the English-only CTC aligner is skipped for any other */
  language?: string | null | undefined;
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
  runFfmpeg(
    d.ffmpegPath,
    ["-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", source, "-vn", "-ac", "1", "-ar", String(SR), "-f", "s16le", "pipe:1"],
    d.signal,
  ).then((b) => new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2)));
const mp3 = (d: CutDeps, source: string, start: number, duration: number) =>
  runFfmpeg(
    d.ffmpegPath,
    ["-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", source, "-vn", "-ac", "1", "-ar", String(SR), "-b:a", "64k", "-f", "mp3", "pipe:1"],
    d.signal,
  );

/** Just the removed audio, padded with silence so the recogniser has no surrounding words to lean on. */
const pieceMp3 = (d: CutDeps, source: string, start: number, duration: number) =>
  runFfmpeg(
    d.ffmpegPath,
    [
      "-ss",
      start.toFixed(3),
      "-t",
      duration.toFixed(3),
      "-i",
      source,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(SR),
      "-af",
      "adelay=400:all=1,apad=pad_dur=0.4",
      "-b:a",
      "64k",
      "-f",
      "mp3",
      "pipe:1",
    ],
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
      "-ss",
      Math.max(0, a0 - 0.5).toFixed(3),
      "-t",
      (b1 - a0 + 1).toFixed(3),
      "-i",
      source,
      "-filter_complex",
      `[0:a]atrim=start=${(a0 - Math.max(0, a0 - 0.5)).toFixed(3)}:end=${(a1 - Math.max(0, a0 - 0.5) + 0.02).toFixed(3)},asetpts=PTS-STARTPTS[x];` +
        `[0:a]atrim=start=${(b0 - Math.max(0, a0 - 0.5)).toFixed(3)}:end=${(b1 - Math.max(0, a0 - 0.5)).toFixed(3)},asetpts=PTS-STARTPTS[y];` +
        `[x][y]acrossfade=d=0.02:c1=tri:c2=tri[o]`,
      "-map",
      "[o]",
      "-ac",
      "1",
      "-ar",
      String(SR),
      "-b:a",
      "64k",
      "-f",
      "mp3",
      "pipe:1",
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

export interface Located {
  /** aligned word indices of the first and last deleted word */
  from: number;
  to: number;
  prevIdx?: number | undefined;
  nextIdx?: number | undefined;
  /** tokens that differ from the expected words (0 = exact) */
  drift: number;
}

function tokenDistance(a: string[], b: string[]) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}

/**
 * Find the `deleted` words inside the re-heard `aligned` words, by position first: among the
 * stretches that read like the expected words (numbers, case and punctuation ignored; one word of
 * drift allowed in a phrase of four or more, a third of it for a manual cut) the one whose time overlaps or sits closest to `range`
 * wins, so a phrase the speaker said twice cannot send the cut to the wrong occurrence. Neighbours
 * (`prev`/`next`) are a second signal. An automatic cut must also be anchored by a neighbour
 * ("could be another occurrence" otherwise); a manual one is placed by its position alone.
 * `aligned` times and `range` share one time base.
 */
export function locate(
  aligned: Word[],
  prev: Word | undefined,
  deleted: Word[],
  next: Word | undefined,
  range?: { start: number; end: number },
  opts: { manual?: boolean; maxDistance?: number } = {},
): Located | null {
  const al = normalizeWithSpans(aligned.map((w) => w.text));
  const del = normalizeTokens(deleted.map((w) => w.text));
  if (!del.length) return null;
  const p = prev ? norm(prev.text) : null;
  const n = next ? norm(next.text) : null;
  // a recogniser mishears a word or two of a phrase; for a manual cut the position vouches for the rest
  const allowed = del.length < 4 ? 0 : opts.manual ? Math.floor(del.length / 3) : del.length >= 10 ? 2 : 1;
  const maxDistance = opts.maxDistance ?? 0.9;
  type Cand = Located & { score: number; fit: number };
  let best: Cand | null = null;
  for (let i = 0; i < al.length; i++) {
    for (const len of allowed ? [del.length, del.length - 1, del.length + 1] : [del.length]) {
      if (len < 1 || i + len > al.length) continue;
      const win = al.slice(i, i + len).map((t) => t.token);
      const drift = tokenDistance(win, del);
      if (drift > allowed) continue;
      const first = al[i]!;
      const last = al[i + len - 1]!;
      const from = first.from;
      const to = last.from + last.count - 1;
      let score = 0;
      let prevIdx: number | undefined;
      let nextIdx: number | undefined;
      if (p !== null && i > 0 && al[i - 1]!.token === p) {
        score++;
        prevIdx = al[i - 1]!.from + al[i - 1]!.count - 1;
      }
      if (n !== null && i + len < al.length && al[i + len]!.token === n) {
        score++;
        nextIdx = al[i + len]!.from;
      }
      if (!opts.manual && score === 0 && (p !== null || n !== null)) continue; // unanchored match: could be another occurrence
      let fit = 0; // seconds the stretch overlaps the cut; negative = the gap between them
      if (range) {
        const ws = aligned[from]!.start;
        const we = aligned[to]!.end;
        fit = Math.min(we, range.end) - Math.max(ws, range.start);
        if (fit < -maxDistance) continue; // another occurrence somewhere else in the window
      }
      const c: Cand = { from, to, prevIdx, nextIdx, drift, score, fit };
      const nearer = c.fit > (best?.fit ?? -Infinity) + 1e-6;
      const level = !!best && Math.abs(c.fit - best.fit) <= 1e-6;
      const better =
        !best ||
        (opts.manual
          ? nearer || (level && (c.drift < best.drift || (c.drift === best.drift && c.score > best.score)))
          : c.score > best.score || (c.score === best.score && (c.drift < best.drift || (c.drift === best.drift && nearer))));
      if (better) best = c;
    }
  }
  return best ? { from: best.from, to: best.to, prevIdx: best.prevIdx, nextIdx: best.nextIdx, drift: best.drift } : null;
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
  const cuts: AppliedCut[] = [];
  const skipped: RefineResult["skipped"] = [];
  for (const [ri, r] of ranges.entries()) {
    deps.onProgress?.(ri, ranges.length, 1);
    const deleted = words.filter((w) => w.start >= r.start - 0.02 && w.end <= r.end + 0.02);
    const prev = words.filter((w) => w.end <= r.start + 0.02 && w.start < r.start).sort((a, b) => b.end - a.end)[0];
    const next = words.filter((w) => w.start >= r.end - 0.02 && w.end > r.end).sort((a, b) => a.start - b.start)[0];
    const manual = r.manual === true;
    const verifiedFlag = opts.verify !== false;
    // An automatic cut that cannot be confirmed is dropped (a leftover word beats an amputated one).
    // A cut the user made is never dropped: it is applied where they set it, marked unverified.
    const giveUp = (reason: string) => {
      if (!manual) {
        skipped.push({ range: r, reason });
        return;
      }
      cuts.push({ start: r.start, end: r.end, manual: true, verified: false, reason });
      deps.log?.warn({ span: [r.start, r.end], reason }, "manual cut applied without a seam check");
    };
    // a manual cut's seams may only move a little from where the user set them
    const within = (c: CutRange): CutRange => {
      if (!manual) return c;
      const start = Math.min(r.start + MANUAL_NUDGE, Math.max(r.start - MANUAL_NUDGE, c.start));
      const end = Math.min(r.end + MANUAL_NUDGE, Math.max(r.end - MANUAL_NUDGE, c.end));
      return { start: Number(start.toFixed(4)), end: Number(end.toFixed(4)) };
    };
    const accept = (c: CutRange) => cuts.push({ start: c.start, end: c.end, ...(manual ? { manual: true } : {}), verified: verifiedFlag });
    if (!deleted.length) {
      giveUp("no words inside the span");
      continue;
    }
    let accepted: CutRange | null = null;
    const reasons: string[] = [];
    const del = normalizeTokens(deleted.map((w) => w.text));
    type Verdict = { ok: boolean; prevOk: boolean; nextOk: boolean; partial: boolean };
    let attempt = 0;
    const verify = async (cut: CutRange): Promise<Verdict> => {
      deps.onProgress?.(ri, ranges.length, ++attempt);
      const heard = normalizeTokens(
        (
          await deps.transcribe(
            await seamMp3(
              deps,
              source,
              clipStart + Math.max(0, cut.start - 1.2),
              clipStart + cut.start,
              clipStart + cut.end,
              clipStart + Math.min(duration, cut.end + 1.2),
            ),
          )
        ).map((w) => w.text),
      );
      const stillThere =
        del.length === 1
          ? heard.includes(del[0]!) && !(prev && norm(prev.text) === del[0]) && !(next && norm(next.text) === del[0])
          : del.every((t, k) => heard.indexOf(t) >= 0 && (k === 0 || heard.indexOf(t) > heard.indexOf(del[k - 1]!)));
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
        removed = normalizeTokens((await deps.transcribe(await pieceMp3(deps, source, clipStart + cut.start, cut.end - cut.start))).map((w) => w.text));
        if (del.every((t) => soundsLike(removed, t))) {
          deps.log?.info(
            { span: [r.start, r.end], seamHeard: heard.join(" "), removedHeard: removed.join(" ") },
            "seam check fooled by language model; removed audio confirms the cut",
          );
          return { ok: true, prevOk, nextOk, partial: false };
        }
      }
      reasons.push(
        `${cut.start.toFixed(3)}-${cut.end.toFixed(3)}: heard "${heard.join(" ")}" (prev ${prevOk ? "ok" : "lost"}, next ${nextOk ? "ok" : "lost"}, deleted ${stillThere ? "audible" : "gone"}${leftover ? `, leftover "${leftover}"` : ""}${removed.length ? `, removed piece "${removed.join(" ")}"` : ""})`,
      );
      return { ok: false, prevOk, nextOk, partial: prevOk && nextOk };
    };

    // 0. CTC forced alignment: exact word boundaries from the audio + the words we know are there
    //    (20 ms resolution, ~0.2 s, no transcription call). One or two verified candidates usually
    //    settle it; otherwise fall through to the whisper-based search below.
    if (deps.align && supports("ctcAlign", deps.language) && opts.verify !== false) {
      try {
        const ctc = await ctcBoundaries(deps, source, clipStart, duration, words, deleted, prev, next);
        if (ctc) {
          deps.log?.debug({ span: [r.start, r.end], ctc }, "ctc alignment");
          const a0 = Math.max(0, ctc.prevEnd - 0.15);
          const a1 = Math.min(duration, ctc.nextStart + 0.15);
          const samples = await pcm(deps, source, clipStart + a0, a1 - a0);
          const qs = ctc.dStart - ctc.prevEnd > 0.02 ? quietest(samples, ctc.prevEnd - a0, ctc.dStart + 0.02 - a0) : null;
          const qe = ctc.nextStart - ctc.dEnd > 0.02 ? quietest(samples, ctc.dEnd - 0.02 - a0, ctc.nextStart - a0) : null;
          const ctcCand: CutRange[] = [];
          const push = (st: number, en: number) => {
            const c = within({ start: Number(st.toFixed(4)), end: Number(en.toFixed(4)) });
            if (c.end - c.start >= minCut && !ctcCand.some((x) => Math.abs(x.start - c.start) < 0.012 && Math.abs(x.end - c.end) < 0.012)) ctcCand.push(c);
          };
          push(qs ? qs.t + a0 : ctc.dStart, qe ? qe.t + a0 : ctc.dEnd); // quiet points beside the aligned word
          push(ctc.prevEnd + 0.01, ctc.nextStart - 0.01); // everything between the aligned neighbours
          push(ctc.dStart - 0.03, ctc.dEnd + 0.03);
          for (const c of ctcCand.slice(0, 3)) {
            const v = await verify(c);
            if (v.ok) {
              accepted = c;
              break;
            }
          }
        }
      } catch (err) {
        if (deps.signal?.aborted) throw err;
        deps.log?.warn({ err }, "ctc alignment failed, using the whisper-based search");
      }
      if (accepted) {
        deps.log?.debug({ span: [r.start, r.end], cut: [accepted.start, accepted.end], tries: attempt }, "cut accepted via ctc alignment");
        accept(accepted);
        continue;
      }
    }

    // 1. re-align on a short window
    const w0 = Math.max(0, r.start - 1.5);
    const w1 = Math.min(duration, r.end + 1.5);
    let aligned: Word[];
    try {
      aligned = (await deps.transcribe(await mp3(deps, source, clipStart + w0, w1 - w0))).map((w) => ({ ...w, start: w.start + w0, end: w.end + w0 }));
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      giveUp(`re-alignment failed: ${(err as Error).message.slice(0, 80)}`);
      continue;
    }
    const loc = locate(aligned, prev, deleted, next, r, { manual });
    if (!loc) {
      giveUp(
        `re-alignment could not find "${deleted.map((w) => w.text).join(" ")}" ${manual ? "where you cut it" : "between its neighbours"} (heard: ${aligned.map((w) => w.text).join(" ")})`,
      );
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
      const loc2 = locate(aligned2, prev, deleted, next, r, { manual });
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
      giveUp("no room between neighbouring words");
      continue;
    }
    // no quiet gap on a side (words run together): fall back to the re-aligned word boundary there;
    // the crossfade hides the seam and verification below still has to pass
    const sQuiet = qs.level <= quietRatio * qs.local;
    const eQuiet = qe.level <= quietRatio * qe.local;
    const primary = { start: (sQuiet ? qs.t : dStart - w0) + w0, end: (eQuiet ? qe.t : dEnd - w0) + w0 };
    if (!sQuiet || !eQuiet)
      deps.log?.debug({ span: [r.start, r.end], noQuietGap: !sQuiet && !eQuiet ? "both" : !sQuiet ? "start" : "end" }, "no quiet gap, using aligned boundary");

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
      const c = within({ start: Number(Math.max(loBound, st).toFixed(4)), end: Number(Math.min(hiBound, en).toFixed(4)) });
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
    for (const ds of [0, 0.05, 0.1, -0.05, -0.1])
      for (const de of [0, 0.06, 0.12, 0.18, 0.24, -0.06]) grid.push({ start: primary.start + ds, end: primary.end + de });
    grid.sort(
      (x, y) => Math.abs(x.start - primary.start) + Math.abs(x.end - primary.end) - (Math.abs(y.start - primary.start) + Math.abs(y.end - primary.end)),
    );
    for (const g of grid) add(g.start, g.end);
    add(prevEnd + 0.005, nextStart - 0.005); // everything between the neighbours
    const MAX_TRIES = opts.verify === false ? 1 : 8;

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
        if (cut.end > hardHi || cut.end > duration || (manual && cut.end > r.end + MANUAL_NUDGE)) break;
        const v = await verify(cut);
        if (v.ok) accepted = cut;
        else if (!v.nextOk) break;
        partial = cut;
      }
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      reasons.push(`verification error: ${(err as Error).message.slice(0, 80)}`);
    }
    if (!accepted) {
      giveUp(`verification failed after ${reasons.length} attempt(s): ${reasons.join("; ")}`);
      continue;
    }
    deps.log?.debug(
      {
        span: [r.start, r.end],
        cut: [accepted.start, accepted.end],
        via: cand.includes(accepted) ? `candidate ${cand.indexOf(accepted) + 1}` : "directed walk",
        tries: reasons.length + 1,
      },
      "cut accepted",
    );
    accept(accepted);
  }
  return { cuts, skipped };
}

/**
 * Exact boundaries of the deleted word(s) and their neighbours by forced alignment of the transcript
 * words around the span. The window is built from whole words (with margin) so the text matches the
 * audio at both edges; clip-relative seconds. Null when alignment can't place the needed words.
 */
async function ctcBoundaries(
  deps: CutDeps,
  source: string,
  clipStart: number,
  duration: number,
  words: Word[],
  deleted: Word[],
  prev: Word | undefined,
  next: Word | undefined,
): Promise<{ dStart: number; dEnd: number; prevEnd: number; nextStart: number } | null> {
  const s0 = deleted[0]!.start;
  const s1 = deleted[deleted.length - 1]!.end;
  const ctxWords = words.filter((w) => w.end > s0 - 2.2 && w.start < s1 + 2.2);
  if (!ctxWords.length) return null;
  const a0 = Math.max(0, ctxWords[0]!.start - 0.5);
  const a1 = Math.min(duration, ctxWords[ctxWords.length - 1]!.end + 0.5);
  const raw = await runFfmpeg(
    deps.ffmpegPath,
    ["-ss", (clipStart + a0).toFixed(3), "-t", (a1 - a0).toFixed(3), "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"],
    deps.signal,
  );
  const pcmF = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  const spans = await deps.align!(
    pcmF,
    ctxWords.map((w) => w.text),
  );
  const idx = (w: Word | undefined) => (w ? ctxWords.indexOf(w) : -1);
  const di = deleted.map((d) => idx(d));
  const pi = idx(prev);
  const ni = idx(next);
  const span = (i: number) => (i >= 0 ? spans[i] : undefined);
  const first = span(di[0]!);
  const last = span(di[di.length - 1]!);
  if (first?.start === undefined || last?.end === undefined) return null;
  // a confident alignment has letter log-probs near 0; very low scores mean the text doesn't match
  if ((first.score ?? 0) < -3 || (last.score ?? 0) < -3) return null;
  const p = span(pi);
  const n = span(ni);
  return {
    dStart: a0 + first.start,
    dEnd: a0 + last.end,
    prevEnd: a0 + (p?.end ?? Math.max(0, first.start - 0.15)),
    nextStart: a0 + (n?.start ?? last.end + 0.15),
  };
}
