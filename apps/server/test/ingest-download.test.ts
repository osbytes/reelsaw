import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ingestScratchMB, parseDownloadTick } from "../src/pipeline/ingest.js";
import { lineSplitter } from "../src/media.js";

describe("ingestScratchMB", () => {
  it("sizes an upload from its bytes instead of reserving 2 GB", () => {
    assert.equal(ingestScratchMB(80 * 1048576), 208);
    assert.equal(ingestScratchMB(2048 * 1048576), 2176);
    assert.equal(ingestScratchMB(1), 129);
  });
  it("reserves 2 GB when the size is unknown (a link)", () => {
    assert.equal(ingestScratchMB(), 2048);
    assert.equal(ingestScratchMB(null), 2048);
    assert.equal(ingestScratchMB(0), 2048);
  });
});

describe("parseDownloadTick", () => {
  it("reads a yt-dlp --newline progress line", () => {
    assert.deepEqual(parseDownloadTick("[download]  12.3% of ~ 1.57GiB at 5.00MiB/s ETA 04:00"), { fraction: 0.123, message: "Downloading 12% of 1.57GiB at 5.00MiB/s" });
    assert.deepEqual(parseDownloadTick("[download] 100.0% of  114.74KiB at    5.98MiB/s ETA 00:00"), { fraction: 1, message: "Downloading 100% of 114.74KiB at 5.98MiB/s" });
    assert.deepEqual(parseDownloadTick("[download]   0.0% of   10.00MiB at  Unknown B/s ETA Unknown"), { fraction: 0, message: "Downloading 0% of 10.00MiB" });
  });
  it("ignores everything else, including the --print-json line", () => {
    assert.equal(parseDownloadTick('{"id": "x", "title": "[download] 50%"}'), null);
    assert.equal(parseDownloadTick("[download] Destination: source.f137.mp4"), null);
    assert.equal(parseDownloadTick("[Merger] Merging formats into \"source.mp4\""), null);
    assert.equal(parseDownloadTick(""), null);
  });
});

describe("lineSplitter", () => {
  it("emits complete lines across chunks, split on \\n or \\r", () => {
    const seen: string[] = [];
    const feed = lineSplitter((l) => seen.push(l));
    feed("[download]  1.0%\n[download]  2.");
    feed("0%\r[download]  3.0%\r\n");
    feed("tail");
    assert.deepEqual(seen, ["[download]  1.0%", "[download]  2.0%", "[download]  3.0%"]);
  });
  it("is a no-op without a listener", () => {
    assert.doesNotThrow(() => lineSplitter(undefined)("x\n"));
  });
});
