/**
 * Preview-sized link sources (a plan's `sourceHeight`): the download format for each size, which projects render
 * from full-quality windows, which candidates may serve a window, and placing a window on the source clock by
 * its sound (the file's first frame is near the requested start, not on it).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_WINDOW_SEC, SEAM_SEC, measureOffset, planWindow, rendersFromSections, stitchArgs, stitchPlan, uncovered } from "../src/pipeline/sections.js";
import { sourceFormat } from "../src/pipeline/ingest.js";
import { ffmpegCanUse } from "../src/ytdlp-proxy.js";
import { SCENARIOS, assertLocal } from "../src/dev/scenarios.js";
import { PLANS, FREE } from "../src/ee/billing/plans.js";
import { grantsOf } from "../src/ee/billing/entitlements.js";

const SR = 16000;

/** Speech-like test signal: noise bursts of varying length and loudness, with gaps. Deterministic. */
function speechish(sec: number, seed = 1): Float32Array {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  const out = new Float32Array(Math.round(sec * SR));
  let i = 0;
  while (i < out.length) {
    const len = Math.round((0.08 + Math.abs(rnd()) * 0.4) * SR);
    const loud = Math.abs(rnd()) < 0.25 ? 0 : 0.1 + Math.abs(rnd()) * 0.6;
    for (let j = 0; j < len && i < out.length; j++, i++) out[i] = loud * rnd();
  }
  return out;
}

describe("source sections", () => {
  it("finds where the window's sound sits in the preview", () => {
    const ref = speechish(20);
    for (const lagSec of [0, 1.234, 5.5, 11.9]) {
      const at = Math.round(lagSec * SR);
      const probe = ref.slice(at, at + 8 * SR);
      const m = measureOffset(ref, probe, SR);
      assert.ok(m, `matched at ${lagSec}`);
      assert.ok(Math.abs(m.lagSec - at / SR) < 0.002, `lag ${m.lagSec} vs ${at / SR}`);
    }
  });

  it("still matches through a different encode (gain and noise)", () => {
    const ref = speechish(20, 7);
    const at = Math.round(3.21 * SR);
    let x = 3;
    const probe = ref.slice(at, at + 8 * SR).map((v) => 0.7 * v + 0.01 * (((x = (x * 69069 + 1) % 2 ** 32) / 2 ** 32) * 2 - 1));
    const m = measureOffset(ref, probe, SR);
    assert.ok(m);
    assert.ok(Math.abs(m.lagSec - 3.21) < 0.005, String(m.lagSec));
  });

  it("gives no answer for silence or unrelated sound, so the requested start is kept", () => {
    const ref = speechish(20, 2);
    assert.equal(measureOffset(ref, new Float32Array(8 * SR), SR), null);
    assert.equal(measureOffset(ref, speechish(8, 99), SR), null);
  });

  it("only link projects with a preview height render from windows", () => {
    assert.equal(rendersFromSections({ sourceType: "url", sourceUrl: "https://example.com/v", sourceMeta: { previewHeight: 240 } }), 240);
    assert.equal(rendersFromSections({ sourceType: "url", sourceUrl: "https://example.com/v", sourceMeta: {} }), null);
    assert.equal(rendersFromSections({ sourceType: "upload", sourceUrl: null, sourceMeta: { previewHeight: 240 } }), null);
  });

  it("caps the download at the plan's height; the full download is unchanged", () => {
    assert.equal(
      sourceFormat(1080),
      "bv*[vcodec^=avc1][height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b",
    );
    const small = sourceFormat(240, true);
    assert.match(small, /^bv\*\[vcodec\^=avc1\]\[height<=240\]/);
    assert.doesNotMatch(small, /height<=1080/);
    assert.match(small, /\/w$/, "a video with no small format still downloads its smallest");
  });

  it("Free downloads a preview; paid plans download the full source", () => {
    assert.equal(FREE.sourceHeight, 240);
    for (const p of PLANS.filter((x) => x.price)) assert.equal(p.sourceHeight, null, p.name);
    const free = grantsOf(null, 7, "https://app.example");
    assert.equal(free.sourceHeight, 240);
    assert.equal(free.upgrade?.sourceHeight, null, "the next plan lifts the cap, so the offer shows");
  });

  it("section downloads use only candidates ffmpeg can go through", () => {
    assert.equal(ffmpegCanUse({ id: "direct", url: null, priority: 0, concurrency: 0 }), true);
    assert.equal(ffmpegCanUse({ id: "di", url: "http://u:p@gw.example:823", priority: 0, concurrency: 0 }), true);
    assert.equal(ffmpegCanUse({ id: "pi", url: "socks5h://pi.lan:1080", priority: 0, concurrency: 0 }), false);
  });
});

describe("source windows: one download for nearby clips, only the missing stretch after an edit", () => {
  const total = 3600;

  it("a project's first render fetches one window over its overlapping and nearby clips", () => {
    // 60-100 and 90-130 overlap; 140-170 is 10 s past the padded end; 400-430 is far away
    const clips: Array<[number, number]> = [
      [60, 100],
      [90, 130],
      [140, 170],
      [400, 430],
    ];
    const p = planWindow({ clip: [90, 130], clips, windows: [], total });
    assert.deepEqual(p, { range: [57, 173], fetch: [[57, 173]], stitch: false });
  });

  it("never merges past the longest window, and never into a stored one", () => {
    const clips: Array<[number, number]> = Array.from({ length: 40 }, (_, i): [number, number] => [i * 30, i * 30 + 25]);
    const p = planWindow({ clip: [0, 25], clips, windows: [], total });
    assert.ok(p.range[1] - p.range[0] <= MAX_WINDOW_SEC);
    const q = planWindow({ clip: [300, 325], clips, windows: [[328.5, 400]], total });
    assert.equal(q.stitch, false);
    assert.ok(q.range[1] <= 328.5, `stops at the stored window: ${q.range}`);
  });

  it("a clip that pokes out of its window fetches only the missing stretch, with a seam into the stored part", () => {
    const p = planWindow({ clip: [60, 110], clips: [[60, 110]], windows: [[57, 103]], total });
    assert.equal(p.stitch, true);
    assert.deepEqual(p.range, [57, 113]);
    assert.deepEqual(p.fetch, [[103 - SEAM_SEC, 113 + SEAM_SEC]]);
  });

  it("two stored windows that together cover a clip are joined without any download", () => {
    const p = planWindow({
      clip: [100, 140],
      clips: [],
      windows: [
        [90, 125],
        [120, 160],
      ],
      total,
    });
    assert.equal(p.stitch, true);
    assert.deepEqual(p.fetch, []);
  });

  it("uncovered and stitchPlan walk the stretches", () => {
    assert.deepEqual(
      uncovered(
        [0, 100],
        [
          [10, 20],
          [15, 40],
          [60, 70],
        ],
      ),
      [
        [0, 10],
        [40, 60],
        [70, 100],
      ],
    );
    assert.deepEqual(uncovered([0, 10], [[-5, 50]]), []);
    const parts = [
      { id: "stored", start: 57, end: 103 },
      { id: "fresh", start: 100.98, end: 115.02 },
    ];
    const plan = stitchPlan([57, 113], parts);
    assert.deepEqual(
      plan?.map((s) => [s.source.id, s.a, s.b]),
      [
        ["stored", 57, 103],
        ["fresh", 103, 113],
      ],
    );
    assert.equal(stitchPlan([57, 120], [{ start: 57, end: 100 }]), null, "a gap is refused, not papered over");
  });

  it("each stitched stretch is read from its own file's clock", () => {
    const a = { file: "a.mp4", offsetSec: 57, width: 1920, height: 1080, fps: 30 };
    const b = { file: "b.mp4", offsetSec: 101.02, width: 1280, height: 720, fps: 0 };
    const { argv, width, height, fps } = stitchArgs(
      [
        { source: a, a: 57, b: 103 },
        { source: b, a: 103, b: 113 },
      ],
      "out.mp4",
    );
    assert.deepEqual([width, height, fps], [1920, 1080, 30]);
    assert.deepEqual(argv.slice(1, 7), ["-ss", "0.000", "-t", "46.000", "-i", "a.mp4"]);
    assert.deepEqual(argv.slice(7, 13), ["-ss", "1.980", "-t", "10.000", "-i", "b.mp4"]);
    assert.match(argv[argv.indexOf("-filter_complex") + 1]!, /concat=n=2:v=1:a=1/);
  });
});

describe("scenarios", () => {
  it("run only on a local instance", () => {
    for (const ok of ["http://localhost:3000", "http://127.0.0.1:3103", "http://app.localhost", "https://reelsaw.test"]) assertLocal(ok);
    for (const no of ["https://app.reelsaw.com", "http://10.0.0.5:3000", "https://localhost.example.com"])
      assert.throws(() => assertLocal(no), /local instance/);
  });

  it("each finished scenario has clips inside its video, and only preview ones claim a preview", () => {
    for (const [name, s] of Object.entries(SCENARIOS)) {
      for (const [a, b] of s.clips) assert.ok(a >= 0 && b <= s.durationSec && b > a, name);
      if (s.sourceGone) assert.ok(s.preview, `${name}: a vanished window only happens to a preview source`);
    }
  });
});
