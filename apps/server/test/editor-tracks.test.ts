/**
 * Editor tracks: per-pane adjustments, subject following and the overlay filtergraph.
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { coverTimeline, adjustDecision, subjectTrack, cleanAdjust, type FaceSample, type LayoutDecision } from "../src/pipeline/layout.js";
import { overlayChain, overlayInputArgs, textOverlayEvents, musicMix, layoutFilter, type LoadedOverlay, type LoadedMusic } from "../src/pipeline/render.js";
import { bumperProblem } from "../src/pipeline/bumpers.js";
import { buildAss, WATERMARK_LOGO, watermarkTextY } from "../src/pipeline/captions.js";
import { resolveStyle, isStickerAsset, assetLayerDefaultsFor, ASSET_OVERLAY_DEFAULT_W } from "@reelsaw/shared";

const face = (cx: number) => ({ x1: cx - 0.06, x2: cx + 0.06, y1: 0.2, y2: 0.45, score: 0.9 });
const twoFaces = (n = 40): FaceSample[] =>
  Array.from({ length: n }, (_, i) => {
    const boxes = [face(0.3), face(0.7)];
    return { t: i / 4, box: boxes[0]!, boxes };
  });
const track = (x: number, y = 0.4) => Array.from({ length: 10 }, (_, i) => ({ t: i, x, y }));
const decision = (layout: LayoutDecision["layout"]): LayoutDecision => ({
  layout,
  reason: "test",
  faceRatio: 1,
  faceSize: 0.25,
  track: track(0.3),
  ...(layout === "split" ? { track2: track(0.7), speakerSizes: [0.25, 0.25] as [number, number] } : {}),
  faceCount: 2,
});

describe("coverTimeline adjust", () => {
  it("keeps per-pane fields on the pieces", () => {
    const pieces = coverTimeline(10, [{ start: 2, end: 6, mode: "split", offsetX: 0.1, offsetY2: -0.05, subjectX2: 0.7 }], "auto");
    const mid = pieces.find((p) => p.start === 2)!;
    assert.deepEqual(mid.adjust, { offsetX: 0.1, offsetY2: -0.05, subjectX2: 0.7 });
  });

  it("merges neighbours only when the adjust is equal", () => {
    const same = coverTimeline(
      10,
      [
        { start: 0, end: 5, mode: "split", offsetX: 0.1 },
        { start: 5, end: 10, mode: "split", offsetX: 0.1 },
      ],
      "auto",
    );
    assert.equal(same.length, 1);
    const differ = coverTimeline(
      10,
      [
        { start: 0, end: 5, mode: "split", offsetX: 0.1 },
        { start: 5, end: 10, mode: "split", offsetX2: 0.1 },
      ],
      "auto",
    );
    assert.equal(differ.length, 2);
  });
});

describe("adjustDecision", () => {
  it("offsetX shifts only the top pane, offsetX2 only the bottom", () => {
    const top = adjustDecision(decision("split"), { offsetX: 0.1 }, [], [], 0).decision;
    assert.ok(Math.abs(top.track[0]!.x - 0.4) < 1e-9);
    assert.ok(Math.abs(top.track2![0]!.x - 0.7) < 1e-9);
    const bottom = adjustDecision(decision("split"), { offsetX2: -0.1 }, [], [], 0).decision;
    assert.ok(Math.abs(bottom.track[0]!.x - 0.3) < 1e-9);
    assert.ok(Math.abs(bottom.track2![0]!.x - 0.6) < 1e-9);
  });

  it("offsetY shifts y and everything clamps to [0, 1]", () => {
    const d = adjustDecision(decision("face"), { offsetY: 0.1, offsetX: 5 }, [], [], 0).decision;
    assert.ok(Math.abs(d.track[0]!.y - 0.5) < 1e-9);
    assert.equal(d.track[0]!.x, 1);
    const low = adjustDecision(decision("face"), { offsetY: -5 }, [], [], 0).decision;
    assert.equal(low.track[0]!.y, 0);
  });

  it("leaves fit and none decisions untouched", () => {
    for (const layout of ["fit", "none"] as const) {
      const d = decision(layout);
      assert.equal(adjustDecision(d, { offsetX: 0.2, subjectX: 0.7 }, twoFaces(), [], 0).decision, d);
    }
  });

  it("subjectX2 on a split replaces track2 and reports followed", () => {
    const r = adjustDecision(decision("split"), { subjectX2: 0.72 }, twoFaces(), [], 0);
    assert.equal(r.subject2, "followed");
    assert.equal(r.subject, undefined);
    assert.ok(r.decision.track2!.every((p) => Math.abs(p.x - 0.7) < 0.03));
    assert.deepEqual(r.decision.track, decision("split").track);
  });
});

describe("subjectTrack", () => {
  it("follows the face nearest subjectX", () => {
    const r = subjectTrack(twoFaces(), 0.72, [], 0);
    assert.equal(r.fixed, false);
    assert.ok(r.track.length > 1);
    assert.ok(
      r.track.every((p) => Math.abs(p.x - 0.7) < 0.03),
      JSON.stringify(r.track.slice(0, 3)),
    );
  });

  it("falls back to a fixed crop when no face is within reach", () => {
    const r = subjectTrack(twoFaces(), 0.95, [], 0);
    assert.equal(r.fixed, true);
    assert.equal(r.track.length, 1);
    assert.equal(r.track[0]!.x, 0.95);
  });
});

describe("overlayChain", () => {
  const item = (over: Partial<LoadedOverlay> = {}): LoadedOverlay => ({
    id: "a",
    assetId: "x",
    path: "/x.png",
    kind: "image",
    loop: false,
    start: 1,
    end: 4,
    x: 0.5,
    y: 0.5,
    w: 0.3,
    opacity: 1,
    ...over,
  });

  it("scales, composites and enables an image over its window", () => {
    const { chain, out } = overlayChain([item()], 1, 1080, 1920, "[in]");
    assert.ok(chain.includes("[1:v]scale=324:-2,format=rgba[ov0]"), chain);
    assert.ok(chain.includes("[in][ov0]overlay=x=540-w/2:y=960-h/2:eof_action=repeat:enable='between(t,1.000,4.000)'[oc0]"), chain);
    assert.equal(out, "[oc0]");
  });

  it("shifts a video to its start and passes through after its end", () => {
    const { chain } = overlayChain([item({ kind: "video" })], 1, 1080, 1920, "[in]");
    assert.ok(chain.includes("[1:v]setpts=PTS-STARTPTS+1.000/TB,scale=324:-2"), chain);
    assert.ok(chain.includes("eof_action=pass"), chain);
  });

  it("trims a looped item to its window and repeats its last frame", () => {
    const { chain } = overlayChain([item({ kind: "video", loop: true, start: 1, end: 4 })], 1, 1080, 1920, "[in]");
    assert.ok(chain.includes("[1:v]trim=duration=3.000,setpts=PTS-STARTPTS+1.000/TB,scale=324:-2,format=rgba[ov0]"), chain);
    assert.ok(chain.includes("eof_action=repeat"), chain);
    assert.ok(!chain.includes("eof_action=pass"), chain);
  });

  it("does not trim a video that plays once", () => {
    const { chain } = overlayChain([item({ kind: "video" })], 1, 1080, 1920, "[in]");
    assert.ok(!chain.includes("trim="), chain);
  });

  it("adds the opacity mix below 1", () => {
    const { chain } = overlayChain([item({ opacity: 0.5 })], 1, 1080, 1920, "[in]");
    assert.ok(chain.includes("colorchannelmixer=aa=0.500"), chain);
  });

  it("chains several items", () => {
    const { chain, out } = overlayChain([item(), item({ id: "b" })], 1, 1080, 1920, "[in]");
    assert.ok(chain.includes("[oc0][ov1]overlay"), chain);
    assert.ok(chain.includes("[2:v]"), chain);
    assert.equal(out, "[oc1]");
  });
});

describe("overlayInputArgs", () => {
  const base = { path: "/a.gif", start: 1, end: 4 } as const;

  it("reads a still or a video that plays once as a plain input", () => {
    assert.deepEqual(overlayInputArgs({ ...base, loop: false }), ["-i", "/a.gif"]);
  });

  it("makes a looped GIF honour its loop flag and bounds it to the window", () => {
    const args = overlayInputArgs({ ...base, loop: true, gif: true, durationSec: 1 });
    assert.deepEqual(args, ["-ignore_loop", "0", "-stream_loop", "3", "-t", "3.000", "-i", "/a.gif"]);
  });

  it("gives a looped video a finite stream_loop (never -1)", () => {
    const args = overlayInputArgs({ path: "/v.mp4", start: 0, end: 10, loop: true, durationSec: 3 });
    assert.deepEqual(args, ["-stream_loop", "4", "-t", "10.000", "-i", "/v.mp4"]);
    assert.ok(!args.includes("-1"));
    assert.ok(!args.includes("-ignore_loop"));
  });

  it("stays finite when the asset length is unknown", () => {
    const args = overlayInputArgs({ path: "/v.mp4", start: 0, end: 2, loop: true });
    assert.equal(args[args.indexOf("-stream_loop") + 1], "0");
    assert.ok(args.includes("-t"));
  });
});

describe("music under the clip", () => {
  const m = (over: Partial<LoadedMusic> = {}): LoadedMusic => ({
    id: "t1",
    assetId: "a",
    path: "/m.mp3",
    start: 2,
    end: 12,
    offset: 0,
    volume: 0.25,
    duck: true,
    fade: 0.5,
    loop: true,
    ...over,
  });

  it("trims, fades, levels, delays and ducks the track under the speech, then mixes without a level drop", () => {
    const g = musicMix([m()], 3, "[ca]", 30);
    assert.ok(g.includes("[3:a]atrim=start=0.000:end=10.000,asetpts=PTS-STARTPTS"), g);
    assert.ok(g.includes("loudnorm=I=-20:TP=-2:LRA=11,afade=t=in:st=0:d=0.500,afade=t=out:st=9.500:d=0.500"), g);
    assert.ok(g.includes("volume=0.250,adelay=2000|2000,apad=whole_dur=30.000,atrim=end=30.000[mu0]"), g);
    assert.ok(g.includes("[ca]aformat=sample_rates=48000:channel_layouts=stereo:sample_fmts=fltp,asplit=2[speech][key]"), g);
    assert.ok(g.includes("[mu0]anull[musicd];[musicd][key]sidechaincompress="), g);
    assert.ok(g.endsWith("[speech][ducked]amix=inputs=2:duration=first:normalize=0[mixed]"), g);
  });

  it("skips the compressor when ducking is off and keeps the fade inside a short window", () => {
    const g = musicMix([m({ duck: false, start: 0, end: 0.6, offset: 4 })], 1, "[ca]", 5);
    assert.ok(!g.includes("sidechaincompress"), g);
    assert.ok(g.includes("atrim=start=4.000:end=4.600"), g);
    assert.ok(g.includes("afade=t=in:st=0:d=0.300,afade=t=out:st=0.300:d=0.300"), g);
    assert.ok(g.endsWith("[speech][musicp]amix=inputs=2:duration=first:normalize=0[mixed]"), g);
  });

  it("sums several tracks per group, ducked and plain, and mixes both with the speech", () => {
    const g = musicMix([m(), m({ id: "t2", start: 5, end: 9 }), m({ id: "t3", duck: false })], 2, "[ca]", 30);
    assert.ok(g.includes("[2:a]") && g.includes("[3:a]") && g.includes("[4:a]"), g);
    assert.ok(g.includes("[mu0][mu1]amix=inputs=2:duration=longest:normalize=0[musicd]"), g);
    assert.ok(g.includes("[mu2]anull[musicp]"), g);
    assert.ok(g.endsWith("[speech][ducked][musicp]amix=inputs=3:duration=first:normalize=0[mixed]"), g);
  });

  it("refuses an audio file as an intro and accepts it as music", () => {
    assert.match(bumperProblem("intro", { ext: ".mp3", sizeBytes: 1000 }, { durationSec: 30, hasAudio: true }) ?? "", /music under a clip/);
    assert.equal(bumperProblem(undefined, { ext: ".mp3", sizeBytes: 1000 }, { durationSec: 30, hasAudio: true }), null);
    assert.match(bumperProblem(undefined, { ext: ".wav", sizeBytes: 1000 }, { durationSec: 20 * 60, hasAudio: true }) ?? "", /at most 15 min/);
  });
});

describe("text overlays", () => {
  const style = resolveStyle({});
  it("maps windows from source seconds to the body's clock and skips asset rows", () => {
    const mapTime = (t: number) => t - (t > 5 ? 2 : 0); // a 2 s cut at 3–5
    const events = textOverlayEvents(
      [
        { id: "t", kind: "text", text: "Hi", start: 101, end: 108, x: 0.5, y: 0.3 },
        { id: "a", assetId: "x", start: 101, end: 108, x: 0.5, y: 0.5, w: 0.3 },
        { id: "gone", kind: "text", text: "late", start: 130, end: 140, x: 0.5, y: 0.5 },
      ],
      100,
      20,
      mapTime,
    );
    assert.equal(events.length, 1);
    assert.deepEqual(events[0], { text: "Hi", start: 1, end: 6, x: 0.5, y: 0.3, size: 0.045, color: "#FFFFFF", box: false, opacity: 1 });
  });

  it("writes a layer-1 event with the size, colour and alpha of the text", () => {
    const ass = buildAss([], {
      width: 1080,
      height: 1920,
      font: "DejaVu Sans",
      style,
      texts: [{ text: "Hello {there}", start: 1, end: 4, x: 0.25, y: 0.5, size: 0.05, color: "#FFD84D", box: true, opacity: 0.5 }],
    });
    const line = ass.split("\n").find((l) => l.startsWith("Dialogue: 1,"));
    assert.ok(line, ass);
    assert.ok(line!.includes(",TextBox,"), line);
    assert.ok(line!.includes("{\\an5\\pos(270,960)}{\\fs96\\c&H4DD8FF&\\alpha&H80&}Hello there"), line);
    assert.ok(ass.includes("Style: Text,") && ass.includes("Style: TextBox,"), ass);
  });

  it("puts the watermark text under the logo, smaller, when the logo is composited", () => {
    const under = buildAss([], { width: 1080, height: 1920, font: "DejaVu Sans", style, watermark: "reelsaw.com", watermarkUnderLogo: true });
    const alone = buildAss([], { width: 1080, height: 1920, font: "DejaVu Sans", style, watermark: "reelsaw.com" });
    const line = (s: string) => s.split("\n").find((l) => l.startsWith("Dialogue: 2,"))!;
    assert.ok(
      line(under).includes(
        `\\pos(${Math.round(WATERMARK_LOGO.x * 1080)},${Math.round(watermarkTextY() * 1920)})}{\\fs${Math.round(1920 * WATERMARK_LOGO.textSize)}}reelsaw.com`,
      ),
      line(under),
    );
    // the text starts just under the logo's bottom edge
    const logoBottom = WATERMARK_LOGO.y + (WATERMARK_LOGO.w * (9 / 16)) / WATERMARK_LOGO.aspect / 2;
    assert.ok(watermarkTextY() - WATERMARK_LOGO.textSize / 2 > logoBottom && watermarkTextY() - WATERMARK_LOGO.textSize / 2 - logoBottom < 0.01);
    assert.ok(line(alone).includes("\\pos(540,1747)}reelsaw.com"), line(alone));
  });
});

describe("assetLayerDefaultsFor", () => {
  it("treats a silent short video (Giphy GIF-as-mp4) as a looping sticker, not full-frame b-roll", () => {
    assert.equal(isStickerAsset({ kind: "video", mime: "video/mp4", hasAudio: false, durationSec: 1.4 }), true);
    const d = assetLayerDefaultsFor({ kind: "video", mime: "video/mp4", hasAudio: false, durationSec: 1.4 });
    assert.equal(d.w, ASSET_OVERLAY_DEFAULT_W);
    assert.equal(d.y, 0.18);
    assert.equal(d.loop, true);
    assert.equal(d.windowSec, 4);
  });
  it("treats a short video with a dummy audio track (Giphy mp4) as a sticker, and a longer clip as b-roll", () => {
    assert.equal(isStickerAsset({ kind: "video", hasAudio: true, durationSec: 2 }), true);
    assert.equal(isStickerAsset({ kind: "video", hasAudio: false, durationSec: 12 }), false);
    const d = assetLayerDefaultsFor({ kind: "video", hasAudio: true, durationSec: 8 });
    assert.equal(d.w, 1);
    assert.equal(d.y, 0.5);
    assert.equal(d.loop, undefined);
  });
  it("treats stills and GIF stickers as overlays", () => {
    assert.equal(isStickerAsset({ kind: "image", mime: "image/png" }), true);
    assert.equal(isStickerAsset({ kind: "image", mime: "image/gif" }), true);
    assert.equal(assetLayerDefaultsFor({ kind: "image", mime: "image/gif" }).loop, true);
    assert.equal(assetLayerDefaultsFor({ kind: "image", mime: "image/png" }).loop, undefined);
  });
});

describe("fixed crops", () => {
  const crop = { x1: 0.1, y1: 0.2, x2: 0.6, y2: 0.9 };
  it("cleanAdjust keeps crops and drops empty ones", () => {
    assert.deepEqual(cleanAdjust({ crop, offsetX: 0 }), { crop });
    assert.equal(cleanAdjust({ crop: { x1: 0.5, y1: 0.5, x2: 0.5, y2: 0.6 } }), undefined);
    assert.deepEqual(coverTimeline(10, [{ start: 0, end: 10, mode: "auto", contentCrop: crop }], "auto")[0]!.adjust, { contentCrop: crop });
  });
  it("a crop makes the subject and offset moot and drops the webcam tile", () => {
    const d: LayoutDecision = { ...decision("stack"), tile: { x1: 0.8, y1: 0, x2: 1, y2: 0.2 } };
    const r = adjustDecision(d, { crop, offsetX: 0.2, subjectX: 0.7 }, twoFaces(), [], 0);
    assert.equal(r.decision.tile, undefined);
    assert.equal(r.subject, undefined);
    assert.deepEqual(r.decision.track, d.track);
    assert.match(r.decision.reason, /fixed crop/);
  });
  it("a top crop replaces a stack's content region; a fitted frame takes only the crop", () => {
    const r = adjustDecision(decision("stack"), { contentCrop: crop }, twoFaces(), [], 0);
    assert.deepEqual(r.decision.content, crop);
    const f = adjustDecision(decision("fit"), { crop, offsetX: 0.3 }, twoFaces(), [], 0);
    assert.deepEqual(f.decision.track, decision("fit").track);
    assert.match(f.decision.reason, /fixed crop/);
  });
  it("layoutFilter shows a fixed crop at its own shape over a blurred copy", () => {
    const px = `crop=960:756:192:216`; // 1920x1080 × (0.5, 0.7) at (0.1, 0.2)
    const whole = layoutFilter("face", 1920, 1080, track(0.3), [], { crop }).chain;
    assert.ok(whole.startsWith(`[0:v]${px},split=2[tbg][tfg];`), whole);
    assert.ok(whole.endsWith("overlay=(W-w)/2:(H-h)/2,setsar=1"), whole);
    assert.ok(layoutFilter("fit", 1920, 1080, [], [], { crop }).chain.includes(px));
    const split = layoutFilter("split", 1920, 1080, track(0.3), track(0.7), { crop2: crop }).chain;
    assert.ok(split.includes(`[b]${px},split=2[tbbg][tbfg];`) && split.includes("[a]crop=") && split.includes("[as][bs]vstack"), split);
    const stack = layoutFilter("stack", 1920, 1080, track(0.3), [], { crop, tile: { x1: 0.8, y1: 0, x2: 1, y2: 0.2 } }).chain;
    assert.ok(stack.includes(`[bot]${px},split=2`) && !stack.includes("crop=384:216"), stack);
    // no crop: the face-sized window as before
    assert.ok(!layoutFilter("face", 1920, 1080, track(0.3), [], {}).chain.includes("split=2"));
  });
  it("a stack on a portrait source keeps a speaker pane (scale height never 0)", () => {
    const chain = layoutFilter("stack", 1080, 1920, track(0.5)).chain;
    assert.ok(!chain.includes("scale=1080:0"), chain);
    assert.ok(chain.includes("scale=1080:1918") && chain.includes("scale=1080:2"), chain);
  });
});
