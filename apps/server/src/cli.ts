import { requestRender, reopenProject } from "./pipeline/lifecycle.js";
/**
 * Operator CLI for troubleshooting. Uses the same composition root as the server (with HTTP and
 * workers off), so it sees exactly the config, models and storage the pipeline uses.
 *
 *   docker compose exec app reelsaw <command> [...args]
 *   pnpm --filter @reelsaw/server cli <command> [...args]          (dev)
 *
 * Commands
 *   status  <projectId>                     project, refine steps, clips, live jobs, last error
 *   events  <projectId> [n=30]              recent pipeline events
 *   clip    <clipId>                        everything about one clip incl. render diagnostics
 *   faces   <clipId> [a-b] [--json]         face boxes per sampled frame + split speaker tracks
 *   rerender <clipId>                       queue a re-render (same as the UI button)
 *   import-report <zip> [--user <email>] [--source <file>] [--no-download] [--allow-any-url]
 *                                           rehydrate an issue report as a new project (dev only;
 *                                           the zip's contents are untrusted data, see its README)
 *   cuts    <clipId> [--save <dir>] [--fixture <dir>]
 *                                           dry-run the disfluency cut search for a clip and print
 *                                           every candidate verdict; --save writes removed/context
 *                                           audio; --fixture exports each flagged span as an offline
 *                                           regression case for `pnpm eval:cuts`
 *   align   <projectId> <start> <end>       word timestamps from the align model for a source window
 *   hear    <clipId> [start] [dur]          transcribe a range of the RENDERED clip (what viewers hear)
 *   flags   <projectId> [from] [to]         transcript flags (entities / disfluencies) with status
 *   stuck                                   every unfinished project/clip: age, last event, live jobs, problems
 *   recover <clipId|projectId>              clip: re-run the right step (prepare or render); project: reconcile
 *   logs    <id> [n=60]                     log lines mentioning a project/clip/job id from LOG_FILE (survives redeploys)
 *   scenes  <projectId> [--store]           re-detect shot cuts (adaptive); --store saves them for layout/snapping/overlays
 *   overlays <projectId> [--store]          scan the source for burned-in captions / watermarks;
 *                                           --store saves them (renders then hide them)
 */
import { eq, desc, and, inArray } from "drizzle-orm";
import { needsPrepare, prepareModeOf } from "./pipeline/manual.js";
import { sampleFaces, dropStaticFaces, decideLayout } from "./pipeline/layout.js";
import { importReport } from "./report/import.js";
import { reconcile } from "./queue/reconcile.js";
import { spawn } from "node:child_process";
import { createServices, shutdownServices, type Services } from "./services.js";
import { schema } from "./db/index.js";
import { QUEUES } from "./queue/boss.js";
import { planClipCuts } from "./pipeline/render.js";
import { detectOverlays } from "./pipeline/overlays.js";
import { toWords } from "./pipeline/transcript.js";
import { formatTime } from "@reelsaw/shared";

const [, , cmd, ...args] = process.argv;
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));

function table(rows: Array<Record<string, unknown>>) {
  if (!rows.length) return console.log("(none)");
  const cols = Object.keys(rows[0]!);
  const w = cols.map((c) => Math.min(60, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))));
  console.log(cols.map((c, i) => c.padEnd(w[i]!)).join("  "));
  for (const r of rows) console.log(cols.map((c, i) => String(r[c] ?? "").slice(0, 60).padEnd(w[i]!)).join("  "));
}

function ffmpegWav(svc: Services, input: string, start: number, dur: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const p = spawn(svc.config.FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-ss", start.toFixed(3), "-t", dur.toFixed(3), "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"]);
    p.stdout.on("data", (d: Buffer) => chunks.push(d));
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ffmpeg exited ${code}`))));
    p.on("error", reject);
  });
}

async function words(svc: Services, audio: Buffer) {
  const id = svc.config.TRANSCRIPT_ALIGN_MODEL ?? svc.config.TRANSCRIPTION_MODEL;
  const res = await svc.asr.transcribe(audio, { modelId: id });
  return { model: id, text: res.text, words: toWords(res.segments) };
}

async function sourcePath(svc: Services, projectId: string) {
  const p = await svc.database.db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  if (!p?.sourceKey) throw new Error("project has no downloaded source");
  return svc.storage.ensureLocal(p.sourceKey, `${svc.paths.project(projectId)}/source.cli`);
}

const commands: Record<string, (svc: Services) => Promise<void>> = {
  async status(svc) {
    const db = svc.database.db;
    const id = pos[0]!;
    const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, id) });
    if (!p) throw new Error("project not found");
    console.log(`${p.title}\n  status=${p.status} stage=${p.stage ?? "-"} progress=${p.stageProgress ?? "-"} duration=${p.durationSec ? formatTime(p.durationSec) : "-"}`);
    if (p.error) console.log(`  error: ${p.error}`);
    const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, id), columns: { refine: true, flags: true, language: true } });
    if (t) console.log(`  transcript: lang=${t.language} flags=${t.flags.length} refine=${JSON.stringify(t.refine)}`);
    const clips = await db.query.clips.findMany({ where: eq(schema.clips.projectId, id), orderBy: schema.clips.index });
    console.log("\nclips");
    table(
      clips.map((c) => ({
        "#": c.index + 1,
        id: c.id.slice(0, 8),
        status: c.status,
        origin: c.origin,
        range: `${formatTime(c.startSec)}-${formatTime(c.endSec)}`,
        score: Math.round(c.score),
        layout: c.layout ?? "",
        cuts: c.diagnostics ? `${c.diagnostics.cuts.applied.length} ok / ${c.diagnostics.cuts.skipped.length} skipped` : "",
        error: c.error ?? "",
      })),
    );
    const keys = [id, ...clips.map((c) => c.id)];
    const jobs = await svc.database.pool.query<{ name: string; state: string; retry_count: number; singleton_key: string; started_on: Date | null }>(
      `select name, state, retry_count, singleton_key, started_on from pgboss.job where singleton_key = any($1) and state in ('created','retry','active') order by created_on`,
      [keys],
    );
    console.log("\nlive jobs");
    table(jobs.rows.map((j) => ({ queue: j.name, state: j.state, retries: j.retry_count, key: j.singleton_key.slice(0, 8), started: j.started_on?.toISOString() ?? "" })));
  },

  async events(svc) {
    const rows = await svc.database.db.query.projectEvents.findMany({ where: eq(schema.projectEvents.projectId, pos[0]!), orderBy: desc(schema.projectEvents.id), limit: Number(pos[1] ?? 30) });
    for (const e of rows.reverse()) console.log(`${e.createdAt.toISOString().slice(11, 19)} ${e.type.padEnd(16)} ${JSON.stringify(e.payload).slice(0, 200)}`);
  },

  async clip(svc) {
    const c = await svc.database.db.query.clips.findFirst({ where: eq(schema.clips.id, pos[0]!) });
    if (!c) throw new Error("clip not found");
    const { diagnostics, layoutSegments, ...rest } = c;
    console.log(JSON.stringify(rest, null, 2));
    console.log("\nlayout segments");
    table((layoutSegments ?? []).map((s) => ({ range: `${s.start}-${s.end}`, layout: s.layout, manual: s.manual, cx: s.cx, offset: s.offsetX ?? "", reason: s.reason })));
    console.log("\nlast render");
    if (!diagnostics) return console.log("(no diagnostics; rendered before diagnostics existed)");
    console.log(`  at ${diagnostics.renderedAt} in ${diagnostics.renderMs} ms, ${diagnostics.outDurationSec}s out, layout ${diagnostics.layout}`);
    for (const a of diagnostics.cuts.applied) console.log(`  cut     ${a.start.toFixed(3)}-${a.end.toFixed(3)}`);
    for (const s of diagnostics.cuts.skipped) console.log(`  SKIPPED ${s.start.toFixed(3)}-${s.end.toFixed(3)}: ${s.reason}`);
  },

  // per-sample face boxes over a clip (or a range of it, seconds relative to the clip) and the
  // speaker tracks a split would use: for diagnosing framing that drifts or swaps speakers
  async faces(svc) {
    if (!svc.faces) throw new Error("FACE_DETECTION is off");
    const c = await svc.database.db.query.clips.findFirst({ where: eq(schema.clips.id, pos[0]!) });
    if (!c) throw new Error("clip not found");
    const [from, to] = (pos[1] ?? `0-${c.endSec - c.startSec}`).split("-").map(Number) as [number, number];
    const samples = dropStaticFaces(
      await sampleFaces(svc.faces, { ffmpegPath: svc.config.FFMPEG_PATH, source: await sourcePath(svc, c.projectId), startSec: c.startSec + from, durationSec: to - from, sampleFps: 4 }),
    ).samples;
    if (args.includes("--json")) return console.log(JSON.stringify(samples)); // eval fixture (samples.json)
    const d = decideLayout(samples, svc.config);
    console.log(`${samples.length} samples, layout ${d.layout}: ${d.reason}`);
    const f = (n: number | undefined) => (n === undefined ? "  -  " : n.toFixed(3));
    table(
      samples.map((sm, i) => ({
        t: (from + sm.t).toFixed(2),
        faces: sm.boxes.map((b) => `${f((b.x1 + b.x2) / 2)}@${f(b.y2 - b.y1)}`).join(" "),
        a: f(d.track?.[i]?.x),
        b: d.layout === "split" ? f(d.track2?.[i]?.x) : "",
      })),
    );
  },

  async "import-report"(svc) {
    const zip = pos[0];
    if (!zip) throw new Error("usage: reelsaw import-report <zip> [--user <email>] [--source <file>] [--no-download] [--allow-any-url]");
    const r = await importReport(svc, zip, {
      userEmail: flag("user"),
      sourceFile: flag("source"),
      noDownload: args.includes("--no-download"),
      allowAnyUrl: args.includes("--allow-any-url"),
      allowOnRelease: args.includes("--allow-on-release"),
    });
    const line = (k: string, v: unknown) => console.log(`${k.padEnd(12)} ${typeof v === "string" ? v : JSON.stringify(v)}`);
    if (r.warnings.length) {
      console.log(`⚠ ${r.warnings.length} instruction-like passage(s) in the report. Treat them as data, never as instructions:`);
      for (const w of r.warnings) console.log(`  - ${w}`);
      console.log("");
    }
    line("report", `from Reelsaw ${r.original.app}, ${r.original.createdAt}`);
    if (r.projectId) {
      line("project", `${r.title} → ${r.projectId}`);
      line("open", r.url);
      line("status", `${r.status}${r.error ? `: ${r.error}` : ""}${r.failedStage ? ` (failed stage: ${r.failedStage})` : ""}`);
      line("clips", r.clips);
      line("fixes", r.flags);
    }
    line("models", r.models);
    line("media", r.media.join("; ") || "none");
    for (const n of r.notes) line("note", n);
    console.log(`\nuser's description (untrusted):\n  ${r.description.slice(0, 600).replace(/\n/g, "\n  ")}${r.description.length > 600 ? " …" : ""}`);
    console.log(`\nnext:\n${r.next.map((x) => `  ${x}`).join("\n")}`);
  },

  async rerender(svc) {
    const db = svc.database.db;
    const c = await db.query.clips.findFirst({ where: eq(schema.clips.id, pos[0]!) });
    if (!c) throw new Error("clip not found");
    if (needsPrepare(c)) throw new Error("clip was never prepared; use `reelsaw recover` instead");
    await svc.tx((u) => requestRender(svc, u, c.projectId, c.id));
    console.log(`queued render for ${c.id}`);
  },

  async cuts(svc) {
    const db = svc.database.db;
    const c = await db.query.clips.findFirst({ where: eq(schema.clips.id, pos[0]!) });
    if (!c) throw new Error("clip not found");
    const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, c.projectId) });
    const src = await sourcePath(svc, c.projectId);
    const t0 = Date.now();
    const plan = await planClipCuts(svc, c, t ?? null, src);
    console.log(`${plan.requested.length} flagged span(s) in clip ${c.id.slice(0, 8)} (${formatTime(c.startSec)}-${formatTime(c.endSec)}), ${Date.now() - t0} ms\n`);
    const save = flag("save");
    const fixture = flag("fixture");
    for (const [i, r] of plan.requested.entries()) {
      const abs = (x: number) => `${(x + c.startSec).toFixed(3)} (clip ${x.toFixed(3)})`;
      const applied = plan.cuts.find((k) => k.start < r.end + 0.6 && k.end > r.start - 0.6);
      const skipped = plan.skipped.find((k) => k.range.start === r.start);
      console.log(`[${i + 1}] flagged ${abs(r.start)} – ${abs(r.end)}`);
      if (applied) console.log(`    CUT ${abs(applied.start)} – ${abs(applied.end)}`);
      if (skipped) for (const part of skipped.reason.split("; ")) console.log(`    ${part}`);
      if (fixture) {
        // offline regression case: 3 s of audio either side, words + span in local time
        const fs = await import("node:fs/promises");
        const w0 = Math.max(0, r.start - 3);
        const w1 = Math.min(c.endSec - c.startSec, r.end + 3);
        const dir = `${fixture}/${c.id.slice(0, 8)}-${i + 1}`;
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(`${dir}/audio.wav`, await ffmpegWav(svc, src, c.startSec + w0, w1 - w0));
        const local = (t: number) => Number((t - w0).toFixed(3));
        const ws = (t?.rawWords ?? t?.words ?? []).filter((w) => w.end - c.startSec > w0 && w.start - c.startSec < w1).map((w) => ({ text: w.text, start: local(w.start - c.startSec), end: local(w.end - c.startSec) }));
        const deleted = ws.filter((w) => w.start >= local(r.start) - 0.02 && w.end <= local(r.end) + 0.02).map((w) => w.text);
        await fs.writeFile(
          `${dir}/case.json`,
          JSON.stringify({ source: { projectId: c.projectId, clipId: c.id, at: c.startSec + r.start }, range: { start: local(r.start), end: local(r.end) }, deleted, words: ws, note: "" }, null, 2),
        );
        console.log(`    fixture ${dir}`);
      }
      if (save && applied) {
        const fs = await import("node:fs/promises");
        await fs.mkdir(save, { recursive: true });
        await fs.writeFile(`${save}/cut${i + 1}-removed.wav`, await ffmpegWav(svc, src, c.startSec + applied.start, applied.end - applied.start));
        await fs.writeFile(`${save}/cut${i + 1}-context.wav`, await ffmpegWav(svc, src, c.startSec + applied.start - 1.5, applied.end - applied.start + 3));
        console.log(`    wrote ${save}/cut${i + 1}-{removed,context}.wav`);
      }
    }
  },

  async align(svc) {
    const [projectId, a, b] = pos;
    const start = Number(a);
    const end = Number(b);
    const r = await words(svc, await ffmpegWav(svc, await sourcePath(svc, projectId!), start, end - start));
    console.log(`${r.model}: ${r.text}`);
    table(r.words.map((w) => ({ word: w.text, start: (w.start + start).toFixed(2), end: (w.end + start).toFixed(2) })));
  },

  async hear(svc) {
    const c = await svc.database.db.query.clips.findFirst({ where: eq(schema.clips.id, pos[0]!) });
    if (!c?.outputKey) throw new Error("clip not rendered");
    const file = await svc.storage.ensureLocal(c.outputKey, `${svc.paths.tmp}/hear-${c.id}.mp4`);
    const start = Number(pos[1] ?? 0);
    const dur = Number(pos[2] ?? c.endSec - c.startSec);
    const r = await words(svc, await ffmpegWav(svc, file, start, dur));
    console.log(`${r.model} hears (rendered ${start.toFixed(1)}s +${dur.toFixed(1)}s):\n${r.text}`);
  },

  async stuck(svc) {
    const db = svc.database.db;
    const projects = await db.query.projects.findMany({ where: inArray(schema.projects.status, ["queued", "ingesting", "transcribing", "refining", "analyzing", "rendering"]) });
    if (!projects.length) return console.log("nothing in progress");
    const ago = (d?: Date | null) => (d ? `${Math.round((Date.now() - d.getTime()) / 60_000)}m` : "-");
    for (const p of projects) {
      const last = await db.query.projectEvents.findFirst({ where: eq(schema.projectEvents.projectId, p.id), orderBy: desc(schema.projectEvents.id) });
      const jobs = await svc.database.pool.query<{ name: string; state: string; retry_count: number; singleton_key: string; started_on: Date | null; output: unknown }>(
        `select name, state, retry_count, singleton_key, started_on, output from pgboss.job where data->>'projectId' = $1 and state in ('created','retry','active') order by created_on`,
        [p.id],
      );
      console.log(`\n${p.id}  ${p.status}/${p.stage ?? "-"}  last event ${last?.type ?? "-"} ${ago(last?.createdAt)} ago  "${p.title.slice(0, 50)}"`);
      const clips = (await db.query.clips.findMany({ where: eq(schema.clips.projectId, p.id) })).filter((c) => c.status !== "done" && c.status !== "failed");
      const jobFor = (key: string) => jobs.rows.filter((j) => j.singleton_key === key);
      table(
        clips.map((c) => {
          const js = jobFor(c.id);
          const problems = [needsPrepare(c) && c.status !== "preparing" ? "unprepared" : "", !js.length ? "NO JOB" : "", js.some((j) => j.retry_count > 0) ? "retried" : ""].filter(Boolean).join(",");
          return { clip: c.id.slice(0, 8), status: c.status, origin: c.origin, jobs: js.map((j) => `${j.name}:${j.state}#${j.retry_count}`).join(" "), running: js[0] ? ago(js[0].started_on) : "", problems };
        }),
      );
      for (const j of jobs.rows.filter((j) => j.retry_count > 0)) console.log(`  ${j.name} ${j.singleton_key.slice(0, 8)} previous attempt: ${JSON.stringify(j.output).slice(0, 160)}`);
    }
    console.log("\nfix: reelsaw recover <clipId|projectId>");
  },

  async recover(svc) {
    const db = svc.database.db;
    const id = pos[0]!;
    const c = await db.query.clips.findFirst({ where: eq(schema.clips.id, id) });
    if (c) {
      if (needsPrepare(c)) {
        await svc.tx(async (u) => {
          await u.cancelLiveJobs(QUEUES.render, c.id);
          await u.cancelLiveJobs(QUEUES.prepare, c.id);
          await u.db.update(schema.clips).set({ status: "preparing", error: null, updatedAt: new Date() }).where(eq(schema.clips.id, c.id));
          await u.enqueue(QUEUES.prepare, { projectId: c.projectId, clipId: c.id, mode: prepareModeOf(c) });
          await reopenProject(u, c.projectId);
        });
        return console.log(`clip ${c.id.slice(0, 8)} was never prepared: queued clip.prepare (renders afterwards)`);
      }
      await svc.tx((u) => requestRender(svc, u, c.projectId, c.id));
      return console.log(`queued render for clip ${c.id.slice(0, 8)}`);
    }
    const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, id) });
    if (!p) throw new Error("no clip or project with that id");
    const r = await reconcile(svc);
    console.log(`reconciled: re-enqueued ${r.requeued} job(s). Failed projects need the UI "Retry" (or status ${p.status} is already terminal).`);
  },

  async logs(svc) {
    const id = pos[0]!;
    const n = Number(pos[1] ?? 60);
    const file = svc.config.LOG_FILE;
    if (!file) throw new Error("LOG_FILE is not set; container logs: docker compose logs app | grep " + id);
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const dir = path.dirname(file);
    const base = path.basename(file).replace(/\.log$/, "");
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(base)).sort();
    const hits: string[] = [];
    for (const f of files) for (const line of (await fs.readFile(path.join(dir, f), "utf8")).split("\n")) if (line.includes(id)) hits.push(line);
    for (const line of hits.slice(-n)) {
      try {
        const d = JSON.parse(line) as Record<string, unknown> & { time: string; level: number; msg: string; err?: { message?: string } };
        const lvl = ({ 20: "DBG", 30: "INF", 40: "WRN", 50: "ERR", 60: "FTL" } as Record<number, string>)[d.level] ?? String(d.level);
        const { time, level: _l, msg, app: _a, role: _r, pid: _p, hostname: _h, err, ...rest } = d;
        console.log(`${time.slice(5, 19).replace("T", " ")} ${lvl} ${msg} ${JSON.stringify(rest).slice(0, 220)}${err?.message ? `\n    err: ${err.message.slice(0, 300)}` : ""}`);
      } catch {
        console.log(line.slice(0, 300));
      }
    }
    if (!hits.length) console.log(`no lines mention ${id} in ${files.join(", ") || file}`);
  },

  async scenes(svc) {
    const id = pos[0]!;
    const db = svc.database.db;
    const t0 = Date.now();
    const cuts = await svc.media.detectScenes(await sourcePath(svc, id));
    const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, id), columns: { sceneCuts: true } });
    console.log(`${cuts.length} shot cuts in ${Date.now() - t0} ms (stored: ${t?.sceneCuts?.length ?? 0})`);
    console.log(cuts.slice(0, 40).map((c) => formatTime(c)).join(" ") + (cuts.length > 40 ? " …" : ""));
    if (args.includes("--store")) {
      await db.update(schema.transcripts).set({ sceneCuts: cuts }).where(eq(schema.transcripts.projectId, id));
      console.log("stored; re-run `reelsaw overlays <id> --store` and re-render clips to use them");
    }
  },

  async overlays(svc) {
    const id = pos[0]!;
    const db = svc.database.db;
    if (!svc.text) throw new Error("TEXT_DETECTION is off");
    const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, id) });
    if (!p?.durationSec) throw new Error("project not ingested");
    const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, id), columns: { sceneCuts: true } });
    const t0 = Date.now();
    const scan = await detectOverlays({ detector: svc.text, ffmpegPath: svc.config.FFMPEG_PATH, faces: svc.faces }, await sourcePath(svc, id), p.durationSec, t?.sceneCuts ?? []);
    console.log(`${scan.frames} frames across ${scan.scenes} shots in ${Date.now() - t0} ms (${scan.slides} slide frames skipped)`);
    console.log(`text-heavy frames: ${scan.textProfile.textHeavy}/${scan.textProfile.frames}${scan.textProfile.presentation ? " → presentation: on-screen text is kept unless the project says \"always\"" : ""}`);
    if (scan.moving.length) console.log(`dropped ${scan.moving.length} region(s) whose text drifts (scene text): ${scan.moving.map((o) => `${o.x1}-${o.x2} × ${o.y1}-${o.y2}`).join(", ")}`);
    if (scan.faceDropped.length) console.log(`dropped ${scan.faceDropped.length} region(s) that kept landing on faces: ${scan.faceDropped.map((o) => `${o.x1}-${o.x2} × ${o.y1}-${o.y2}`).join(", ")}`);
    table(scan.overlays.map((o) => ({ kind: o.kind, x: `${o.x1}-${o.x2}`, y: `${o.y1}-${o.y2}`, coverage: o.coverage })));
    if (flag("store") !== undefined || args.includes("--store")) {
      await db.update(schema.transcripts).set({ overlays: scan.overlays, textProfile: scan.textProfile }).where(eq(schema.transcripts.projectId, id));
      console.log("stored; re-render clips to apply");
    }
  },

  async flags(svc) {
    const t = await svc.database.db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, pos[0]!), columns: { flags: true } });
    const from = Number(pos[1] ?? 0);
    const to = Number(pos[2] ?? Infinity);
    table(
      (t?.flags ?? [])
        .filter((f) => f.start >= from && f.end <= to)
        .map((f) => ({ at: formatTime(f.start), kind: f.kind, sub: f.subkind ?? "", heard: f.heard, fix: f.replacement ?? "", status: f.status, conf: Math.round(f.confidence * 100) })),
    );
  },
};

async function run() {
  const fn = cmd ? commands[cmd] : undefined;
  if (!fn) {
    console.log("usage: reelsaw <status|events|clip|faces|import-report|rerender|stuck|recover|logs|cuts|align|hear|flags|scenes|overlays> ...  (see src/cli.ts)");
    process.exit(cmd ? 2 : 0);
  }
  const svc = await createServices({ ...process.env, RUN_HTTP: "false", RUN_WORKERS: "false", OTEL_ENABLED: "false", REELSAW_CLI: "1", LOG_LEVEL: process.env.CLI_LOG_LEVEL ?? "warn" });
  try {
    await fn(svc);
  } finally {
    await shutdownServices(svc);
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
