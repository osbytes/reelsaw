/**
 * How much of a project carries its intro / outro: one summary per slot, computed with the same
 * resolution the renderer uses (`resolveClipBumpers`), so the list chips, `reelsaw status` and the
 * MCP tools all say the same thing. Pure: no database.
 */
import { clipLayers } from "@reelsaw/shared";
import { resolveClipBumpers } from "../pipeline/bumpers.js";

export interface SlotCoverage {
  /** the most common asset in this slot (first seen wins a tie) */
  assetId: string;
  /** clips that resolve to `assetId` */
  withCount: number;
  total: number;
  /** other assets used on some clips, most used first */
  others: { assetId: string; count: number }[];
  /** every distinct asset used in this slot, most used first (first seen wins a tie) */
  assets: { assetId: string; count: number }[];
  /** clips with nothing in this slot */
  noneCount: number;
}
export interface BumperCoverage {
  intro: SlotCoverage | null;
  outro: SlotCoverage | null;
}

type ProjectIn = { settings?: { introAssetId?: string | null; outroAssetId?: string | null } | null };
type ClipIn = {
  bumpers?: { intro?: string | null; outro?: string | null } | null;
  /** layers (or the older overlays + audio) also hold library assets (see `assetRefs`) */
  layers?: unknown;
  overlays?: unknown;
  audio?: unknown;
};

/** Library assets a clip lays over itself or plays under itself: asset and audio layer ids (legacy overlays + audio rows read as layers). */
export function assetRefs(clip: Pick<ClipIn, "layers" | "overlays" | "audio">): Set<string> {
  const ids = new Set<string>();
  for (const l of clipLayers(clip)) if (l.kind !== "text") ids.add(l.assetId);
  return ids;
}

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
    return { assetId, withCount, total: clips.length, assets: sorted.map(([id, count]) => ({ assetId: id, count })), others: sorted.slice(1).map(([id, count]) => ({ assetId: id, count })), noneCount: clips.length - used };
  };
  return { intro: slot(counts.intro), outro: slot(counts.outro) };
}

/**
 * Per asset id: how many projects and clips use it (intro, outro, layer), by the same resolution the render uses. The database path
 * (`bumperUsageCounts`) counts a clip only when it names the asset itself; this pure version also counts clips that inherit it. A project counts
 * when at least one of its clips uses the asset anywhere (a clip using it in several places counts
 * once); a project with no clips counts when its settings name the asset. Pure: no database.
 */
export function countBumperUsage(
  projects: { settings?: { introAssetId?: string | null; outroAssetId?: string | null } | null; clips: ClipIn[] }[],
): Map<string, { projects: number; clips: number }> {
  const out = new Map<string, { projects: number; clips: number }>();
  const bump = (id: string, key: "projects" | "clips") => {
    const e = out.get(id) ?? { projects: 0, clips: 0 };
    e[key]++;
    out.set(id, e);
  };
  for (const p of projects) {
    const settings = p.settings ?? {};
    const inProject = new Set<string>();
    if (!p.clips.length) {
      for (const id of [settings.introAssetId, settings.outroAssetId]) if (id) inProject.add(id);
    }
    for (const clip of p.clips) {
      const r = resolveClipBumpers(settings, clip);
      const ids = new Set([r.introId, r.outroId].filter((x): x is string => !!x));
      for (const id of assetRefs(clip)) ids.add(id);
      for (const id of ids) {
        bump(id, "clips");
        inProject.add(id);
      }
    }
    for (const id of inProject) bump(id, "projects");
  }
  return out;
}

/** One plain sentence, e.g. "outro copia-qr on 3/9 clips (6 none, 1 other)". Takes a SlotSummary (service.ts) or a coverage. */
export function describeCoverage(slot: "intro" | "outro", name: string, c: { withCount: number; total: number; noneCount: number; otherCount: number }): string {
  const rest = [c.noneCount ? `${c.noneCount} none` : "", c.otherCount ? `${c.otherCount} other` : ""].filter(Boolean);
  return `${slot} ${name} on ${c.withCount}/${c.total} clips${rest.length ? ` (${rest.join(", ")})` : ""}`;
}
