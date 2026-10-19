import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseDownloadTick } from "../src/pipeline/ingest.js";
import { lineSplitter } from "../src/media.js";

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
