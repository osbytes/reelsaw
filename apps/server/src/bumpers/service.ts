/**
 * Project intro / outro coverage with the assets named: the one function behind the project list,
 * the project page, `reelsaw status` and the MCP tools. One query for every referenced asset
 * (soft-deleted ones still resolve, so a project never shows a blank name).
 */
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "../db/index.js";
import { bumperCoverage, type BumperCoverage, type SlotCoverage } from "./summary.js";

export interface SlotSummary {
  assetId: string;
  name: string;
  kind: "video" | "image";
  thumbnailUrl: string;
  withCount: number;
  total: number;
  /** clips using a different asset in this slot */
  otherCount: number;
  /** clips with nothing in this slot */
  noneCount: number;
}
export interface ProjectBumperSummary {
  intro: SlotSummary | null;
  outro: SlotSummary | null;
}

export async function projectBumperSummaries(
  db: Db,
  userId: string,
  projects: { id: string; settings: { introAssetId?: string | null; outroAssetId?: string | null } | null; clips: { bumpers?: { intro?: string | null; outro?: string | null } | null }[] }[],
): Promise<Map<string, ProjectBumperSummary>> {
  const coverage = new Map<string, BumperCoverage>(projects.map((p) => [p.id, bumperCoverage(p, p.clips)]));
  const ids = new Set<string>();
  for (const c of coverage.values()) for (const s of [c.intro, c.outro]) if (s) ids.add(s.assetId);
  const assets = ids.size
    ? await db.select({ id: schema.bumperAssets.id, name: schema.bumperAssets.name, kind: schema.bumperAssets.kind }).from(schema.bumperAssets).where(and(eq(schema.bumperAssets.userId, userId), inArray(schema.bumperAssets.id, [...ids])))
    : [];
  const byId = new Map(assets.map((a) => [a.id, a]));
  const slot = (s: SlotCoverage | null): SlotSummary | null => {
    const a = s && byId.get(s.assetId);
    if (!s || !a) return null;
    return { assetId: s.assetId, name: a.name, kind: a.kind, thumbnailUrl: `/media/bumpers/${a.id}/thumb.jpg`, withCount: s.withCount, total: s.total, otherCount: s.others.reduce((n, o) => n + o.count, 0), noneCount: s.noneCount };
  };
  return new Map([...coverage].map(([id, c]) => [id, { intro: slot(c.intro), outro: slot(c.outro) }]));
}
