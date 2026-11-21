/**
 * Clip loudness. Speech used to be rendered at whatever level the source had: clips of different videos
 * differed by more than 20 LU, and loud sources reached a true peak over 0 dBFS (audible clipping after AAC). Now the body's audio is measured once (EBU R128, ffmpeg's loudnorm in
 * analysis mode), brought to CLIP_LUFS with one linear gain (no dynamic processing: speech keeps its
 * shape) and the finished mix goes through a peak limiter, so nothing reaches full scale.
 */
import type { MediaTools } from "../media.js";

/** Integrated loudness a clip's audio is brought to: what TikTok, Reels and Shorts play at. */
export const CLIP_LUFS = -14;
/** Below this the clip is near silence (or music-only quiet): no gain, it would only raise noise. */
const SILENT_LUFS = -50;
/** A gain is never larger than this either way: a measurement that far off is not one to trust. */
const MAX_BOOST_DB = 15;
const MAX_CUT_DB = 20;
/**
 * Sample-peak ceiling of the final mix, about -1.5 dBFS: AAC adds up to ~1 dB of inter-sample overshoot,
 * so this keeps the decoded true peak under -0.5 dBTP. `level=false`: alimiter would otherwise
 * re-normalise; `latency=true` compensates its look-ahead so sound stays in sync with picture.
 */
export const PEAK_LIMITER = "alimiter=limit=0.84:attack=5:release=50:level=false:latency=true";

export interface Loudness {
  /** integrated loudness of the source range, LUFS */
  inputLufs: number;
  /** its true peak, dBTP */
  inputPeak: number;
}

/** Parse loudnorm's `print_format=json` block from ffmpeg's stderr; null when absent or not a number. */
export function parseLoudnorm(stderr: string): Loudness | null {
  const at = stderr.lastIndexOf("[Parsed_loudnorm");
  if (at < 0) return null;
  const json = /\{[\s\S]*?\}/.exec(stderr.slice(at));
  if (!json) return null;
  try {
    const raw: unknown = JSON.parse(json[0]);
    if (!raw || typeof raw !== "object") return null;
    const rec = Object.fromEntries(Object.entries(raw));
    const i = Number(rec.input_i);
    const tp = Number(rec.input_tp);
    return Number.isFinite(i) && Number.isFinite(tp) ? { inputLufs: i, inputPeak: tp } : null;
  } catch {
    return null;
  }
}

/** Measure a range of the source's audio; null without audio or when it cannot be measured. */
export async function measureLoudness(
  media: Pick<MediaTools, "ffmpeg">,
  source: string,
  start: number,
  duration: number,
  signal?: AbortSignal,
): Promise<Loudness | null> {
  const { stderr } = await media.ffmpeg(
    ["-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", source, "-vn", "-af", "loudnorm=print_format=json", "-f", "null", "-"],
    { signal },
  );
  return parseLoudnorm(stderr);
}

/** The linear gain (dB) that brings measured audio to CLIP_LUFS; 0 for near-silence or no measurement. */
export function speechGainDb(m: Loudness | null): number {
  if (!m || m.inputLufs < SILENT_LUFS) return 0;
  const gain = CLIP_LUFS - m.inputLufs;
  return Number(Math.max(-MAX_CUT_DB, Math.min(MAX_BOOST_DB, gain)).toFixed(2));
}
