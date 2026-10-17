/**
 * How much of a project carries its intro / outro: one summary per slot, computed with the same
 * resolution the renderer uses (`resolveClipBumpers`), so the list chips, `reelsaw status` and the
 * MCP tools all say the same thing. Pure: no database.
 */
import { resolveClipBumpers } from "../pipeline/bumpers.js";

export interface SlotCoverage {
  /** the most common asset in this slot (first seen wins a tie) */
  assetId: string;
  /** clips that resolve to `assetId` */
  withCount: number;
  total: number;
  /** other assets used on some clips, most used first */
  others: { assetId: string; count: number }[];
  /** clips with nothing in this slot */
  noneCount: number;
}
export interface BumperCoverage {
  intro: SlotCoverage | null;
  outro: SlotCoverage | null;
}

type ProjectIn = { settings?: { introAssetId?: string | null; outroAssetId?: string | null } | null };
type ClipIn = { bumpers?: { intro?: string | null; outro?: string | null } | null };

export function bumperCoverage(project: ProjectIn, clips: ClipIn[]): BumperCoverage {
  const settings = project.settings ?? {};
  const counts = { intro: new Map<string, number>(), outro: new Map<string, number>() };
  for (const clip of clips) {
    const r = resolveClipBumpers(settings, clip);
    if (r.introId) counts.intro.set(r.introId, (counts.intro.get(r.introId) ?? 0) + 1);
    if (r.outroId) counts.outro.set(r.outroId, (counts.outro.get(r.outroId) ?? 0) + 1);
  }
  const slot = (m: Map<string, number>): SlotCoverage | null => {
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]); // stable: first seen wins a tie
    if (!sorted.length) return null;
    const [assetId, withCount] = sorted[0]!;
    const used = sorted.reduce((n, [, c]) => n + c, 0);
    return { assetId, withCount, total: clips.length, others: sorted.slice(1).map(([id, count]) => ({ assetId: id, count })), noneCount: clips.length - used };
  };
  return { intro: slot(counts.intro), outro: slot(counts.outro) };
}

/** One plain sentence, e.g. "outro copia-qr on 3/9 clips (6 none, 1 other)". Takes a SlotSummary (service.ts) or a coverage. */
export function describeCoverage(slot: "intro" | "outro", name: string, c: { withCount: number; total: number; noneCount: number; otherCount: number }): string {
  const rest = [c.noneCount ? `${c.noneCount} none` : "", c.otherCount ? `${c.otherCount} other` : ""].filter(Boolean);
  return `${slot} ${name} on ${c.withCount}/${c.total} clips${rest.length ? ` (${rest.join(", ")})` : ""}`;
}
