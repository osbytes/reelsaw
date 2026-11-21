/**
 * A video processed only from its start: when an account's minutes cover part of a long video (a Free account's
 * first video past its 60 free minutes, or a video longer than the minutes left this month), Reelsaw transcribes and
 * clips the first part (`projects.source_limit_sec`) instead of refusing the video, and finishes the rest when the
 * minutes are there (an upgrade, a new month): `extendProject` on the server, the "Clip the rest" button, MCP
 * `extend_project`, `reelsaw extend-project`. The server, the web app, MCP and the CLI read the range from here.
 */

/** The second the pipeline's work ends at: the processed part of a partial project, else the whole video (null = length unknown yet). */
export function processedEndSec(p: { durationSec: number | null | undefined; sourceLimitSec?: number | null | undefined }): number | null {
  const d = p.durationSec ?? null;
  const limit = p.sourceLimitSec ?? null;
  if (limit === null) return d;
  return d === null ? limit : Math.min(d, limit);
}

/** Why only the start was processed: the first-video allowance, or the minutes left this period (or today). */
export type PartialReason = "first_video" | "minutes";

/**
 * What a partial project's screens, `get_project` and `reelsaw project` say about it: how much was processed, how much is
 * left, and what finishes it (Clip the rest now, or the plan that covers it).
 */
export interface PartialSource {
  /** seconds processed from the start */
  processedSec: number;
  /** the whole video, in seconds */
  durationSec: number;
  /** seconds not processed yet */
  remainingSec: number;
  /** an extension is running (transcribing, refining or picking moments in the rest) */
  extending: boolean;
  /**
   * What "Clip the rest" would process right now: the seconds the account's minutes cover (all of the rest, or a part of
   * it), or null when none are left (then `upgrade` says what does).
   */
  extendableSec: number | null;
  /** the plan to move to when the account's minutes do not cover all of the rest (the minutes limit's upgrade offer) */
  upgrade: { label: string; href: string } | null;
  /** one sentence for every surface: what was processed and what finishes it */
  sentence: string;
}
