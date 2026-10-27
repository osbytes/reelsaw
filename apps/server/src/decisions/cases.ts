/**
 * Decision rows → eval cases (docs/specs/decision-log.md, "Consumers"). Pure: the `decisions` replay suite, the
 * harvest tool and `export_decisions` share it, so an export means the same thing everywhere.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { DECISION_KINDS } from "@reelsaw/shared";
import type { Case, Split } from "../eval/suites/disfluency.js";

/** A decision as exported (`reelsaw decisions export`, MCP `export_decisions`): one JSON object per line. */
export const exportedDecisionSchema = z.object({
  id: z.number(),
  projectId: z.string(),
  clipId: z.string().nullable().optional(),
  kind: z.enum(DECISION_KINDS),
  explicit: z.boolean(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  context: z.record(z.string(), z.unknown()),
  models: z.record(z.string(), z.string()).default({}),
  source: z
    .object({ type: z.enum(["url", "upload"]), url: z.string(), extractor: z.string(), videoId: z.string(), formatId: z.string(), durationSec: z.number(), sha256: z.string(), title: z.string(), uploader: z.string() })
    .partial(),
  appVersion: z.string().optional(),
  createdAt: z.string(),
});
export type ExportedDecision = z.infer<typeof exportedDecisionSchema>;

const fixContextSchema = z.object({
  flagKind: z.string(),
  subkind: z.string().nullable().optional(),
  words: z.array(z.object({ text: z.string(), start: z.number(), end: z.number() })).min(1),
  target: z.object({ index: z.number().int().min(0), span: z.number().int().min(1) }),
});

/** The case shape of eval/fixtures/disfluency/cases.json, defined once by the suite that runs it. */
export type DisfluencyCase = Case;

/** Dev or heldout by project, never by row: windows of one video must not land on both sides (leakage). */
export function splitOf(projectId: string): Split {
  return (createHash("sha256").update(projectId).digest()[0]! & 1) === 0 ? "dev" : "heldout";
}

/** A YouTube link that opens at the decision (other sites: the link as stored). */
function linkAt(url: string | undefined, sec: number): string | undefined {
  if (!url) return undefined;
  return /youtube\.com\/watch|youtu\.be\//.test(url) ? `${url}${url.includes("?") ? "&" : "?"}t=${Math.floor(sec)}` : url;
}

/** The word window an explicit decision about a disfluency cut was made on, whether or not it is a label. */
function disfluencyWindow(d: ExportedDecision) {
  if (!d.explicit) return null;
  const ctx = fixContextSchema.safeParse(d.context);
  if (!ctx.success || ctx.data.flagKind !== "disfluency") return null;
  const { target, words } = ctx.data;
  return target.index + target.span > words.length ? null : ctx.data;
}

/**
 * The disfluency case a decision stands for, or null when it is not one: an explicit decision about a cut.
 *   fix.accept of a detector cut    → cut  (it was right)
 *   fix.reject of a detector cut    → keep (it was wrong)
 *   fix.delete of a detector cut    → keep (the user removed a cut it had applied)
 *   fix.manual cut                  → cut  (a miss: the detector should have found it)
 * Deleting or rejecting your own manual cut is an undo, not a label.
 */
export function disfluencyCaseOf(d: ExportedDecision): DisfluencyCase | null {
  const ctx = disfluencyWindow(d);
  if (!ctx) return null;
  const manual = ctx.subkind === "manual";
  const expect: "cut" | "keep" | null =
    d.kind === "fix.accept" && !manual ? "cut" : d.kind === "fix.reject" && !manual ? "keep" : d.kind === "fix.delete" && !manual ? "keep" : d.kind === "fix.manual" ? "cut" : null;
  if (!expect) return null;
  const { words, target } = ctx;
  const said = words.slice(target.index, target.index + target.span).map((w) => w.text);
  const slug = said.join("-").toLowerCase().replace(/[^a-z0-9-]+/g, "").slice(0, 40) || "span";
  const at = words[target.index]!.start;
  return {
    id: `d${d.id}-${slug}`,
    expect,
    kind: ctx.subkind ?? "manual",
    split: splitOf(d.projectId),
    source: {
      url: linkAt(d.source.url, at),
      projectId: d.projectId,
      decidedAt: d.createdAt.slice(0, 10),
      videoId: d.source.videoId,
      sha256: d.source.sha256,
    },
    target,
    label: `user decision: ${d.kind}`,
    words,
  };
}

/** Same words and target: two cases that test the same thing (a decision made twice, or already a committed case). */
export function caseKey(c: Pick<DisfluencyCase, "words" | "target">): string {
  const a = Math.max(0, c.target.index - 6);
  const b = c.target.index + c.target.span + 6;
  return `${c.words.slice(a, c.target.index).map((w) => w.text).join(" ")}[${c.words.slice(c.target.index, c.target.index + c.target.span).map((w) => w.text).join(" ")}]${c.words.slice(c.target.index + c.target.span, b).map((w) => w.text).join(" ")}`.toLowerCase();
}

/**
 * Cases from an export, deduped by `caseKey`; when one window was decided more than once, the latest decision wins
 * (rows come newest first from the export, so the first seen is kept), even when it is no label: undoing a manual
 * cut or restoring a deleted cut takes the older label back. `exclude` drops cases already committed.
 */
export function disfluencyCases(rows: ExportedDecision[], exclude: Iterable<string> = []): DisfluencyCase[] {
  const seen = new Set(exclude);
  const out: DisfluencyCase[] = [];
  for (const r of [...rows].sort((a, b) => b.id - a.id)) {
    const w = disfluencyWindow(r);
    if (!w) continue;
    const k = caseKey(w);
    if (seen.has(k)) continue;
    seen.add(k);
    const c = disfluencyCaseOf(r);
    if (c) out.push(c);
  }
  return out;
}

/** Parse an export file (JSON lines). Lines that are not decisions are reported, not fatal. */
export function parseExport(text: string): { rows: ExportedDecision[]; bad: number } {
  const rows: ExportedDecision[] = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = exportedDecisionSchema.safeParse(JSON.parse(line));
      if (r.success) rows.push(r.data);
      else bad++;
    } catch {
      bad++;
    }
  }
  return { rows, bad };
}
