/**
 * Caption fonts: the clip → project → instance chain with its fallback, the upload checks, and the watermark keeping
 * the instance font whatever the clip picked.
 * Run: pnpm --filter @reelsaw/server test
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultStyle, fontFamilySchema, resolveStyle, styleSchema } from "@reelsaw/shared";
import { FALLBACK_FONT, fontFileProblem, pickFont } from "../src/fonts.js";
import { buildAss } from "../src/pipeline/captions.js";
import { envSchema } from "../src/config.js";

const available = new Map(["DejaVu Sans", "Roboto", "Brand Grotesk"].map((f) => [f.toLowerCase(), f]));

describe("caption fonts", () => {
  it("takes the first available font down the chain, as installed", () => {
    assert.equal(pickFont(available, "brand grotesk", "Roboto"), "Brand Grotesk");
    assert.equal(pickFont(available, null, "Roboto"), "Roboto");
    // a removed upload (or a typo through the API) falls to the next one, never to whatever fontconfig substitutes
    assert.equal(pickFont(available, "Gone Font", "Roboto"), "Roboto");
    assert.equal(pickFont(available, "Gone Font", "Also Gone"), FALLBACK_FONT);
  });

  it("keeps booting on a CAPTION_FONT written as a fontconfig list, taking its first family", () => {
    const font = envSchema.shape.CAPTION_FONT;
    assert.equal(font.parse("Inter, DejaVu Sans"), "Inter");
    assert.equal(font.parse(undefined), "DejaVu Sans");
    assert.equal(font.parse("Noto Sans CJK JP"), "Noto Sans CJK JP");
  });

  it("refuses names that would break an ASS line", () => {
    assert.equal(fontFamilySchema.safeParse("Brand Grotesk").success, true);
    for (const bad of ["A,B", "A\\B", "A{B}", "A\nB", ""]) assert.equal(fontFamilySchema.safeParse(bad).success, false, bad);
  });

  it("checks a font upload by extension and size before reading it", () => {
    assert.equal(fontFileProblem("brand.woff2", 1000), null);
    assert.match(fontFileProblem("brand.zip", 1000)!, /\.ttf/);
    assert.match(fontFileProblem("brand.ttf", 0)!, /empty/);
    assert.match(fontFileProblem("brand.otf", 200 * 1024 * 1024)!, /MB/);
  });

  it("resolves the font clip over project, and leaves it unset for the instance default", () => {
    assert.equal(resolveStyle({ font: "Roboto" }, { font: "Brand Grotesk" }).font, "Brand Grotesk");
    assert.equal(resolveStyle({ font: "Roboto" }, {}).font, "Roboto");
    assert.equal(resolveStyle({}, null).font, undefined);
    assert.equal(styleSchema.parse({}).font, undefined);
  });

  it("draws captions in the clip's font and the watermark in the instance's", () => {
    const ass = buildAss([{ text: "hi", start: 0, end: 1 }], {
      width: 1080,
      height: 1920,
      font: "Brand Grotesk",
      watermarkFont: "DejaVu Sans",
      style: defaultStyle,
      watermark: "example.com",
    });
    assert.match(ass, /^Style: Caption,Brand Grotesk,/m);
    assert.match(ass, /^Style: Hook,Brand Grotesk,/m);
    assert.match(ass, /^Style: Watermark,DejaVu Sans,/m);
  });
});

describe("watermark without text", () => {
  it("writes no watermark line when the text is empty (the logo, if any, is composited by render.ts)", () => {
    const ass = buildAss([{ text: "hi", start: 0, end: 1 }], { width: 1080, height: 1920, font: "DejaVu Sans", style: defaultStyle, watermark: "" });
    assert.doesNotMatch(ass, /^Dialogue: 2,.*Watermark/m);
  });
});
