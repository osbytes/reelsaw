/**
 * The link the website's hero box carries through sign-up (`/signup?url=`): what is accepted, how it is
 * tidied, and the New project path it lands on. Pure functions, no running app needed.
 * Run: node --import tsx --test test/new-project-link.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { newProjectPath, normalizeSourceUrl } from "@reelsaw/shared";

describe("normalizeSourceUrl", () => {
  it("keeps a full link and adds https:// to a bare one", () => {
    assert.equal(normalizeSourceUrl("https://www.youtube.com/watch?v=abc"), "https://www.youtube.com/watch?v=abc");
    assert.equal(normalizeSourceUrl("  youtube.com/watch?v=abc "), "https://youtube.com/watch?v=abc");
    assert.equal(normalizeSourceUrl("youtu.be/abc"), "https://youtu.be/abc");
  });

  it("refuses what cannot be a web page", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "   ",
      "hello world",
      "javascript:alert(1)",
      "ftp://example.com/a",
      "localhost",
      "data:text/html,hi",
      `https://a.com/${"x".repeat(2100)}`,
    ]) {
      assert.equal(normalizeSourceUrl(bad), null, String(bad).slice(0, 40));
    }
  });
});

describe("newProjectPath", () => {
  it("encodes the link into /new?url=", () => {
    assert.equal(newProjectPath("https://youtube.com/watch?v=a&t=1"), "/new?url=https%3A%2F%2Fyoutube.com%2Fwatch%3Fv%3Da%26t%3D1");
  });
});
