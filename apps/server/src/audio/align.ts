/**
 * CTC forced alignment with wav2vec2-base-960h (Apache-2.0, int8 ONNX, ~200 ms per 5 s of audio on
 * CPU). Given audio and the words we already know are in it, finds where each word starts and ends at
 * 20 ms resolution, deterministically and without a transcription call.
 *
 * Why: Whisper's word timestamps for short words drift by 100-300 ms and shift with where the window
 * starts, so the cut search had to try up to a dozen candidates (each a 10-50 s ASR call). Forced
 * alignment answers "where exactly is 'into'" directly. (Method: torchaudio forced-alignment tutorial.)
 */
import fs from "node:fs/promises";
import path from "node:path";
import { supports } from "../pipeline/language.js";
import { createOnnxSession, type OnnxOptions, type OnnxProvider } from "../onnx.js";

export const ALIGN_SR = 16000;
const STRIDE_SEC = 0.02; // wav2vec2 conv stack: 320 samples per frame at 16 kHz

export interface WordSpan {
  text: string;
  /** seconds relative to the audio start; undefined when the word had no alignable letters */
  start?: number;
  end?: number;
  /** mean log-probability of its letters (higher = more confident) */
  score?: number;
}

export interface Aligner {
  align(pcm: Float32Array, words: string[]): Promise<WordSpan[]>;
  release(): Promise<void>;
  /** onnxruntime execution provider the model runs on (ONNX_EXECUTION_PROVIDER, or cpu after a fallback) */
  readonly provider: OnnxProvider;
}

export async function loadAligner(dir: string, opts: OnnxOptions = {}): Promise<Aligner> {
  const vocab = JSON.parse(await fs.readFile(path.join(dir, "vocab.json"), "utf8")) as Record<string, number>;
  const ort = await import("onnxruntime-node");
  const { session, provider } = await createOnnxSession(ort, path.join(dir, "model.onnx"), { intraOpNumThreads: 2, logSeverityLevel: 3 }, opts);
  const blank = vocab["<pad>"] ?? 0;
  const sep = vocab["|"]!;
  const V = Object.keys(vocab).length;

  return {
    async align(pcm, words) {
      // per-utterance normalisation (do_normalize: zero mean, unit variance)
      let mean = 0;
      for (const v of pcm) mean += v;
      mean /= pcm.length || 1;
      let varSum = 0;
      for (const v of pcm) varSum += (v - mean) ** 2;
      const std = Math.sqrt(varSum / (pcm.length || 1) + 1e-7);
      const x = new Float32Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) x[i] = (pcm[i]! - mean) / std;
      const res = await session.run({ input_values: new ort.Tensor("float32", x, [1, x.length]) });
      const logits = res.logits!;
      const T = logits.dims[1]!;
      const C = logits.dims[2] ?? V;
      const data = logits.data as Float32Array;
      // log-softmax per frame
      const emit = new Float32Array(T * C);
      for (let t = 0; t < T; t++) {
        let max = -Infinity;
        for (let c = 0; c < C; c++) max = Math.max(max, data[t * C + c]!);
        let sum = 0;
        for (let c = 0; c < C; c++) sum += Math.exp(data[t * C + c]! - max);
        const lse = max + Math.log(sum);
        for (let c = 0; c < C; c++) emit[t * C + c] = data[t * C + c]! - lse;
      }
      return forceAlign(emit, T, C, words, vocab, blank, sep);
    },
    release: () => session.release(),
    provider,
  };
}

/**
 * Viterbi over the CTC trellis for the fixed token sequence "W O R D | W O R D …", then token spans →
 * word spans. Exported for tests.
 */
export function forceAlign(emit: Float32Array, T: number, C: number, words: string[], vocab: Record<string, number>, blank: number, sep: number): WordSpan[] {
  // tokens with the word each belongs to (-1 for separators)
  const tokens: number[] = [];
  const owner: number[] = [];
  words.forEach((w, wi) => {
    const letters = [...w.toUpperCase()].map((ch) => vocab[ch]).filter((id): id is number => id !== undefined && id !== sep);
    if (!letters.length) return;
    if (tokens.length) {
      tokens.push(sep);
      owner.push(-1);
    }
    for (const id of letters) {
      tokens.push(id);
      owner.push(wi);
    }
  });
  const J = tokens.length;
  const out: WordSpan[] = words.map((text) => ({ text }));
  if (!J || T < J) return out;
  // trellis[t][j]: best log-prob of emitting tokens[0..j-1] in frames [0..t-1]
  const NEG = -1e30;
  const trellis = new Float64Array((T + 1) * (J + 1)).fill(NEG);
  trellis[0] = 0;
  for (let t = 0; t < T; t++) {
    trellis[(t + 1) * (J + 1)] = trellis[t * (J + 1)]! + emit[t * C + blank]!;
    for (let j = 1; j <= J; j++) {
      const stay = trellis[t * (J + 1) + j]! + emit[t * C + blank]!;
      const stayTok = trellis[t * (J + 1) + j]! + emit[t * C + tokens[j - 1]!]!; // repeat of the same token
      const move = trellis[t * (J + 1) + j - 1]! + emit[t * C + tokens[j - 1]!]!;
      trellis[(t + 1) * (J + 1) + j] = Math.max(stay, stayTok, move);
    }
  }
  // backtrack: for each token, the frames where it was emitted
  const first = new Int32Array(J).fill(-1);
  const last = new Int32Array(J).fill(-1);
  const prob = new Float64Array(J);
  let j = J;
  for (let t = T; t > 0 && j > 0; t--) {
    const tok = tokens[j - 1]!;
    const move = trellis[(t - 1) * (J + 1) + j - 1]! + emit[(t - 1) * C + tok]!;
    const stayTok = trellis[(t - 1) * (J + 1) + j]! + emit[(t - 1) * C + tok]!;
    const stayBlank = trellis[(t - 1) * (J + 1) + j]! + emit[(t - 1) * C + blank]!;
    const best = Math.max(move, stayTok, stayBlank);
    if (best === stayBlank && stayBlank > move) continue; // blank frame, same token position
    // this frame emits token j-1
    if (last[j - 1] === -1) last[j - 1] = t - 1;
    first[j - 1] = t - 1;
    prob[j - 1] += emit[(t - 1) * C + tok]!;
    if (best === move) j--;
  }
  // token spans → word spans
  for (let k = 0; k < J; k++) {
    const wi = owner[k]!;
    if (wi < 0 || first[k]! < 0) continue;
    const w = out[wi]!;
    const s = first[k]! * STRIDE_SEC;
    const e = (last[k]! + 1) * STRIDE_SEC;
    w.start = w.start === undefined ? s : Math.min(w.start, s);
    w.end = w.end === undefined ? e : Math.max(w.end, e);
    w.score = (w.score ?? 0) + prob[k]!;
  }
  return out.map((w) => (w.start === undefined ? w : { ...w, start: Number(w.start.toFixed(3)), end: Number(w.end!.toFixed(3)), score: Number((w.score! / Math.max(1, [...w.text].length)).toFixed(3)) }));
}

/**
 * Re-time caption words against the clip audio. Words are aligned in windows of up to ~20 s split at
 * pauses (keeps the trellis small and lets one bad stretch fail alone). A word takes its aligned
 * timing when the alignment is confident; otherwise it keeps its original timing, clamped between its
 * re-timed neighbours so order is preserved. `pcm` is 16 kHz mono for the clip; times clip-relative.
 */
export async function alignWordTimes<W extends { text: string; start: number; end: number }>(aligner: Aligner, pcm: Float32Array, words: W[], opts: { maxWindow?: number; minScore?: number; language?: string | null } = {}): Promise<{ words: W[]; aligned: number; medianShiftMs: number; unsupported?: boolean }> {
  // the acoustic model and its A-Z vocabulary are English: other languages keep their transcript timing
  if (!supports("ctcAlign", opts.language)) return { words: words.map((w) => ({ ...w })), aligned: 0, medianShiftMs: 0, unsupported: true };
  const maxWindow = opts.maxWindow ?? 20;
  const minScore = opts.minScore ?? -2.5;
  const duration = pcm.length / ALIGN_SR;
  const out = words.map((w) => ({ ...w }));
  const shifts: number[] = [];
  let aligned = 0;
  // windows: break at the largest pause once a window passes half the max length
  const windows: Array<[number, number]> = [];
  let i0 = 0;
  for (let i = 1; i <= words.length; i++) {
    const span = i < words.length ? words[i]!.end - words[i0]!.start : Infinity;
    const gap = i < words.length ? words[i]!.start - words[i - 1]!.end : Infinity;
    if (i === words.length || span > maxWindow || (span > maxWindow / 2 && gap > 0.35)) {
      windows.push([i0, i]);
      i0 = i;
    }
  }
  for (const [a, b] of windows) {
    if (b <= a) continue;
    const t0 = Math.max(0, words[a]!.start - 0.4);
    const t1 = Math.min(duration, words[b - 1]!.end + 0.4);
    if (t1 - t0 < 0.3) continue;
    const slice = pcm.subarray(Math.floor(t0 * ALIGN_SR), Math.floor(t1 * ALIGN_SR));
    const spans = await aligner.align(slice, words.slice(a, b).map((w) => w.text));
    spans.forEach((sp, k) => {
      if (sp.start === undefined || sp.end === undefined || (sp.score ?? -99) < minScore) return;
      const w = out[a + k]!;
      shifts.push(Math.abs(t0 + sp.start - w.start) * 1000);
      w.start = Number((t0 + sp.start).toFixed(3));
      w.end = Number((t0 + sp.end).toFixed(3));
      aligned++;
    });
  }
  // keep order: unaligned words stay inside their neighbours' bounds
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.start < out[i - 1]!.start) out[i]!.start = out[i - 1]!.end;
    if (out[i]!.end <= out[i]!.start) out[i]!.end = out[i]!.start + 0.05;
  }
  shifts.sort((x, y) => x - y);
  return { words: out, aligned, medianShiftMs: shifts.length ? Math.round(shifts[Math.floor(shifts.length / 2)]!) : 0 };
}
