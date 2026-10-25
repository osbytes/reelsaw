#!/usr/bin/env node
// Renders a demo film (components/films/<name>.tsx) to MP4 (+ WebM with --webm) + poster JPEG by stepping the
// animation one frame at a time in a real Chrome and piping the screenshots into ffmpeg. The films
// carry real <video> clips, so each seek also waits for every video to land on its frame.
//
//   pnpm dev                                   # or pnpm build && pnpm start, in another terminal
//   pnpm render:film hero                      # → public/films/hero.{mp4,jpg}
//   node scripts/render-film.mjs hero --fps 30 --gif ../docs/assets/hero.gif
//   node scripts/render-film.mjs reframe --still --at 4.2 --out /tmp/stills   # one frame, to check a moment
//
// Needs ffmpeg on PATH and Google Chrome installed (playwright-core drives it; no browser download).

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(here, "..");

const argv = process.argv.slice(2);
const name = argv.find((a) => !a.startsWith("--"));
if (!name) {
  console.error("usage: render-film.mjs <film> [--url http://localhost:3200] [--fps 30] [--crf 23] [--out dir] [--gif path] [--webm] [--still [--at sec]]");
  process.exit(2);
}
const args = Object.fromEntries(argv.map((a, i, all) => (a.startsWith("--") ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true"] : null)).filter(Boolean));
const base = args.url ?? "http://localhost:3200";
const url = `${base}/films/${name}`;
const fps = Number(args.fps ?? 30);
const crf = Number(args.crf ?? 23);
const outDir = path.resolve(args.out ?? path.join(site, "public/films"));
const still = args.still === "true";
const gifOut = args.gif ? path.resolve(args.gif) : null;

const run = (cmd, a) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, a, { stdio: "inherit" });
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
  const probe = await browser.newPage();
  await probe.goto(url, { waitUntil: "networkidle" });
  await probe.waitForFunction(() => typeof window.__film?.seek === "function");
  const film = await probe.evaluate(() => ({ total: window.__film.total, poster: window.__film.poster, W: window.__film.width, H: window.__film.height }));
  await probe.close();

  const page = await browser.newPage({ viewport: { width: film.W, height: film.H }, deviceScaleFactor: 1, reducedMotion: "no-preference" });
  await page.goto(url, { waitUntil: "networkidle" });
  // The dev server's overlay badge would land in the corner of every frame; production builds have none.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  await page.waitForFunction(() => typeof window.__film?.seek === "function");
  await page.evaluate(() => document.fonts.ready);
  // Let every <video> load enough to seek.
  await page.waitForFunction(() => Array.from(document.querySelectorAll("video[data-film-t]")).every((v) => v.readyState >= 1), null, { timeout: 60_000 });

  const seek = (t) => page.evaluate((t) => window.__film.seek(t), t);
  const shot = (type, quality) => page.screenshot({ type, ...(quality ? { quality } : {}), clip: { x: 0, y: 0, width: film.W, height: film.H } });

  await mkdir(outDir, { recursive: true });
  const at = args.at !== undefined ? Number(args.at) : film.poster;
  await seek(at);
  if (still) {
    const png = path.join(outDir, args.at !== undefined ? `${name}-${at}s.png` : `${name}.png`);
    await writeFile(png, await shot("png"));
    console.log(`still (t=${at}s) → ${png}`);
  } else {
    const poster = path.join(outDir, `${name}.jpg`);
    await writeFile(poster, await shot("jpeg", 86));
    console.log(`poster (t=${film.poster}s) → ${poster}`);

    const frames = Math.round(film.total * fps);
    const mp4Out = path.join(outDir, `${name}.mp4`);
    const webmOut = path.join(outDir, `${name}.webm`);
    console.log(`${url}: ${film.total}s at ${fps} fps = ${frames} frames → ${mp4Out}`);

    // One pass of screenshots into an intermediate lossless file, then the two deliverables from it.
    const tmp = path.join(outDir, `.${name}-frames.mkv`);
    const ffmpeg = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-", "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", tmp], { stdio: ["pipe", "inherit", "inherit"] });
    const done = new Promise((resolve, reject) => {
      ffmpeg.on("error", reject);
      ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
    });
    const write = (buf) => new Promise((resolve, reject) => ffmpeg.stdin.write(buf, (err) => (err ? reject(err) : resolve())));
    const started = Date.now();
    for (let i = 0; i < frames; i++) {
      await seek(i / fps);
      await write(await shot("png"));
      if (i % (fps * 2) === 0 || i === frames - 1) {
        const s = (Date.now() - started) / 1000;
        process.stdout.write(`\r  frame ${i + 1}/${frames}  ${(i / Math.max(s, 0.01)).toFixed(0)} fps  ${s.toFixed(0)}s`);
      }
    }
    process.stdout.write("\n");
    ffmpeg.stdin.end();
    await done;

    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", tmp, "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4Out]);
    console.log(`mp4 → ${mp4Out}`);
    if (args.webm === "true") {
      await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", tmp, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", String(Math.min(crf + 10, 40)), "-row-mt", "1", "-pix_fmt", "yuv420p", "-an", webmOut]);
      console.log(`webm → ${webmOut}`);
    }
    if (gifOut) {
      const filters = `fps=15,scale=920:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
      await mkdir(path.dirname(gifOut), { recursive: true });
      await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", mp4Out, "-vf", filters, gifOut]);
      console.log(`gif → ${gifOut}`);
    }
    await run("rm", ["-f", tmp]);
  }
} finally {
  await browser.close();
}
