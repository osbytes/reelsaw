#!/usr/bin/env node
// Renders the pipeline film (components/pipeline-film.tsx) to an MP4 and a poster JPEG by stepping
// the animation one frame at a time in a real Chrome and piping the screenshots into ffmpeg.
//
//   pnpm dev                       # or pnpm build && pnpm start, in another terminal
//   pnpm render:film               # writes ../docs/assets/pipeline.{mp4,gif} + pipeline-poster.jpg
//   node scripts/render-pipeline-film.mjs --url http://localhost:3200/pipeline-film --fps 30
//
// The GIF is what the README shows (GitHub's video player never autoplays; a GIF does), made from
// the MP4 with a per-film palette so the dark UI stays small. The MP4 is linked for full quality.
//
// Needs ffmpeg on PATH and Google Chrome installed (playwright-core drives it; no browser download).

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"] : null))
    .filter(Boolean),
);
const url = args.url ?? "http://localhost:3200/pipeline-film";
const fps = Number(args.fps ?? 30);
const crf = Number(args.crf ?? 23);
const mp4Out = path.resolve(args.out ?? path.join(repo, "docs/assets/pipeline.mp4"));
const gifOut = args.gif === "false" ? null : path.resolve(args.gif ?? mp4Out.replace(/\.mp4$/, ".gif"));
const gifWidth = Number(args["gif-width"] ?? 920);
const gifFps = Number(args["gif-fps"] ?? 15);
const posterOuts = (args.poster ?? path.join(repo, "docs/assets/pipeline-poster.jpg")).split(",").map((p) => path.resolve(p.trim()));

const W = 1920;
const H = 1080;

const run = (cmd, argv) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });

async function launch() {
  for (const channel of ["chrome", "chromium", undefined]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (e) {
      if (channel === undefined) throw e;
    }
  }
}

const browser = await launch();
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1, reducedMotion: "no-preference" });
  await page.goto(url, { waitUntil: "networkidle" });
  // The dev server's overlay badge would land in the corner of every frame; production builds have none.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.waitForFunction(() => typeof window.__pipelineFilm?.seek === "function");
  await page.evaluate(() => document.fonts.ready);
  const { total, poster } = await page.evaluate(() => ({ total: window.__pipelineFilm.total, poster: window.__pipelineFilm.poster }));
  const frames = Math.round(total * fps);
  console.log(`${url}: ${total}s at ${fps} fps = ${frames} frames → ${mp4Out}`);

  // Seek, let React commit and the compositor paint, then screenshot.
  const seek = (t) => page.evaluate((t) => new Promise((r) => (window.__pipelineFilm.seek(t), requestAnimationFrame(() => requestAnimationFrame(r)))), t);

  await seek(poster);
  const posterPng = await page.screenshot({ type: "jpeg", quality: 88, clip: { x: 0, y: 0, width: W, height: H } });
  for (const p of posterOuts) {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, posterPng);
    console.log(`poster (t=${poster}s) → ${p}`);
  }

  await mkdir(path.dirname(mp4Out), { recursive: true });
  const ffmpeg = spawn(
    "ffmpeg",
    ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4Out],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const done = new Promise((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
  });
  const write = (buf) => new Promise((resolve, reject) => ffmpeg.stdin.write(buf, (err) => (err ? reject(err) : resolve())));

  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    await seek(i / fps);
    await write(await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: W, height: H } }));
    if (i % (fps * 5) === 0 || i === frames - 1) {
      const s = (Date.now() - started) / 1000;
      process.stdout.write(`\r  frame ${i + 1}/${frames}  ${(i / s).toFixed(0)} fps  ${s.toFixed(0)}s`);
    }
  }
  process.stdout.write("\n");
  ffmpeg.stdin.end();
  await done;
  console.log(`done → ${mp4Out}`);

  if (gifOut) {
    const filters = `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", mp4Out, "-vf", filters, gifOut]);
    console.log(`gif (${gifWidth}px, ${gifFps} fps) → ${gifOut}`);
  }
} finally {
  await browser.close();
}
