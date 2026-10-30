/**
 * The one muted line under a clip card ("Auto · Follow speaker · intro 3 s · outro 3 s · 1.9 s trimmed") and
 * the text a clip copies to the clipboard. Pure and dependency-free so a test can load it without React.
 */

export interface MetaClip {
  layout: string | null;
  layoutOverride: string | null;
  layoutSections?: Array<{ mode: string }>;
  layoutSegments?: Array<{ layout: string }>;
  bumpers?: { intro?: string | null | undefined; outro?: string | null | undefined; introSec?: number | undefined; outroSec?: number | undefined } | null;
  diagnostics?: {
    pauses?: { cuts: number; removedSec: number };
    cuts: { applied: Array<unknown>; skipped: Array<{ start: number; reason: string }> };
    bumpers?: { introSec: number; outroSec: number; skipped?: string[] };
  } | null;
}

export interface MetaOptions {
  /** layout mode id to its label ("face" to "Follow speaker") */
  modeLabel: Record<string, string>;
  projectHasIntro: boolean;
  projectHasOutro: boolean;
}

export interface Meta {
  /** the single truncating line */
  text: string;
  /** the same facts in full, one per line, for the tooltip */
  title: string;
  /** a render skipped a part or a cut could not be verified: shown with a glyph, not colour alone */
  warn: boolean;
}

function framing(c: MetaClip, labels: Record<string, string>): string | null {
  const segs = c.layoutSegments ?? [];
  const forced = (c.layoutSections?.length ?? 0) > 0 || (!!c.layoutOverride && c.layoutOverride !== "auto");
  const auto = forced ? "" : "Auto · ";
  if (!segs.length) return c.layout ? `${auto}${labels[c.layout] ?? c.layout}` : null;
  const names: string[] = [];
  for (const s of segs) {
    const n = labels[s.layout] ?? s.layout;
    if (names.at(-1) !== n) names.push(n);
  }
  return `${auto}${names.join(" → ")}${forced ? " (set)" : ""}`;
}

const secs = (n: number | undefined) => (n && n > 0 ? ` ${Number.isInteger(n) ? n : n.toFixed(1)} s` : "");

function bumperPart(c: MetaClip, slot: "intro" | "outro", projectHas: boolean): { text: string; skipped: boolean } | null {
  const own = c.bumpers?.[slot];
  const d = c.diagnostics?.bumpers;
  if (d?.skipped?.some((s) => s.startsWith(slot))) return { text: `▲ ${slot} skipped`, skipped: true };
  const rendered = slot === "intro" ? d?.introSec : d?.outroSec;
  const own_sec = slot === "intro" ? c.bumpers?.introSec : c.bumpers?.outroSec;
  if (own === null) return projectHas ? { text: `no ${slot}`, skipped: false } : null;
  if (typeof own === "string") return { text: `${slot}${secs(d ? rendered : own_sec)} (this clip)`, skipped: false };
  // inherited: what the last render attached, else the project's choice (length unknown until rendered)
  if (d) return rendered ? { text: `${slot}${secs(rendered)}`, skipped: false } : null;
  return projectHas ? { text: slot, skipped: false } : null;
}

export function clipMeta(c: MetaClip, o: MetaOptions): Meta {
  const parts: string[] = [];
  const long: string[] = [];
  let warn = false;
  const f = framing(c, o.modeLabel);
  if (f) {
    parts.push(f);
    long.push(`Framing: ${f}`);
  }
  for (const [slot, has] of [["intro", o.projectHasIntro], ["outro", o.projectHasOutro]] as const) {
    const b = bumperPart(c, slot, has);
    if (!b) continue;
    parts.push(b.text);
    long.push(`${slot === "intro" ? "Intro" : "Outro"}: ${b.text}${b.skipped ? ` (${c.diagnostics?.bumpers?.skipped?.filter((s) => s.startsWith(slot)).join("; ")})` : ""}`);
    if (b.skipped) warn = true;
  }
  const d = c.diagnostics;
  if (d) {
    const cuts = d.cuts.applied.length;
    const kept = d.cuts.skipped.length;
    const unverified = d.cuts.applied.flatMap((a) => (a && typeof a === "object" && (a as { verified?: boolean }).verified === false ? [String((a as { reason?: string }).reason ?? "")] : []));
    const trimmed = d.pauses?.cuts ? d.pauses.removedSec : 0;
    if (trimmed > 0) {
      parts.push(`${trimmed.toFixed(1)} s trimmed`);
      long.push(`Pauses: ${trimmed.toFixed(1)} s trimmed`);
    }
    if (cuts) {
      parts.push(`${cuts} cut${cuts === 1 ? "" : "s"}`);
      long.push(`Cuts: ${cuts} applied`);
    }
    if (unverified.length) {
      parts.push(`▲ ${unverified.length} cut${unverified.length === 1 ? "" : "s"} unverified`);
      long.push(`Applied where you set ${unverified.length === 1 ? "it" : "them"}, without a seam check (the audio around ${unverified.length === 1 ? "it" : "them"} couldn’t be matched):`, ...unverified.map((r) => `  ${r}`));
      warn = true;
    }
    if (kept) {
      parts.push(`▲ ${kept} cut${kept === 1 ? "" : "s"} kept`);
      long.push(`Kept because removal couldn’t be verified (the audio stays; captions still drop the word):`, ...d.cuts.skipped.map((s) => `  ${s.reason}`));
      warn = true;
    }
  }
  return { text: parts.join(" · "), title: long.join("\n"), warn };
}

/** Title, caption and hashtags of one clip, blank-line separated; clips are joined by a rule so a paste stays readable. */
export function clipText(c: { title: string; caption: string; hashtags: string[] }): string {
  return [c.title, c.caption, c.hashtags.map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n\n");
}
export const clipsText = (cs: Array<{ title: string; caption: string; hashtags: string[] }>) => cs.map(clipText).join("\n\n---\n\n");
