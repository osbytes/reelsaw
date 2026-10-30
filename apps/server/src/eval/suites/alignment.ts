/**
 * alignment: CTC forced alignment (wav2vec2) on real speech. Ground truth comes from the cut fixtures:
 * each has a cut that was verified clean by ear, so the deleted word must be aligned inside it, and
 * its neighbours outside it. Also checks monotonic, in-bounds spans for every word.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadAligner, ALIGN_SR, type Aligner } from "../../audio/align.js";
import type { CaseResult, Suite } from "../framework.js";

interface Case {
  range: { start: number; end: number };
  deleted: string[];
  words: Array<{ text: string; start: number; end: number }>;
  verifiedCut?: { start: number; end: number };
}

let aligner: Aligner | undefined;

export const alignmentSuite: Suite = {
  name: "alignment",
  description: "wav2vec2 forced alignment: deleted words land inside cuts verified clean by ear; spans ordered and in bounds",
  needs: [],
  async run(ctx) {
    const cfg = ctx.config();
    try {
      aligner ??= await loadAligner(cfg.ALIGN_MODEL_DIR);
    } catch (err) {
      return [{ id: "(model)", pass: false, skipped: `aligner unavailable: ${(err as Error).message.slice(0, 100)} (pnpm models:download)` }];
    }
    const dir = ctx.fixtures("cuts");
    const out: CaseResult[] = [];
    for (const name of (await fs.readdir(dir)).sort()) {
      const caseDir = path.join(dir, name);
      if (!(await fs.stat(caseDir)).isDirectory()) continue;
      const c = JSON.parse(await fs.readFile(path.join(caseDir, "case.json"), "utf8")) as Case;
      if (!c.verifiedCut) continue;
      const raw = await ctx.exec(cfg.FFMPEG_PATH, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        path.join(caseDir, "audio.wav"),
        "-ac",
        "1",
        "-ar",
        String(ALIGN_SR),
        "-f",
        "f32le",
        "pipe:1",
      ]);
      const pcm = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
      const dur = pcm.length / ALIGN_SR;
      const words = c.words.filter((w) => w.start >= -0.1 && w.end <= dur + 0.1);
      const t0 = Date.now();
      const spans = await aligner.align(
        pcm,
        words.map((w) => w.text),
      );
      const ms = Date.now() - t0;
      const di = words.findIndex((w) => w.start >= c.range.start - 0.02 && w.end <= c.range.end + 0.02);
      const d = spans[di];
      const tol = 0.04;
      const inside = !!d && d.start !== undefined && d.end !== undefined && d.start >= c.verifiedCut.start - tol && d.end <= c.verifiedCut.end + tol;
      const prev = spans[di - 1];
      const next = spans[di + 1];
      const neighboursOut = (prev?.end ?? 0) <= c.verifiedCut.start + tol && (next?.start ?? Infinity) >= c.verifiedCut.end - tol;
      const placed = spans.filter((s) => s.start !== undefined);
      const ordered = placed.every((s, i) => i === 0 || s.start! >= placed[i - 1]!.start!);
      const inBounds = placed.every((s) => s.start! >= 0 && s.end! <= dur + 0.05);
      out.push({
        id: name,
        pass: inside && neighboursOut && ordered && inBounds,
        metrics: { deletedStart: d?.start ?? -1, deletedEnd: d?.end ?? -1, ms, placed: placed.length, words: words.length },
        notes: !inside
          ? `"${c.deleted.join(" ")}" aligned ${d?.start}-${d?.end}, verified cut ${c.verifiedCut.start}-${c.verifiedCut.end}`
          : !neighboursOut
            ? "a neighbour overlaps the cut"
            : !ordered
              ? "spans out of order"
              : !inBounds
                ? "span outside audio"
                : "",
      });
    }
    return out;
  },
};
