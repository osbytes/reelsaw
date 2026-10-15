/**
 * Offline regression eval for disfluency jump cuts.
 *
 *   docker compose exec app node /app/server/dist/eval/cuts.js /data/fixtures   (uses the stack's align model)
 *   pnpm --filter @reelsaw/server eval:cuts [fixtureDir=eval/cuts]              (dev, models reachable from the host)
 *
 * Each fixture (exported with `reelsaw cuts <clipId> --fixture <dir>`) is ~6 s of real audio,
 * the as-heard words and the span to delete. For each case we run the production cut search
 * (`refineCuts`), apply the chosen cut with the same 20 ms crossfade, transcribe the result with the
 * align model and grade it independently of the search's own verifier:
 *   clean   – deleted word(s) gone and the neighbours heard back to back
 *   kept    – search refused to cut (safe, but the disfluency stays in the audio)
 *   broken  – something was cut but the result is wrong (word left over or neighbour damaged)
 * Prints a table plus transcription-call counts and timings, so changes to the search can be
 * compared quickly without a database, a render or a deploy.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { transcribe } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { loadConfig } from "../config.js";
import { createLogger } from "../log.js";
import { createAi } from "../ai/registry.js";
import { toWords } from "../pipeline/transcript.js";
import { refineCuts } from "../pipeline/audiocuts.js";
import type { Word } from "@reelsaw/shared";

interface Case {
  range: { start: number; end: number };
  deleted: string[];
  words: Word[];
  note?: string;
}

const config = loadConfig({ ...process.env, REELSAW_CLI: "1" });
const ai = createAi(config, createLogger({ LOG_LEVEL: config.LOG_LEVEL, LOG_FORMAT: config.LOG_FORMAT }, { role: "eval" }));
const modelId = config.TRANSCRIPT_ALIGN_MODEL ?? config.TRANSCRIPTION_MODEL;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9']+/g, "");

function ff(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const out: Buffer[] = [];
    const p = spawn(config.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", ...args]);
    p.stdout.on("data", (d: Buffer) => out.push(d));
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}`))));
    p.on("error", reject);
  });
}

async function hear(audio: Buffer) {
  const model = await ai.transcriptionModel(modelId);
  const res = await transcribe({ model, audio, providerOptions: ai.transcriptionOptions(modelId) as Record<string, JSONObject> });
  return toWords(res.segments.map((s) => ({ text: s.text, startSecond: s.startSecond, endSecond: s.endSecond })));
}

async function main() {
  const root = path.resolve(process.argv[2] ?? "eval/cuts");
  const dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
  if (!dirs.length) return console.log(`no fixtures in ${root}; export some with: reelsaw cuts <clipId> --fixture <dir>`);
  console.log(`cut eval: ${dirs.length} case(s), align model ${modelId}\n`);
  const rows: string[][] = [];
  const tally = { clean: 0, kept: 0, broken: 0 };
  for (const dir of dirs) {
    const c = JSON.parse(await fs.readFile(path.join(dir, "case.json"), "utf8")) as Case;
    const wav = path.join(dir, "audio.wav");
    const dur = (c.words.at(-1)?.end ?? c.range.end) + 0.5;
    let calls = 0;
    const t0 = Date.now();
    const res = await refineCuts(
      { ffmpegPath: config.FFMPEG_PATH, transcribe: async (a) => (calls++, hear(a)) },
      wav,
      0,
      dur,
      [c.range],
      c.words,
    );
    const ms = Date.now() - t0;
    const cut = res.cuts[0];
    const prev = c.words.filter((w) => w.end <= c.range.start + 0.02).at(-1);
    const next = c.words.find((w) => w.start >= c.range.end - 0.02);
    let verdict: keyof typeof tally = "kept";
    let heardText = "";
    if (cut) {
      const out = await ff([
        "-i", wav, "-filter_complex",
        `[0:a]atrim=end=${(cut.start + 0.02).toFixed(3)},asetpts=PTS-STARTPTS[a];[0:a]atrim=start=${cut.end.toFixed(3)},asetpts=PTS-STARTPTS[b];[a][b]acrossfade=d=0.02[o]`,
        "-map", "[o]", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1",
      ]);
      const heard = (await hear(out)).map((w) => norm(w.text));
      heardText = heard.join(" ");
      const pi = prev ? heard.indexOf(norm(prev.text)) : -1;
      const adjacent = !prev || !next || (pi >= 0 && heard[pi + 1] === norm(next.text));
      const gone = c.deleted.every((d) => !heard.includes(norm(d)) || norm(d) === norm(prev?.text ?? "") || norm(d) === norm(next?.text ?? ""));
      verdict = adjacent && gone ? "clean" : "broken";
    }
    tally[verdict]++;
    rows.push([path.basename(dir), c.deleted.join(" "), verdict, cut ? `${cut.start.toFixed(3)}-${cut.end.toFixed(3)}` : "-", String(calls), `${(ms / 1000).toFixed(1)}s`, heardText || (res.skipped[0]?.reason.slice(0, 80) ?? "")]);
  }
  const head = ["case", "deleted", "result", "cut", "asr calls", "time", "heard after cut / reason"];
  const w = head.map((h, i) => Math.min(70, Math.max(h.length, ...rows.map((r) => r[i]!.length))));
  console.log(head.map((h, i) => h.padEnd(w[i]!)).join("  "));
  for (const r of rows) console.log(r.map((x, i) => x.slice(0, 70).padEnd(w[i]!)).join("  "));
  console.log(`\nclean ${tally.clean} · kept ${tally.kept} · broken ${tally.broken}`);
  if (tally.broken) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
