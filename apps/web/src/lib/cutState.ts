/**
 * What the last render did with a disfluency cut: cut, cut without a seam check (the user's own cuts
 * are never dropped, so a seam that could not be matched is applied as set and flagged), or kept in
 * the audio (an automatic cut that could not be verified). Pure so a test can load it without React.
 */

export interface CutDiagnostics {
  cuts: {
    applied: Array<{ start: number; end: number; verified?: boolean; reason?: string }>;
    skipped: Array<{ start: number; end: number; reason: string }>;
  };
}
export interface CutClip {
  startSec: number;
  endSec: number;
  diagnostics?: CutDiagnostics | null;
}
export type CutState = { state: "applied" } | { state: "unverified"; reason: string } | { state: "skipped"; reason: string };

const SEVERITY = { applied: 0, unverified: 1, skipped: 2 } as const;

/** The render outcome of one flagged span, from the latest render of every clip that contains it; null before any render. */
export function cutState(flag: { start: number; end: number }, clips: CutClip[]): CutState | null {
  let worst: CutState | null = null;
  for (const c of clips) {
    const d = c.diagnostics;
    if (!d || flag.start < c.startSec - 0.01 || flag.end > c.endSec + 0.05) continue;
    const hit = d.cuts.applied.find((a) => a.start < flag.end + 0.15 && a.end > flag.start - 0.15);
    const sk = d.cuts.skipped.find((s) => Math.abs(s.start - flag.start) < 0.35);
    const s: CutState | null = hit ? (hit.verified === false ? { state: "unverified", reason: hit.reason ?? "" } : { state: "applied" }) : sk ? { state: "skipped", reason: sk.reason } : null;
    if (s && (!worst || SEVERITY[s.state] > SEVERITY[worst.state])) worst = s;
  }
  return worst;
}

/** Short label with a glyph for the warning states (never colour alone). */
export function cutStateLabel(s: CutState): string {
  return s.state === "applied" ? "Cut" : s.state === "unverified" ? "▲ Cut unverified" : "▲ Kept in audio";
}

export function cutStateTitle(s: CutState): string {
  if (s.state === "applied") return "Removed from the audio at a verified seam.";
  if (s.state === "unverified") return `Applied where you set it, without a seam check: the audio around it couldn’t be matched.${s.reason ? `\n${s.reason}` : ""}`;
  return `The removal couldn’t be verified, so the audio was kept. Captions still drop the word.${s.reason ? `\n${s.reason}` : ""}`;
}
