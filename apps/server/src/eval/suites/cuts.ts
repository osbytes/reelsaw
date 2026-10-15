/**
 * cuts: real disfluency spans that were hard to cut (exported with `reelsaw cuts <clipId> --fixture`).
 * Each fixture is ~6 s of audio, the as-heard words and the span to delete. The production cut search
 * (`refineCuts`) runs on it, the chosen cut is applied with the same 20 ms crossfade, and the result
 * is transcribed and graded independently of the search's own verifier:
 *   clean  – deleted word(s) gone, neighbours heard back to back
 *   kept   – the search refused (safe; disfluency stays in the audio)
 *   broken – something was cut but a word is left over or a neighbour was damaged
 * A case passes when the verdict matches `expect` (default "clean"; "kept" is accepted for cases
 * labelled `"expect": "clean-or-kept"`). ASR calls are cached by audio hash.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Word } from "@reelsaw/shared";
import { refineCuts } from "../../pipeline/audiocuts.js";
import { isUnavailable, type CaseResult, type Suite } from "../framework.js";
import { transcribeCached } from "../asr.js";

interface Case {
  range: { start: number; end: number };
  deleted: string[];
  words: Word[];
  expect?: "clean" | "kept" | "clean-or-kept";
  note?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']+/g, "");

export const cutsSuite: Suite = {
  name: "cuts",
  description: "disfluency jump cuts on real audio: removed cleanly, refused safely, or broken",
  needs: ["models"],
  async run(ctx) {
    const cfg = ctx.config();
    const modelId = cfg.TRANSCRIPT_ALIGN_MODEL ?? cfg.TRANSCRIPTION_MODEL;
    const dir = ctx.fixtures("cuts");
    const out: CaseResult[] = [];
    for (const name of (await fs.readdir(dir)).sort()) {
      const caseDir = path.join(dir, name);
      if (!(await fs.stat(caseDir)).isDirectory()) continue;
      const c = JSON.parse(await fs.readFile(path.join(caseDir, "case.json"), "utf8")) as Case;
      const wav = path.join(caseDir, "audio.wav");
      const dur = (c.words.at(-1)?.end ?? c.range.end) + 0.5;
      let calls = 0;
      let uncached = 0;
      const t0 = Date.now();
      try {
        const hear = async (audio: Uint8Array) => {
          calls++;
          const t = Date.now();
          const r = await transcribeCached(ctx, modelId, audio);
          if (Date.now() - t > 200) uncached++;
          return r.words;
        };
        const res = await refineCuts({ ffmpegPath: cfg.FFMPEG_PATH, transcribe: hear, log: ctx.verbose ? ctx.log : undefined }, wav, 0, dur, [c.range], c.words);
        const cut = res.cuts[0];
        const prev = c.words.filter((w) => w.end <= c.range.start + 0.02).at(-1);
        const next = c.words.find((w) => w.start >= c.range.end - 0.02);
        let verdict: "clean" | "kept" | "broken" = "kept";
        let heardText = "";
        if (cut) {
          const audio = await ctx.exec(cfg.FFMPEG_PATH, [
            "-hide_banner", "-loglevel", "error", "-i", wav, "-filter_complex",
            `[0:a]atrim=end=${(cut.start + 0.02).toFixed(3)},asetpts=PTS-STARTPTS[a];[0:a]atrim=start=${cut.end.toFixed(3)},asetpts=PTS-STARTPTS[b];[a][b]acrossfade=d=0.02[o]`,
            "-map", "[o]", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1",
          ]);
          const heard = (await hear(new Uint8Array(audio))).map((w) => norm(w.text));
          heardText = heard.join(" ");
          const pi = prev ? heard.indexOf(norm(prev.text)) : -1;
          const adjacent = !prev || !next || (pi >= 0 && heard[pi + 1] === norm(next.text));
          const gone = c.deleted.every((d) => !heard.includes(norm(d)) || norm(d) === norm(prev?.text ?? "") || norm(d) === norm(next?.text ?? ""));
          verdict = adjacent && gone ? "clean" : "broken";
        }
        const expect = c.expect ?? "clean";
        const pass = expect === "clean-or-kept" ? verdict !== "broken" : verdict === expect;
        out.push({
          id: name,
          pass,
          metrics: { verdict, cut: cut ? `${cut.start.toFixed(3)}-${cut.end.toFixed(3)}` : "-", asrCalls: calls, newAsrCalls: uncached, sec: Number(((Date.now() - t0) / 1000).toFixed(1)) },
          notes: heardText || res.skipped[0]?.reason.slice(0, 160) || "",
        });
      } catch (err) {
        if (isUnavailable(err)) out.push({ id: name, pass: false, skipped: `model unavailable: ${(err as Error).message.slice(0, 120)}` });
        else out.push({ id: name, pass: false, notes: `error: ${(err as Error).message.slice(0, 160)}` });
      }
    }
    return out;
  },
  summarize(results) {
    const v = (k: string) => results.filter((r) => r.metrics?.verdict === k).length;
    return {
      clean: { value: v("clean"), better: "higher" },
      broken: { value: v("broken"), better: "lower" },
      asrCallsPerCase: { value: Number((results.reduce((a, r) => a + Number(r.metrics?.asrCalls ?? 0), 0) / (results.length || 1)).toFixed(1)), better: "lower", tolerance: 2 },
    };
  },
};
