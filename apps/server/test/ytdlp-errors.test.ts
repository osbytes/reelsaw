import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyYtdlpError, fatalYtdlpLine, isPageMissing, isPermanentDownloadFailure, largestReportedFile } from "../src/ytdlp-errors.js";

const PAGE_404 = "ERROR: [generic] zapier-logo: Unable to download webpage: HTTP Error 404: Not Found (caused by <HTTPError 404: Not Found>)";

describe("fatalYtdlpLine", () => {
  it("is the last ERROR line only", () => {
    assert.equal(fatalYtdlpLine(`[download] Got error: HTTP Error 404\nERROR: first\nWARNING: x\nERROR: last`), "ERROR: last");
    assert.equal(fatalYtdlpLine("yt-dlp exited with 1"), undefined);
  });
});

describe("isPermanentDownloadFailure", () => {
  it("fails a page 404 / 410, an unsupported URL, a private or removed video", () => {
    assert.ok(isPermanentDownloadFailure(PAGE_404));
    assert.ok(isPermanentDownloadFailure("ERROR: [generic] x: Unable to download webpage: HTTP Error 410: Gone"));
    assert.ok(isPermanentDownloadFailure("ERROR: Unsupported URL: https://example.com/"));
    assert.ok(isPermanentDownloadFailure("ERROR: [youtube] abc: Private video. Sign in if you've been granted access"));
    assert.ok(isPermanentDownloadFailure("ERROR: [youtube] abc: This video has been removed by the uploader"));
  });
  it("keeps retryable what another attempt can change", () => {
    // a 404 named in a retry notice or warning, not the fatal line
    assert.ok(!isPermanentDownloadFailure(`[download] Got error: HTTP Error 404: Not Found. Retrying (1/10)...\nERROR: timed out`));
    assert.ok(!isPermanentDownloadFailure(`WARNING: [generic] HTTP Error 404 on a fallback\nERROR: Connection reset`));
    // the media URL (signed, expiring) answered 404
    assert.ok(!isPermanentDownloadFailure("ERROR: unable to download video data: HTTP Error 404: Not Found"));
    assert.ok(!isPermanentDownloadFailure("ERROR: [youtube] abc: Sign in to confirm you're not a bot"));
    assert.ok(!isPermanentDownloadFailure("ERROR: [youtube] abc: Sign in to confirm your age"));
    assert.ok(!isPermanentDownloadFailure("ERROR: [youtube] abc: Video unavailable. The uploader has not made this video available in your country"));
    assert.ok(!isPermanentDownloadFailure("ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests"));
    assert.ok(!isPermanentDownloadFailure("ERROR: Unable to download webpage: HTTP Error 503: Service Unavailable"));
    assert.ok(!isPermanentDownloadFailure("Unsupported URL")); // no fatal line
  });
});

describe("classifyYtdlpError", () => {
  it("walks every proxy on a page 404 without opening a circuit", () => {
    assert.equal(classifyYtdlpError(PAGE_404), "other");
    assert.ok(isPageMissing(PAGE_404));
  });
  it("stops the walk on an unsupported URL or a removed video", () => {
    assert.equal(classifyYtdlpError("ERROR: Unsupported URL: https://example.com/"), "content");
    assert.equal(classifyYtdlpError("ERROR: [youtube] abc: This video has been removed by the uploader"), "content");
  });
  it("keeps the proxy faults and aborts", () => {
    assert.equal(classifyYtdlpError("ERROR: Unable to download webpage: HTTP Error 403: Forbidden"), "proxy");
    assert.equal(classifyYtdlpError("The operation was aborted"), "abort");
    assert.equal(classifyYtdlpError("ERROR: unable to download video data: HTTP Error 404: Not Found"), "other");
  });
});

describe("largestReportedFile", () => {
  it("is the biggest part yt-dlp reports", () => {
    assert.equal(largestReportedFile({ requested_formats: [{ filesize: 10 }, { filesize_approx: 30 }], filesize_approx: 20 }), 30);
    assert.equal(largestReportedFile({ title: "x" }), null);
  });
});
