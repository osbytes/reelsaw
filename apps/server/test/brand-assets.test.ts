/**
 * The website copies the app's mark, tokens and logo path. Google Search ignores SVG favicons
 * and must not be served the SPA shell at /favicon.ico.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isSpaIndexPath } from "../src/spa-index.js";

const root = path.resolve(import.meta.dirname, "../../..");
const sha = (p: string) => createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");

function customProps(css: string, header: string): Record<string, string> {
  const i = css.indexOf(header);
  assert.notEqual(i, -1, `missing ${header}`);
  const start = css.indexOf("{", i);
  const end = css.indexOf("}", start);
  const out: Record<string, string> = {};
  for (const m of css.slice(start + 1, end).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function markPath(src: string): string {
  const m = src.match(/MARK_R =\s*"([^"]+)"/);
  assert.ok(m, "MARK_R path missing");
  return m[1]!;
}

describe("brand assets stay in sync with the website", () => {
  it("uses the same cut-monogram files", () => {
    const pairs: Array<[string, string]> = [
      ["apps/web/public/favicon.svg", "website/app/icon.svg"],
      ["apps/web/public/apple-touch-icon.png", "website/app/apple-icon.png"],
      ["apps/web/public/icon-512.png", "website/public/icon-512.png"],
      ["apps/web/public/favicon.ico", "website/app/favicon.ico"],
    ];
    for (const [a, b] of pairs) {
      assert.equal(sha(path.join(root, a)), sha(path.join(root, b)), `${a} drifted from ${b}`);
    }
    assert.equal(markPath(read("apps/web/src/App.tsx")), markPath(read("website/components/logo.tsx")));
  });

  it("advertises a Google-usable raster icon, not only SVG or 16/32 PNGs", () => {
    const html = read("apps/web/index.html");
    assert.match(html, /rel="icon"[^>]+favicon\.svg[^>]+sizes="any"/);
    assert.match(html, /rel="icon"[^>]+apple-touch-icon\.png[^>]+sizes="180x180"/);
    assert.match(html, /rel="apple-touch-icon"[^>]+apple-touch-icon\.png/);
    assert.match(html, /rel="manifest"[^>]+manifest\.webmanifest/);
    assert.match(html, /name="theme-color"[^>]+#8460d2/);
    assert.match(html, /name="description"/);
    assert.doesNotMatch(html, /favicon-16x16|favicon-32x32/);
    const ico = fs.readFileSync(path.join(root, "apps/web/public/favicon.ico"));
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1, "ICO type");
    assert.ok(ico.readUInt16LE(4) >= 1, "at least one image");
  });

  it("keeps the copied design tokens the same", () => {
    const app = read("apps/web/src/index.css");
    const site = read("website/app/globals.css");
    for (const header of [":root {", '[data-theme="dark"] {']) {
      assert.deepEqual(customProps(app, header), customProps(site, header), header);
    }
  });
});

describe("isSpaIndexPath", () => {
  it("serves the shell for client routes and 404s missing files", () => {
    assert.equal(isSpaIndexPath("/"), true);
    assert.equal(isSpaIndexPath("/signup"), true);
    assert.equal(isSpaIndexPath("/p/abc"), true);
    assert.equal(isSpaIndexPath("/favicon.ico"), false);
    assert.equal(isSpaIndexPath("/robots.txt"), false);
    assert.equal(isSpaIndexPath("/manifest.webmanifest"), false);
    assert.equal(isSpaIndexPath("/api/health"), false);
    assert.equal(isSpaIndexPath("/media/source/x"), false);
  });
});
