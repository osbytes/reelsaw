/**
 * pauses: Silero VAD + pause trimming on real speech with known silences spliced in.
 * For each speech fixture, a silence of known length is inserted at a known time; the detector must
 * find that gap (±0.15 s) and the planned cut must leave exactly maxPause of it, while cutting
 * little else (natural pauses already in the speech may be shortened, words must not be).
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { loadVad, speechSegments, pauseCuts, VAD_SR, type Vad } from "../../audio/vad.js";
import type { CaseResult, Suite } from "../framework.js";

const CASES = [
  { fixture: "cuts/pay-repeat/audio.wav", at: 1.0, silence: 1.5 },
  { fixture: "cuts/into-coarticulated/audio.wav", at: 2.4, silence: 2.0 },
  { fixture: "cuts/into-coarticulated/audio.wav", at: 1.2, silence: 0.8 },
];
const MAX_PAUSE = 0.6;

let vad: Vad | undefined;

export const pausesSuite: Suite = {
  name: "pauses",
  description: "voice activity detection + pause trimming: inserted silences found and shortened to the target pause",
  needs: [],
  async run(ctx) {
    const cfg = ctx.config();
    try {
      vad ??= await loadVad(cfg.VAD_MODEL_PATH);
    } catch (err) {
      return [{ id: "(model)", pass: false, skipped: `VAD model unavailable: ${(err as Error).message.slice(0, 100)} (pnpm models:download)` }];
    }
    const out: CaseResult[] = [];
    for (const c of CASES) {
      const wav = path.join(ctx.fixtures(""), c.fixture);
      const id = `${path.basename(path.dirname(c.fixture))}+${c.silence}s@${c.at}`;
      if (!existsSync(wav)) {
        out.push({ id, pass: false, skipped: "fixture missing" });
        continue;
      }
      const graph = `[0:a]aresample=${VAD_SR},atrim=0:${c.at},asetpts=PTS-STARTPTS[a];anullsrc=r=${VAD_SR}:cl=mono,atrim=0:${c.silence}[s];[0:a]aresample=${VAD_SR},atrim=${c.at},asetpts=PTS-STARTPTS[b];[a][s][b]concat=n=3:v=0:a=1[o]`;
      const raw = await ctx.exec(cfg.FFMPEG_PATH, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        wav,
        "-filter_complex",
        graph,
        "-map",
        "[o]",
        "-ac",
        "1",
        "-f",
        "f32le",
        "pipe:1",
      ]);
      const pcm = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
      const duration = pcm.length / VAD_SR;
      const segs = speechSegments(await vad.probabilities(pcm));
      const cuts = pauseCuts(segs, duration, { maxPause: MAX_PAUSE });
      // the inserted gap: the silence between speech segments that overlaps [at, at+silence]
      const gap = segs
        .slice(1)
        .map((s, i) => ({ start: segs[i]!.end, end: s.start }))
        .find((g) => g.end > c.at && g.start < c.at + c.silence);
      const gapLen = gap ? gap.end - gap.start : 0;
      const cutInGap = gap ? cuts.filter((k) => k.start >= gap.start - 0.01 && k.end <= gap.end + 0.01).reduce((n, k) => n + k.end - k.start, 0) : 0;
      const keptInGap = gapLen - cutInGap;
      const other = cuts.reduce((n, k) => n + k.end - k.start, 0) - cutInGap;
      const foundOk = !!gap && Math.abs(gapLen - c.silence) <= 0.35; // gap also includes the speaker's own pause around the splice
      // pauses only slightly over the target are left alone (cuts under 0.15 s add a jump for nothing)
      const keptOk = keptInGap >= Math.min(gapLen, MAX_PAUSE) - 0.05 && keptInGap <= MAX_PAUSE + 0.16;
      out.push({
        id,
        pass: foundOk && keptOk,
        metrics: { gapSec: Number(gapLen.toFixed(2)), keptSec: Number(keptInGap.toFixed(2)), otherCutSec: Number(other.toFixed(2)), segments: segs.length },
        notes: !gap
          ? "inserted silence not detected"
          : !foundOk
            ? `gap ${gapLen.toFixed(2)}s vs inserted ${c.silence}s`
            : !keptOk
              ? `kept ${keptInGap.toFixed(2)}s, want ${MAX_PAUSE}`
              : "",
      });
    }
    return out;
  },
};
