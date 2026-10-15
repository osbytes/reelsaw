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
 *   rerender <clipId>                       queue a re-render (same as the UI button)
 *   cuts    <clipId> [--save <dir>] [--fixture <dir>]
 *                                           dry-run the disfluency cut search for a clip and print
 *                                           every candidate verdict; --save writes removed/context
 *                                           audio; --fixture exports each flagged span as an offline
 *                                           regression case for `pnpm eval:cuts`
 *   align   <projectId> <start> <end>       word timestamps from the align model for a source window
 *   hear    <clipId> [start] [dur]          transcribe a range of the RENDERED clip (what viewers hear)
 *   flags   <projectId> [from] [to]         transcript flags (entities / disfluencies) with status
 */
import { eq, desc, and, inArray } from "drizzle-orm";
import { spawn } from "node:child_process";
import { transcribe as aiTranscribe } from "ai";
import type { JSONObject } from "@ai-sdk/provider";
import { createServices, shutdownServices, type Services } from "./services.js";
import { schema } from "./db/index.js";
import { QUEUES } from "./queue/boss.js";
import { planClipCuts } from "./pipeline/render.js";
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
  const res = await aiTranscribe({ model: await svc.ai.transcriptionModel(id), audio, providerOptions: svc.ai.transcriptionOptions(id) as Record<string, JSONObject> });
  return { model: id, text: res.text, words: toWords(res.segments.map((s) => ({ text: s.text, startSecond: s.startSecond, endSecond: s.endSecond }))) };
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

  async rerender(svc) {
    const db = svc.database.db;
    const c = await db.query.clips.findFirst({ where: eq(schema.clips.id, pos[0]!) });
    if (!c) throw new Error("clip not found");
    await svc.queue.cancelLiveJobs(QUEUES.render, c.id);
    await db.update(schema.clips).set({ status: "pending", error: null, outputKey: null, thumbnailKey: null, updatedAt: new Date() }).where(eq(schema.clips.id, c.id));
    await db.update(schema.projects).set({ status: "rendering", stage: "render", updatedAt: new Date() }).where(and(eq(schema.projects.id, c.projectId), inArray(schema.projects.status, ["done", "failed"])));
    await svc.queue.enqueue(QUEUES.render, { projectId: c.projectId, clipId: c.id });
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
    console.log("usage: reelsaw <status|events|clip|rerender|cuts|align|hear|flags> ...  (see src/cli.ts)");
    process.exit(cmd ? 2 : 0);
  }
  const svc = await createServices({ ...process.env, RUN_HTTP: "false", RUN_WORKERS: "false", OTEL_ENABLED: "false", REELSAW_CLI: "1" });
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
