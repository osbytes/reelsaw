/**
 * scenes: shot-cut detection (media.detectScenes → pickSceneCuts) against hand-verified cuts.
 * Precision and recall within a tolerance, over the graded part of each section.
 * `gradual` windows ([from, to] seconds: dissolves, wipes, graphic transitions) are not hard cuts: a detection
 * inside one (plus the tolerance) counts neither as a hit nor as a false positive, and is reported as `inGradual`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { materialize, MediaDriftError, type CaseResult, type MediaSource, type Suite } from "../framework.js";
import { parseSceneScores, pickSceneCuts } from "../../pipeline/scenes.js";

interface Spec {
  cases: Array<{ id: string; source: MediaSource; gradeUntil?: number; expectCuts: number[]; tolerance?: number; gradual?: Array<[number, number]> }>;
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
        out.push(
          err instanceof MediaDriftError
            ? { id: c.id, pass: false, notes: (err as Error).message }
            : { id: c.id, pass: false, skipped: (err as Error).message },
        );
        continue;
      }
      const until = c.gradeUntil ?? c.source.end - c.source.start;
      const raw = await ctx.exec(ctx.config().FFMPEG_PATH, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-t",
        String(until + 1),
        "-i",
        media,
        "-an",
        "-vf",
        "scale=320:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-",
        "-f",
        "null",
        "-",
      ]);
      const { times, scores } = parseSceneScores(raw.toString().split("\n"));
      const found = pickSceneCuts(times, scores).filter((t) => t <= until);
      const tol = c.tolerance ?? 0.25;
      const inGradual = (t: number) => (c.gradual ?? []).some(([a, b]) => t >= a - tol && t <= b + tol);
      const hard = found.filter((f) => !inGradual(f) || c.expectCuts.some((e) => Math.abs(f - e) <= tol));
      const hit = c.expectCuts.filter((e) => found.some((f) => Math.abs(f - e) <= tol)).length;
      const correct = hard.filter((f) => c.expectCuts.some((e) => Math.abs(f - e) <= tol)).length;
      const recall = c.expectCuts.length ? hit / c.expectCuts.length : 1;
      const precision = hard.length ? correct / hard.length : 1;
      const missed = c.expectCuts.filter((e) => !found.some((f) => Math.abs(f - e) <= tol));
      const extra = hard.filter((f) => !c.expectCuts.some((e) => Math.abs(f - e) <= tol));
      out.push({
        id: c.id,
        pass: recall >= 0.85 && precision >= 0.85,
        metrics: {
          recall: Number(recall.toFixed(2)),
          precision: Number(precision.toFixed(2)),
          found: hard.length,
          expected: c.expectCuts.length,
          inGradual: found.length - hard.length,
        },
        notes: missed.length || extra.length ? `missed ${missed.join(", ") || "-"}; extra ${extra.join(", ") || "-"}` : "",
      });
    }
    return out;
  },
};
