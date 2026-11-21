import { test } from "node:test";
import assert from "node:assert/strict";
import { planPauseTrim, VAD_SR, type SpeechSegment } from "../src/audio/vad.ts";

/** PCM built from spans: speech is a loud tone, a gap is either near-silent room tone or loud "game sound" noise. */
function pcmOf(spans: Array<{ sec: number; kind: "speech" | "quiet" | "sound" }>) {
  const total = spans.reduce((n, s) => n + s.sec, 0);
  const pcm = new Float32Array(Math.round(total * VAD_SR));
  const segments: SpeechSegment[] = [];
  let t = 0;
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
  for (const s of spans) {
    const a = Math.round(t * VAD_SR);
    const b = Math.round((t + s.sec) * VAD_SR);
    for (let i = a; i < b; i++)
      pcm[i] = s.kind === "speech" ? 0.3 * Math.sin((2 * Math.PI * 220 * i) / VAD_SR) : s.kind === "sound" ? 0.2 * noise() : 0.002 * noise();
    if (s.kind === "speech") segments.push({ start: t, end: t + s.sec });
    t += s.sec;
  }
  return { pcm, segments, duration: total };
}

const cutSec = (cuts: Array<{ start: number; end: number }>) => cuts.reduce((n, c) => n + c.end - c.start, 0);

test("a talking clip's quiet pauses are trimmed to the target", () => {
  const { pcm, segments, duration } = pcmOf([
    { sec: 5, kind: "speech" },
    { sec: 1.6, kind: "quiet" },
    { sec: 6, kind: "speech" },
    { sec: 1.2, kind: "quiet" },
    { sec: 6, kind: "speech" },
  ]);
  const r = planPauseTrim(segments, pcm, duration, { maxPause: 0.6 });
  assert.equal(r.cuts.length, 2);
  assert.equal(r.keptSound, 0);
  assert.equal(r.skipped, undefined);
  assert.ok(Math.abs(cutSec(r.cuts) - (1.0 + 0.6)) < 0.01);
});

test("gaps without speech that are loud (game sound, music) are content, not pauses", () => {
  const { pcm, segments, duration } = pcmOf([
    { sec: 5, kind: "speech" },
    { sec: 4, kind: "sound" },
    { sec: 6, kind: "speech" },
    { sec: 1.6, kind: "quiet" },
    { sec: 6, kind: "speech" },
  ]);
  const r = planPauseTrim(segments, pcm, duration, { maxPause: 0.6 });
  assert.equal(r.keptSound, 1);
  assert.equal(r.cuts.length, 1, "only the quiet pause is cut");
  assert.ok(r.cuts[0]!.start > 15, "the cut is in the quiet gap, not the game sound");
});

test("a clip that is mostly sound without speech keeps every pause (gameplay must not shrink to a few seconds)", () => {
  // gameplay: a few lines over long stretches of play, quiet enough between bursts to read as silence
  const { pcm, segments, duration } = pcmOf([
    { sec: 2, kind: "speech" },
    { sec: 9, kind: "quiet" },
    { sec: 2, kind: "speech" },
    { sec: 12, kind: "quiet" },
    { sec: 2, kind: "speech" },
    { sec: 9, kind: "quiet" },
  ]);
  const r = planPauseTrim(segments, pcm, duration, { maxPause: 0.6 });
  assert.deepEqual(r.cuts, []);
  assert.equal(r.skipped, "mostly-sound");
  assert.ok((r.wouldRemoveSec ?? 0) > 25);
});

test("nothing to trim, nothing reported", () => {
  const { pcm, segments, duration } = pcmOf([{ sec: 20, kind: "speech" }]);
  assert.deepEqual(planPauseTrim(segments, pcm, duration, { maxPause: 0.6 }), { cuts: [], keptSound: 0 });
});

test("speech level ignores the quiet between words, so game sound under the voice is not a pause", async () => {
  const { speechLevelDb } = await import("../src/audio/vad.ts");
  // a segment that is half loud syllables, half near-silence between words: the reference is the syllables
  const { pcm, duration } = pcmOf([
    { sec: 0.3, kind: "speech" },
    { sec: 0.3, kind: "quiet" },
    { sec: 0.3, kind: "speech" },
    { sec: 0.3, kind: "quiet" },
    { sec: 0.3, kind: "speech" },
    { sec: 0.3, kind: "quiet" },
  ]);
  const db = speechLevelDb([{ start: 0, end: duration }], pcm);
  // the 0.3 amplitude tone is about -13.5 dBFS RMS; a whole-segment average would sit 3 dB lower
  assert.ok(db > -15, `speech level ${db.toFixed(1)} dB`);
});
