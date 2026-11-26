import fs from "node:fs/promises";
import type { Logger } from "../log.js";
import { NonRetryableError } from "./common.js";

/** Runs ffmpeg with these arguments (MediaTools.ffmpeg, bound to the job's signal and thread budget). */
export type RunFfmpeg = (args: string[]) => Promise<unknown>;

const thumbnailArgs = (input: string, output: string, atSec: number) => [
  ...(atSec > 0 ? ["-ss", atSec.toFixed(2)] : []),
  "-i",
  input,
  "-frames:v",
  "1",
  "-vf",
  "scale=540:-2",
  "-q:v",
  "3",
  output,
];

async function nonEmpty(file: string) {
  try {
    return (await fs.stat(file)).size > 0;
  } catch {
    return false;
  }
}

/**
 * A still of the rendered clip: a third of the way into its body, else the body's first frame, else the file's first
 * frame. A seek past the end of the video track writes nothing: ffmpeg 5.1 (the image's) exits 0 with no file, newer
 * ones fail with "Nothing was written". Without the fallbacks the upload of the missing file then failed the clip on
 * every retry, though the video itself was rendered. A clip with no picture at all fails at once, not five times.
 */
export async function takeThumbnail(
  run: RunFfmpeg,
  opts: { input: string; output: string; atSec: number; bodyStartSec: number; signal?: AbortSignal | undefined; log: Logger },
): Promise<void> {
  const tries = [...new Set([opts.atSec, opts.bodyStartSec, 0].map((s) => Math.max(0, Number(s.toFixed(2)))))];
  let lastErr: unknown;
  for (const sec of tries) {
    await fs.rm(opts.output, { force: true });
    try {
      await run(thumbnailArgs(opts.input, opts.output, sec));
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastErr = err;
    }
    if (await nonEmpty(opts.output)) {
      if (sec !== tries[0]) opts.log.warn({ atSec: tries[0], usedSec: sec, err: lastErr }, "thumbnail seek found no frame; used an earlier one");
      return;
    }
  }
  const reason = lastErr instanceof Error ? `: ${lastErr.message}` : "";
  throw new NonRetryableError(`the rendered clip has no picture, so no thumbnail could be taken${reason}`, "platform");
}
