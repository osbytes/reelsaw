/**
 * The decision log (docs/specs/decision-log.md): what a user decided about the pipeline's output, recorded so it can
 * teach the pipeline and feed evals after the project itself is gone.
 */

export const DECISION_KINDS = [
  "fix.accept",
  "fix.reject",
  "fix.manual",
  "fix.delete",
  "fix.restore",
  "clip.edit",
  "clip.create",
  "clip.delete",
  "clip.restore",
  "clip.replaced",
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/**
 * Which source a decision's timestamps refer to, snapshotted when it was made. A re-download from the same `videoId`
 * is not byte-identical in general: a matching `sha256` proves the same file; otherwise re-anchor by the words the
 * decision stores. An upload has no url: its hash only links a later re-upload of the same file.
 */
export interface SourceRef {
  type: "url" | "upload";
  url?: string | undefined;
  /** yt-dlp extractor_key, e.g. Youtube */
  extractor?: string | undefined;
  /** the platform's id for the video */
  videoId?: string | undefined;
  /** yt-dlp format_id of the download */
  formatId?: string | undefined;
  durationSec?: number | undefined;
  /** sha256 of the stored source file, hex */
  sha256?: string | undefined;
  title?: string | undefined;
  uploader?: string | undefined;
}
