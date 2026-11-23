/**
 * The one muted line under a clip card ("Auto · Follow speaker · intro 3 s · outro 3 s · 1.9 s trimmed") and
 * the text a clip copies to the clipboard. Pure and React-free so a test can load it without the app: the words are
 * catalogue messages (explicit ids, marked for extraction) rendered through the runtime i18n, not the build macros.
 */
import { formatNumber } from "@reelsaw/shared";
import { tr } from "./tr";

export interface MetaClip {
  layout: string | null;
  layoutOverride: string | null;
  layoutSections?: Array<{ mode: string }>;
  layoutSegments?: Array<{ layout: string; inset?: unknown; focus?: string | undefined }>;
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

/**
 * The label key of a rendered piece: its layout, or what an automatic choice did inside it ("inset": a Whole frame
 * that showed a picture inset between bars; "subject": a crop that followed the moving subject of a shot without a face).
 * The one reading for the clip card and the editor (`layoutLabel`).
 */
export function pieceKind(s: { layout: string; inset?: unknown; focus?: string | undefined }): string {
  if (s.layout === "fit" && s.inset) return "inset";
  if (s.layout === "center" && s.focus === "subject") return "subject";
  return s.layout;
}

function framing(c: MetaClip, labels: Record<string, string>): string | null {
  const segs = c.layoutSegments ?? [];
  const forced = (c.layoutSections?.length ?? 0) > 0 || (!!c.layoutOverride && c.layoutOverride !== "auto");
  const auto = forced ? "" : `${tr(/*i18n*/ { id: "clipmeta.auto", message: "Auto" })} · `;
  if (!segs.length) return c.layout ? `${auto}${labels[c.layout] ?? c.layout}` : null;
  const names: string[] = [];
  for (const s of segs) {
    const k = pieceKind(s);
    const n = labels[k] ?? k;
    if (names.at(-1) !== n) names.push(n);
  }
  return `${auto}${names.join(" → ")}${forced ? ` ${tr(/*i18n*/ { id: "clipmeta.set", message: "(set)" })}` : ""}`;
}

const secs = (n: number | undefined) =>
  n && n > 0 ? ` ${formatNumber(n, Number.isInteger(n) ? {} : { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s` : "";
const slotWord = (slot: "intro" | "outro") =>
  slot === "intro" ? tr(/*i18n*/ { id: "clipmeta.intro", message: "intro" }) : tr(/*i18n*/ { id: "clipmeta.outro", message: "outro" });

function bumperPart(c: MetaClip, slot: "intro" | "outro", projectHas: boolean): { text: string; skipped: boolean } | null {
  const own = c.bumpers?.[slot];
  const d = c.diagnostics?.bumpers;
  const word = slotWord(slot);
  if (d?.skipped?.some((s) => s.startsWith(slot)))
    return { text: `▲ ${tr(/*i18n*/ { id: "clipmeta.skipped", message: "{word} skipped", values: { word } })}`, skipped: true };
  const rendered = slot === "intro" ? d?.introSec : d?.outroSec;
  const own_sec = slot === "intro" ? c.bumpers?.introSec : c.bumpers?.outroSec;
  if (own === null) return projectHas ? { text: tr(/*i18n*/ { id: "clipmeta.none", message: "no {word}", values: { word } }), skipped: false } : null;
  if (typeof own === "string") {
    const length = secs(d ? rendered : own_sec);
    return { text: tr(/*i18n*/ { id: "clipmeta.own", message: "{word}{length} (this clip)", values: { word, length } }), skipped: false };
  }
  // inherited: what the last render attached, else the project's choice (length unknown until rendered)
  if (d) return rendered ? { text: `${word}${secs(rendered)}`, skipped: false } : null;
  return projectHas ? { text: word, skipped: false } : null;
}

export function clipMeta(c: MetaClip, o: MetaOptions): Meta {
  const parts: string[] = [];
  const long: string[] = [];
  let warn = false;
  const f = framing(c, o.modeLabel);
  if (f) {
    parts.push(f);
    long.push(tr(/*i18n*/ { id: "clipmeta.framing", message: "Framing: {f}", values: { f } }));
  }
  for (const [slot, has] of [
    ["intro", o.projectHasIntro],
    ["outro", o.projectHasOutro],
  ] as const) {
    const b = bumperPart(c, slot, has);
    if (!b) continue;
    parts.push(b.text);
    const text = `${b.text}${b.skipped ? ` (${c.diagnostics?.bumpers?.skipped?.filter((s) => s.startsWith(slot)).join("; ")})` : ""}`;
    long.push(
      slot === "intro"
        ? tr(/*i18n*/ { id: "clipmeta.introLine", message: "Intro: {text}", values: { text } })
        : tr(/*i18n*/ { id: "clipmeta.outroLine", message: "Outro: {text}", values: { text } }),
    );
    if (b.skipped) warn = true;
  }
  const d = c.diagnostics;
  if (d) {
    const cuts = d.cuts.applied.length;
    const kept = d.cuts.skipped.length;
    const unverified = d.cuts.applied.flatMap((a) =>
      a && typeof a === "object" && (a as { verified?: boolean }).verified === false ? [String((a as { reason?: string }).reason ?? "")] : [],
    );
    const trimmed = d.pauses?.cuts ? d.pauses.removedSec : 0;
    if (trimmed > 0) {
      const s = formatNumber(trimmed, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      parts.push(tr(/*i18n*/ { id: "clipmeta.trimmed", message: "{s} s trimmed", values: { s } }));
      long.push(tr(/*i18n*/ { id: "clipmeta.pauses", message: "Pauses: {s} s trimmed", values: { s } }));
    }
    if (cuts) {
      parts.push(tr(/*i18n*/ { id: "clipmeta.cuts", message: "{cuts, plural, one {# cut} other {# cuts}}", values: { cuts } }));
      long.push(tr(/*i18n*/ { id: "clipmeta.cutsLine", message: "Cuts: {cuts} applied", values: { cuts } }));
    }
    if (unverified.length) {
      const n = unverified.length;
      parts.push(`▲ ${tr(/*i18n*/ { id: "clipmeta.unverified", message: "{n, plural, one {# cut unverified} other {# cuts unverified}}", values: { n } })}`);
      long.push(
        tr(
          /*i18n*/ {
            id: "clipmeta.unverifiedLine",
            message:
              "{n, plural, one {Applied where you set it, without a seam check (the audio around it couldn’t be matched):} other {Applied where you set them, without a seam check (the audio around them couldn’t be matched):}}",
            values: { n },
          },
        ),
        ...unverified.map((r) => `  ${r}`),
      );
      warn = true;
    }
    if (kept) {
      parts.push(`▲ ${tr(/*i18n*/ { id: "clipmeta.kept", message: "{kept, plural, one {# cut kept} other {# cuts kept}}", values: { kept } })}`);
      long.push(
        tr(/*i18n*/ { id: "clipmeta.keptLine", message: "Kept because removal couldn’t be verified (the audio stays; captions still drop the word):" }),
        ...d.cuts.skipped.map((s) => `  ${s.reason}`),
      );
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
