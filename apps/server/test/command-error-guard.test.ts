/**
 * A failed child process is a `CommandError` (media.ts), never a hand-built `new Error("ffmpeg exited …")`. The
 * hand-built ones printed "exited null" for a process killed from outside (the server out of memory, a stopped
 * job): a clip failed with "ffmpeg exited with null" and nothing to act on. CommandError names the signal
 * and leads with ffmpeg's own error lines. Scans the server for the hand-built spellings.
 * node --import tsx --test test/command-error-guard.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CommandError } from "../src/media.js";

const src = path.join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.ts$/.test(e.name) ? [path.join(dir, e.name)] : []));
/** `new Error(` whose message reports a child's exit code itself */
const HAND_BUILT = /new Error\(`[^`]*(?:exited|\(\$\{code\}\)|failed \(\$\{code\}\))/;

describe("child process failures", () => {
  it("are CommandError everywhere", () => {
    const hits = files(src).flatMap((f) =>
      fs
        .readFileSync(f, "utf8")
        .split("\n")
        .flatMap((l, i) => (HAND_BUILT.test(l) ? [`${path.relative(src, f)}:${i + 1}: ${l.trim()}`] : [])),
    );
    assert.deepEqual(hits, [], "use new CommandError(bin, code, stderr, signal) from media.ts");
  });

  it("say which signal stopped a process instead of 'exited with null'", () => {
    const e = new CommandError("ffmpeg", null, "Error while decoding stream #0:1", "SIGKILL");
    assert.match(e.message, /^ffmpeg was stopped by SIGKILL \(usually the server running out of memory\)/);
    assert.doesNotMatch(e.message, /null/);
    assert.match(new CommandError("ffmpeg", 1, "").message, /^ffmpeg exited with 1/);
  });
});

describe("CommandError's lead lines", () => {
  const header = [
    "ffmpeg version 5.1.6-0+deb12u1 Copyright (c) 2000-2024 the FFmpeg developers",
    "  built with gcc 12 (Debian 12.2.0-14)",
    "  configuration: --prefix=/usr --extra-version=0+deb12u1 " + "--enable-x ".repeat(60),
    "  libavutil      57. 28.100 / 57. 28.100",
    "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'clip.mp4':",
    ...Array.from({ length: 12 }, (_, i) => `    Stream #0:${i}: Audio: aac (LC), 48000 Hz, stereo, fltp, 128 kb/s (default)`),
  ].join("\n");

  it("a reason with no error word (the last lines) still leads, ahead of the banner", () => {
    const e = new CommandError("ffmpeg", 1, `${header}\nOutput #0, image2, to 'thumb.jpg':\nOutput file #0 does not contain any stream\n`);
    const lead = e.message.split("--- tail ---")[0] ?? "";
    assert.match(lead, /does not contain any stream/);
    assert.doesNotMatch(lead, /configuration:|built with/);
    assert.ok(lead.length < 600, `lead is ${lead.length} chars`);
  });

  it("flagged lines win over the last lines, and progress lines never lead", () => {
    const e = new CommandError(
      "ffmpeg",
      69,
      `${header}\n[aac @ 0x1] Input buffer exhausted before END element found\nframe=  100 fps=30 q=28.0 size=512kB time=00:00:03.33\n`,
    );
    assert.match(e.message, /^ffmpeg exited with 69: \[aac @ 0x1\] Input buffer exhausted before END element found\n--- tail ---/);
  });

  it("a long flagged block is cut so the message's start survives a short export limit", () => {
    const noisy = Array.from({ length: 6 }, (_, i) => `[h264 @ 0x${i}] error while decoding MB ${"x".repeat(150)}`).join("\n");
    const lead = new CommandError("ffmpeg", 1, noisy).message.split("--- tail ---")[0] ?? "";
    assert.ok(lead.length < 450, `lead is ${lead.length} chars`);
  });
});
