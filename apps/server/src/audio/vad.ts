/**
 * Voice activity detection with Silero VAD v5 (2.3 MB ONNX, MIT, CPU). Used to tighten long pauses
 * in clips (silence jump cuts) — the most visible "edited" feel per unit of work.
 *
 * Model contract (v5): 512-sample frames of 16 kHz mono float PCM, prefixed with the previous
 * frame's last 64 samples, plus a recurrent state [2,1,128] carried frame to frame.
 */
import fs from "node:fs/promises";

export const VAD_SR = 16000;
const FRAME = 512;
const CONTEXT = 64;
export const VAD_FRAME_SEC = FRAME / VAD_SR; // 32 ms

export interface Vad {
  /** Speech probability per 32 ms frame. */
  probabilities(pcm: Float32Array): Promise<Float32Array>;
  release(): Promise<void>;
}

export async function loadVad(modelPath: string): Promise<Vad> {
  await fs.access(modelPath);
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 1, logSeverityLevel: 3 });
  const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(VAD_SR)]), []);
  return {
    async probabilities(pcm) {
      const frames = Math.floor(pcm.length / FRAME);
      const out = new Float32Array(frames);
      let state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
      const buf = new Float32Array(CONTEXT + FRAME);
      for (let f = 0; f < frames; f++) {
        // context = last 64 samples of the previous frame (zeros for the first)
        if (f > 0) buf.set(pcm.subarray(f * FRAME - CONTEXT, f * FRAME), 0);
        else buf.fill(0, 0, CONTEXT);
        buf.set(pcm.subarray(f * FRAME, (f + 1) * FRAME), CONTEXT);
        const res = await session.run({ input: new ort.Tensor("float32", buf.slice(), [1, CONTEXT + FRAME]), state, sr });
        out[f] = (res.output!.data as Float32Array)[0]!;
        state = res.stateN as typeof state;
      }
      return out;
    },
    release: () => session.release(),
  };
}

export interface SpeechSegment {
  start: number;
  end: number;
}

/**
 * Probabilities → speech segments with hysteresis (enter at `on`, leave below `off`), dropping blips
 * shorter than `minSpeech` and bridging gaps shorter than `minSilence`.
 */
export function speechSegments(probs: Float32Array, opts: { on?: number; off?: number; minSpeech?: number; minSilence?: number } = {}): SpeechSegment[] {
  const on = opts.on ?? 0.5;
  const off = opts.off ?? 0.35;
  const minSpeech = opts.minSpeech ?? 0.12;
  const minSilence = opts.minSilence ?? 0.1;
  const segs: SpeechSegment[] = [];
  let start = -1;
  for (let i = 0; i < probs.length; i++) {
    const p = probs[i]!;
    const t = i * VAD_FRAME_SEC;
    if (start < 0 && p >= on) start = t;
    else if (start >= 0 && p < off) {
      segs.push({ start, end: t });
      start = -1;
    }
  }
  if (start >= 0) segs.push({ start, end: probs.length * VAD_FRAME_SEC });
  const merged: SpeechSegment[] = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.start - last.end < minSilence) last.end = s.end;
    else merged.push({ ...s });
  }
  return merged.filter((s) => s.end - s.start >= minSpeech);
}

/**
 * Pauses longer than `maxPause` are shortened to `maxPause` by cutting their middle (so each side
 * keeps a natural breath of maxPause/2). Leading/trailing silence keeps `edge` seconds. Returns cut
 * ranges in the same time base as the segments.
 */
export function pauseCuts(
  segments: SpeechSegment[],
  duration: number,
  opts: { maxPause: number; edge?: number; minCut?: number },
): Array<{ start: number; end: number }> {
  const edge = opts.edge ?? 0.15;
  const minCut = opts.minCut ?? 0.15;
  const cuts: Array<{ start: number; end: number }> = [];
  if (!segments.length) return cuts;
  const first = segments[0]!;
  if (first.start - edge >= minCut) cuts.push({ start: 0, end: first.start - edge });
  for (let i = 1; i < segments.length; i++) {
    const gapStart = segments[i - 1]!.end;
    const gapEnd = segments[i]!.start;
    const gap = gapEnd - gapStart;
    if (gap <= opts.maxPause) continue;
    const half = opts.maxPause / 2;
    if (gap - opts.maxPause >= minCut) cuts.push({ start: gapStart + half, end: gapEnd - half });
  }
  const last = segments[segments.length - 1]!;
  if (duration - (last.end + edge) >= minCut) cuts.push({ start: last.end + edge, end: duration });
  return cuts.map((c) => ({ start: Number(c.start.toFixed(3)), end: Number(c.end.toFixed(3)) }));
}
