/**
 * scenes: shot-cut detection (media.detectScenes → pickSceneCuts) against hand-verified cuts.
 * Precision and recall within a tolerance, over the graded part of each section.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { materialize, MediaDriftError, type CaseResult, type MediaSource, type Suite } from "../framework.js";
import { parseSceneScores, pickSceneCuts } from "../../pipeline/scenes.js";

interface Spec {
  cases: Array<{ id: string; source: MediaSource; gradeUntil?: number; expectCuts: number[]; tolerance?: number }>;
}

export const scenesSuite: Suite = {
  name: "scenes",
  description: "shot-cut detection on real footage (dark/low-contrast included): precision and recall vs hand-verified cuts",
  needs: ["media"],
  async run(ctx) {
    const spec = JSON.parse(await fs.readFile(path.join(ctx.fixtures("scenes"), "cases.json"), "utf8")) as Spec;
    const out: CaseResult[] = [];
    for (const c of spec.cases) {
      let media: string;
      try {
        media = await materialize(ctx, { ...c.source, strictSha: true }); // cut times are sub-second labels
      } catch (err) {
        out.push(err instanceof MediaDriftError ? { id: c.id, pass: false, notes: (err as Error).message } : { id: c.id, pass: false, skipped: (err as Error).message });
        continue;
      }
      const until = c.gradeUntil ?? c.source.end - c.source.start;
      const raw = await ctx.exec(ctx.config().FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-nostdin", "-t", String(until + 1), "-i", media, "-an", "-vf", "scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-", "-f", "null", "-"]);
      const { times, scores } = parseSceneScores(raw.toString().split("\n"));
      const found = pickSceneCuts(times, scores).filter((t) => t <= until);
      const tol = c.tolerance ?? 0.25;
      const hit = c.expectCuts.filter((e) => found.some((f) => Math.abs(f - e) <= tol)).length;
      const correct = found.filter((f) => c.expectCuts.some((e) => Math.abs(f - e) <= tol)).length;
      const recall = c.expectCuts.length ? hit / c.expectCuts.length : 1;
      const precision = found.length ? correct / found.length : 1;
      out.push({
        id: c.id,
        pass: recall >= 0.85 && precision >= 0.85,
        metrics: { recall: Number(recall.toFixed(2)), precision: Number(precision.toFixed(2)), found: found.length, expected: c.expectCuts.length },
        notes: recall < 1 || precision < 1 ? `found ${found.join(", ")}` : "",
      });
    }
    return out;
  },
};
