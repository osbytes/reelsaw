/**
 * speakers: active speaker detection on real two-person footage with known talkers.
 * Agreement = fraction of the labelled time where the chosen speaker matches the truth (unlabelled
 * stretches, e.g. uncertain hand-overs, are not scored). A case with `expectUnsure` (more than two
 * people in the shot) passes only when the detector declines to answer (no runs).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadFaceDetector } from "../../vision/faces.js";
import { loadVad, VAD_SR } from "../../audio/vad.js";
import { activeSpeakers, speechAt, envelopeAt } from "../../pipeline/speaker.js";
import { materialize, MediaDriftError, type CaseResult, type MediaSource, type Suite } from "../framework.js";

interface Spec {
  cases: Array<{ id: string; source: MediaSource; segment: [number, number]; speakers: [number, number]; truth: Array<{ start: number; end: number; who: 0 | 1 }>; minAgreement: number; expectUnsure?: boolean }>;
}

export const speakersSuite: Suite = {
  name: "speakers",
  description: "active speaker detection (mouth motion × audio envelope synchrony) vs known talkers, incl. a drinking listener",
  needs: ["media"],
  async run(ctx) {
    const cfg = ctx.config();
    const spec = JSON.parse(await fs.readFile(path.join(ctx.fixtures("speakers"), "cases.json"), "utf8")) as Spec;
    let faces, vad;
    try {
      faces = await loadFaceDetector(cfg.FACE_MODEL_PATH);
      vad = await loadVad(cfg.VAD_MODEL_PATH);
    } catch (err) {
      return [{ id: "(models)", pass: false, skipped: `models unavailable: ${(err as Error).message.slice(0, 100)}` }];
    }
    const out: CaseResult[] = [];
    try {
      for (const c of spec.cases) {
        let media: string;
        try {
          media = await materialize(ctx, { ...c.source, strictSha: true }); // speaking turns are sub-second labels
        } catch (err) {
          out.push(err instanceof MediaDriftError ? { id: c.id, pass: false, notes: (err as Error).message } : { id: c.id, pass: false, skipped: (err as Error).message });
          continue;
        }
        const [s0, s1] = c.segment;
        const raw = await ctx.exec(cfg.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-ss", String(s0), "-t", String(s1 - s0), "-i", media, "-vn", "-ac", "1", "-ar", String(VAD_SR), "-f", "f32le", "pipe:1"]);
        const pcm = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
        const probs = await vad.probabilities(pcm);
        const t0 = Date.now();
        const tl = await activeSpeakers({ faces, ffmpegPath: cfg.FFMPEG_PATH }, media, s0, s1 - s0, c.speakers, speechAt(probs, 0), envelopeAt(pcm, 0));
        const ms = Date.now() - t0;
        // agreement over 0.1 s steps
        let agree = 0;
        let total = 0;
        for (let t = 0; t < s1 - s0; t += 0.1) {
          const truth = c.truth.find((r) => t >= r.start && t < r.end);
          if (!truth) continue;
          const got = tl.runs.find((r) => t >= r.start && t < r.end);
          total++;
          if (got?.who === truth.who) agree++;
        }
        const agreement = total ? agree / total : 0;
        const unsure = tl.runs.length === 0;
        out.push({
          id: c.id,
          pass: c.expectUnsure ? unsure : agreement >= c.minAgreement,
          metrics: { agreement: Number(agreement.toFixed(2)), confidence: tl.confidence, switches: Math.max(0, tl.runs.length - 1), unsure: unsure ? 1 : 0, ms },
          notes: unsure ? "unsure (no runs)" : tl.runs.map((r) => `${r.who === 0 ? "A" : "B"} ${r.start}-${r.end}`).join(", "),
        });
      }
    } finally {
      await faces.release();
      await vad.release();
    }
    return out;
  },
};
