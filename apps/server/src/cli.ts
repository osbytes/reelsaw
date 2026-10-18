import { requestRender, requestRenders, startRun } from "./pipeline/lifecycle.js";
import { describeRun, runsOfProject } from "./pipeline/runs.js";
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
 *   rerender <clipId…>                      queue a re-render of one or several clips (same as the UI buttons)
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
 *   storage [sweep [--dry-run]]            disk use: unique, scratch-only, duplicate-source, expired-but-present bytes;
 *                                           `sweep` removes leftover files nothing points at (the reconciler's hourly sweep)
 *   stuck                                   every unfinished project/clip: age, last event, live jobs, problems
 *   recover <clipId|projectId>              clip: re-run the right step (prepare or render); project: reconcile
 *   logs    <id> [n=60] [--since 2h] [--level debug] [--module render] [--raw]
 *                                           log lines mentioning a project/clip/job/request id from LOG_FILE (survives redeploys)
 *   log-level [<level|module=level,...>|reset] [--for 15m]
 *                                           show the log levels in force, or set them for a while (e.g. render=debug); all processes follow within ~5 s
 *   scenes  <projectId> [--store]           re-detect shot cuts (adaptive); --store saves them for layout/snapping/overlays
 *   bumpers list|usage <id>|default <intro|outro> <id|none>|remove <id>|restore <id> [--user <email>]
 *                                           the intro/outro library. The user is --user, else the only account
 *                                           on this install; otherwise pass --user
 *   project-bumpers <projectId> [--intro default|none|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]
 *   clip-bumpers <projectId> <clipId…> [--intro inherit|none|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]
 *                                           per project / per clip choice; acts as the project's owner;
 *                                           --rerender re-renders only the affected clips
 *   overlays <projectId> [--store]          scan the source for burned-in captions / watermarks;
 *                                           --store saves them (renders then hide them)
 */
import { projectBumperSummaries } from "./bumpers/service.js";
import { describeCoverage } from "./bumpers/summary.js";
import { eq, desc, and, inArray } from "drizzle-orm";
import { needsPrepare, prepareModeOf } from "./pipeline/manual.js";
import { sampleFaces, dropStaticFaces, decideLayout, segmentLayouts, newLayoutDiag } from "./pipeline/layout.js";
import { attachText, voteTrace } from "./pipeline/content-region.js";
import { sampleClipText } from "./pipeline/overlays.js";
import { importReport } from "./report/import.js";
import { reconcile } from "./queue/reconcile.js";
import { spawn } from "node:child_process";
import { createServices, shutdownServices, type Services } from "./services.js";
import { approveUser, setUserRole } from "./accounts.js";
import { sweepRetention } from "./retention.js";
import { sweepScratch, purgeBumperAssets, readSweepState } from "./storage/sweep.js";
import { storageReport, formatBytes } from "./storage/usage.js";
import { schema } from "./db/index.js";
import { QUEUES } from "./queue/boss.js";
import { planClipCuts } from "./pipeline/render.js";
import { detectOverlays } from "./pipeline/overlays.js";
import { toWords } from "./pipeline/transcript.js";
import { readLogLines, LEVEL_NUM, LEVEL_LABEL } from "./log-read.js";
import { parseDuration, mergeLogLevels, DEFAULT_LOG_OVERRIDE_MS } from "./log-level.js";
import { formatTime } from "@reelsaw/shared";
import { appRouter } from "./trpc/router.js";
import { clipBumpersCall, libraryView, projectBumpersCall } from "./bumpers/service.js";
import { deletedProjects, purgeDeleted, restoreClip, restoreProject } from "./projects/service.js";

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
  const id = svc.models.get().align;
  const res = await svc.asr.transcribe(audio, { modelId: id });
  return { model: id, text: res.text, words: toWords(res.segments) };
}

async function sourcePath(svc: Services, projectId: string) {
  const p = await svc.database.db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  if (!p?.sourceKey) throw new Error("project has no downloaded source");
  return svc.storage.ensureLocal(p.sourceKey, `${svc.paths.project(projectId)}/source.cli`);
}

const commands: Record<string, (svc: Services) => Promise<void>> = {
  /** Accounts: list, approve, promote. For when the admin locked themselves out or email is off. */
  async users(svc) {
    const rows = await svc.database.db.query.user.findMany({ orderBy: schema.user.createdAt });
    table(rows.map((u) => ({ email: u.email, name: u.name, role: u.role, status: u.banned ? "suspended" : u.approvedAt ? "active" : "pending", created: u.createdAt.toISOString().slice(0, 10) })));
  },
  async approve(svc) {
    const u = await userByEmail(svc, pos[0]);
    const r = await approveUser(svc, null, u.id);
    console.log(r.changed ? `approved ${u.email}` : `${u.email} was already approved`);
  },
  /** Run the retention sweep now (SOURCE_RETENTION_DAYS / CLIP_RETENTION_DAYS). */
  async retention(svc) {
    const r = await sweepRetention(svc);
    console.log(`removed ${r.sources} stored sources and ${r.clips} rendered clips (SOURCE_RETENTION_DAYS=${svc.config.SOURCE_RETENTION_DAYS}, CLIP_RETENTION_DAYS=${svc.config.CLIP_RETENTION_DAYS})`);
  },
  /** Deleted projects that can still be restored, with the date the purge removes them (DELETED_RETENTION_DAYS). */
  async deleted(svc) {
    const rows = await deletedProjects(svc);
    table(rows.map((r) => ({ id: r.id, title: r.title, owner: r.email, status: r.status, deleted: r.deletedAt!.toISOString().slice(0, 16), purged: r.purgeAt?.toISOString().slice(0, 10) ?? "never" })));
  },
  /** Undo a delete: `reelsaw restore <projectId>`. Same function as projects.restore and the restore_project tool. */
  async restore(svc) {
    if (!pos[0]) throw new Error("usage: reelsaw restore <projectId>   (reelsaw deleted lists them)");
    const r = await restoreProject(svc, null, pos[0]);
    console.log(r.changed ? `restored ${pos[0]} (${r.status}${r.status === "failed" ? "; Retry resumes it" : ""})` : `${pos[0]} was not deleted`);
  },
  /** Bring back a clip a re-analyze replaced: `reelsaw restore-clip <clipId>`. */
  async "restore-clip"(svc) {
    if (!pos[0]) throw new Error("usage: reelsaw restore-clip <clipId>");
    const r = await restoreClip(svc, null, pos[0]);
    console.log(r.changed ? `restored clip ${pos[0]}${r.needsRerender ? " (it never finished rendering: re-render it)" : ""}` : `${pos[0]} was not deleted`);
  },
  /** Remove deleted projects and replaced clips past DELETED_RETENTION_DAYS now (the storage sweep does this hourly). */
  async purge(svc) {
    const dry = args.includes("--dry-run");
    const r = await purgeDeleted(svc, { dryRun: dry });
    console.log(`${dry ? "would purge" : "purged"} ${r.projects.length} project(s) and ${r.clips.length} replaced clip(s) deleted over ${svc.config.DELETED_RETENTION_DAYS} days ago (DELETED_RETENTION_DAYS=${svc.config.DELETED_RETENTION_DAYS}; 0 keeps them)`);
  },
  "make-admin": async (svc) => {
    const u = await userByEmail(svc, pos[0]);
    if (!u.approvedAt) await approveUser(svc, null, u.id);
    const r = await setUserRole(svc, null, u.id, "admin");
    console.log(r.changed ? `${u.email} is now an admin` : `${u.email} was already an admin`);
  },
  async status(svc) {
    const db = svc.database.db;
    const id = pos[0]!;
    const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, id) });
    if (!p) throw new Error("project not found");
    console.log(`${p.title}\n  status=${p.status} stage=${p.stage ?? "-"} progress=${p.stageProgress ?? "-"} duration=${p.durationSec ? formatTime(p.durationSec) : "-"}`);
    if (p.error) console.log(`  error: ${p.error}`);
    if (p.deletedAt) console.log(`  DELETED ${p.deletedAt.toISOString()} (reelsaw restore ${p.id})`);
    const ev = await svc.database.pool.query<{ total: string; progress: string }>(`select count(*) as total, count(*) filter (where type = 'stage.progress') as progress from project_events where project_id = $1`, [id]);
    console.log(`  events: ${ev.rows[0]!.total} stored (progress ticks are live-only and never stored; ${ev.rows[0]!.progress} refine step updates; EVENT_RETENTION_DAYS=${svc.config.EVENT_RETENTION_DAYS})`);
    const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, id), columns: { refine: true, flags: true, language: true } });
    if (t) console.log(`  transcript: lang=${t.language} flags=${t.flags.length} refine=${JSON.stringify(t.refine)}`);
    const clips = await db.query.clips.findMany({ where: eq(schema.clips.projectId, id), orderBy: schema.clips.index });
    console.log("\nclips");
    table(
      clips.map((c) => ({
        "#": c.index + 1,
        id: c.id.slice(0, 8),
        status: c.deletedAt ? `${c.status}, replaced` : c.status,
        origin: c.origin,
        range: `${formatTime(c.startSec)}-${formatTime(c.endSec)}`,
        score: Math.round(c.score),
        layout: c.layout ?? "",
        cuts: c.diagnostics ? `${c.diagnostics.cuts.applied.length} ok / ${c.diagnostics.cuts.skipped.length} skipped` : "",
        error: c.error ?? "",
      })),
    );
    const bumpers = (await projectBumperSummaries(db, p.userId, [{ id, settings: p.settings, clips }])).get(id)!;
    for (const slot of ["intro", "outro"] as const) {
      const b = bumpers[slot];
      if (b) console.log(`  ${describeCoverage(slot, b.name, b)}`);
    }
    const runs = await runsOfProject(db, id);
    console.log("\nruns");
    if (!runs.length) console.log("  (none recorded)");
    for (const r of runs) console.log(`  ${describeRun(r)}`);
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
    const source = await sourcePath(svc, c.projectId);
    // exactly what a render feeds the layout: static faces dropped, the per-clip text scan (2 fps) attached
    // to the nearest face sample, the divider probe (`divider.s` is its strength, 0..1) from the same frames
    let samples = dropStaticFaces(await sampleFaces(svc.faces, { ffmpegPath: svc.config.FFMPEG_PATH, source, startSec: c.startSec + from, durationSec: to - from, sampleFps: 4 })).samples;
    if (svc.text) {
      const frames = await sampleClipText({ detector: svc.text, ffmpegPath: svc.config.FFMPEG_PATH }, source, c.startSec + from, to - from);
      samples = attachText(samples, frames.map((f) => ({ t: f.t, all: f.all })));
    }
    if (args.includes("--json")) return console.log(JSON.stringify(samples)); // eval fixture (samples.json)
    if (args.includes("--votes")) {
      // the content-region vote per frame and the runs it forms (what `render=trace` / `content runs` log in a render)
      const diag = newLayoutDiag();
      const segs = segmentLayouts(samples, svc.config, [], to - from, undefined, diag);
      console.log(JSON.stringify({ segments: segs.map((sg) => ({ start: sg.start, end: sg.end, layout: sg.decision.layout, reason: sg.decision.reason })), frames: diag.frames, voting: diag.voting, candidates: diag.candidates, decisions: diag.decisions }, null, 1));
      return table(samples.map((sm) => voteTrace(sm)));
    }
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
    if (!pos.length) throw new Error("usage: reelsaw rerender <clipId…>");
    const rows = await db.query.clips.findMany({ where: inArray(schema.clips.id, pos), columns: { id: true, projectId: true, origin: true, status: true, reasoning: true, scores: true } });
    if (rows.length !== new Set(pos).size) throw new Error("clip not found");
    const bad = rows.find((c) => needsPrepare(c));
    if (bad) throw new Error(`clip ${bad.id} was never prepared; use \`reelsaw recover\` instead`);
    for (const projectId of new Set(rows.map((c) => c.projectId))) {
      const r = await svc.tx((u) => requestRenders(svc, u, projectId, rows.filter((c) => c.projectId === projectId).map((c) => c.id)));
      console.log(`${projectId}: queued ${r.rerendered} render(s)${r.skipped ? `, skipped ${r.skipped} (still rendering)` : ""}`);
    }
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
    const r = await words(svc, await ffmpegWav(svc, file, start, dur)).finally(() => void import("node:fs/promises").then((f) => f.rm(file, { force: true })));
    console.log(`${r.model} hears (rendered ${start.toFixed(1)}s +${dur.toFixed(1)}s):\n${r.text}`);
  },

  async storage(svc) {
    if (pos[0] === "sweep") {
      const dry = args.includes("--dry-run");
      const r = await sweepScratch(svc, { dryRun: dry });
      table(r.removals.map((x) => ({ kind: x.kind, path: x.path, size: formatBytes(x.bytes), project: x.projectId?.slice(0, 8) ?? "", clip: x.clipId?.slice(0, 8) ?? "", gen: x.gen ?? "" })));
      console.log(`${dry ? "would remove" : "removed"} ${r.removals.length} file(s), ${formatBytes(r.bytes)}`);
      const gone = await purgeBumperAssets(svc, { dryRun: dry });
      console.log(`${dry ? "would purge" : "purged"} ${gone.length} library asset(s) removed over 30 days ago and used nowhere`);
      const del = await purgeDeleted(svc, { dryRun: dry });
      console.log(`${dry ? "would purge" : "purged"} ${del.projects.length} deleted project(s) and ${del.clips.length} replaced clip(s) (DELETED_RETENTION_DAYS=${svc.config.DELETED_RETENTION_DAYS})`);
      return;
    }
    const r = await storageReport(svc);
    console.log(`unique bytes under DATA_DIR (hardlinks counted once)  ${formatBytes(r.uniqueBytes)}`);
    console.log(`scratch-only leftovers (sweep would remove)          ${formatBytes(r.scratchOrphanBytes)} in ${r.scratchOrphanFiles} file(s)`);
    console.log(`duplicate sources (same video, several projects)     ${formatBytes(r.duplicateSourceBytes)} in ${r.duplicateSourceGroups} video(s)`);
    console.log(`expired but still on disk (SOURCE_RETENTION_DAYS=${svc.config.SOURCE_RETENTION_DAYS})   ${formatBytes(r.expiredButPresentBytes)} in ${r.expiredButPresentProjects} project(s)`);
    if (r.scratchOrphanFiles) console.log("run `reelsaw storage sweep` to remove the leftovers");
    const sw = await readSweepState(svc);
    console.log(
      sw.lastRunAt
        ? `background sweep: last ran ${sw.lastRunAt} in ${sw.lastRunMs} ms, ${sw.lastScanned} directories, ${sw.lastComplete ? "reached the end" : `stopped on its time budget; resumes after "${sw.cursor}"`}, removed ${sw.lastRemoved}`
        : "background sweep: has not run yet (hourly from the reconciler)",
    );
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
          await startRun(u, c.projectId, { reason: "retry", status: "rendering", stage: "render" });
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
    const id = pos[0];
    if (!id) throw new Error("usage: reelsaw logs <projectId|clipId|jobId|requestId> [n=60] [--since 2h] [--level debug] [--module render] [--raw]");
    const n = Number(pos[1] ?? 60);
    const file = svc.config.LOG_FILE;
    if (!file) throw new Error("LOG_FILE is not set; container logs: docker compose logs app | grep " + id);
    const sinceMs = flag("since") ? parseDuration(flag("since")!) : undefined;
    if (flag("since") && sinceMs === undefined) throw new Error("--since takes a duration like 90s, 15m, 2h");
    const level = flag("level");
    if (level && !(level in LEVEL_NUM)) throw new Error(`--level is one of ${Object.keys(LEVEL_NUM).join(", ")}`);
    const { lines, files } = await readLogLines(file, { ids: [id], since: sinceMs ? new Date(Date.now() - sinceMs) : undefined, minLevel: level as keyof typeof LEVEL_NUM | undefined, module: flag("module"), limit: n });
    for (const line of lines) {
      if (args.includes("--raw")) {
        console.log(line);
        continue;
      }
      try {
        const d = JSON.parse(line) as Record<string, unknown> & { time: string; level: number; msg: string; module?: string; err?: { message?: string } };
        const { time, level: lv, msg, app: _a, role: _r, pid: _p, hostname: _h, err, module: mod, projectId: _pid, ...rest } = d;
        console.log(`${time.slice(5, 23).replace("T", " ")} ${LEVEL_LABEL[lv] ?? String(lv)} ${mod ? `[${mod}] ` : ""}${msg} ${JSON.stringify(rest).slice(0, 260)}${err?.message ? `\n    err: ${err.message.slice(0, 300)}` : ""}`);
      } catch {
        console.log(line.slice(0, 300));
      }
    }
    if (!lines.length) console.log(`no lines mention ${id} in ${files.join(", ") || file}`);
  },

  async "log-level"(svc) {
    const { parseLogLevels, formatLogLevels } = await import("./log.js");
    const env = parseLogLevels(process.env.LOG_LEVEL || "info");
    const show = (st: Awaited<ReturnType<typeof svc.logLevel.refresh>> & { acks?: number }) => {
      if (st.acks !== undefined) console.log(st.acks > 0 ? `applied by ${st.acks} process(es)` : "no running process answered within 2 s (they will pick it up within ~5 s, or none is running)");
      const effective = st.override ? mergeLogLevels(env, st.override.spec) : env;
      console.log(`effective   ${formatLogLevels(effective)}`);
      console.log(`environment ${formatLogLevels(env)}  (LOG_LEVEL)`);
      console.log(st.override ? `override    ${st.override.spec} until ${st.override.until} (set by ${st.override.by ?? "?"}); every process applies it within ~5 s` : "override    none");
    };
    const spec = pos[0];
    if (!spec) return show(await svc.logLevel.refresh());
    if (spec === "reset" || spec === "off") return show(await svc.logLevel.set(null, "cli", undefined, 2000));
    const forMs = flag("for") ? parseDuration(flag("for")!) : DEFAULT_LOG_OVERRIDE_MS;
    if (forMs === undefined) throw new Error("--for takes a duration like 90s, 15m, 2h (max 24h)");
    show(await svc.logLevel.set(spec, "cli", forMs, 2000));
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

  /** Intro/outro library. Same tRPC procedures as the web app and the MCP tools, called as the resolved user. */
  async bumpers(svc) {
    const [sub, a, b] = bumperArgs().pos;
    const { api, user } = await bumperApi(svc, undefined);
    if (sub === "list") {
      const lib = await libraryView(svc, api, user.id);
      const row = (x: (typeof lib.assets)[number]) => ({ id: x.id, name: x.name, kind: x.kind, sec: x.durationSec, size: `${x.width}x${x.height}`, default: [x.isDefaultIntro && "intro", x.isDefaultOutro && "outro"].filter(Boolean).join("+"), usedBy: x.usedBy });
      table(lib.assets.map(row));
      if (lib.removed.length) {
        console.log("\nremoved (restorable for 30 days)");
        table(lib.removed.map(row));
      }
    } else if (sub === "usage" && a) {
      const u = await api.bumpers.usage({ id: a });
      if (!u.projects.length) console.log("(not used)");
      for (const p of u.projects) {
        console.log(`${p.title}  ${p.id}  project slots: ${p.slots.join(",") || "-"}`);
        for (const c of p.clips) console.log(`  clip #${c.index + 1} ${c.id.slice(0, 8)} ${c.title}  ${c.slots.join(",")} via ${c.via}`);
      }
    } else if (sub === "default" && (a === "intro" || a === "outro") && b) {
      await api.bumpers.setDefault({ slot: a, assetId: b === "none" ? null : b });
      console.log(b === "none" ? `cleared default ${a}` : `default ${a} is now ${b}`);
    } else if ((sub === "remove" || sub === "restore") && a) {
      await api.bumpers[sub === "remove" ? "delete" : "restore"]({ id: a });
      console.log(`${sub === "remove" ? "removed" : "restored"} ${a}`);
    } else throw new Error("usage: reelsaw bumpers list|usage <id>|default <intro|outro> <id|none>|remove <id>|restore <id> [--user <email>]");
  },
  async "project-bumpers"(svc) {
    const { pos: p, rerender, ...o } = bumperArgs();
    if (!p[0]) throw new Error("usage: reelsaw project-bumpers <projectId> [--intro default|none|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]");
    const { api } = await bumperApi(svc, p[0]);
    const r = await api.projects.setBumpers(projectBumpersCall({ projectId: p[0], intro: o.intro, outro: o.outro, introSec: o.introSec, outroSec: o.outroSec, rerender }));
    console.log(`updated; ${r.rerendered} clip(s) queued for re-render${rerender ? "" : " (pass --rerender to apply to finished clips now)"}`);
  },
  async "clip-bumpers"(svc) {
    const { pos: p, rerender, ...o } = bumperArgs();
    if (p.length < 2) throw new Error("usage: reelsaw clip-bumpers <projectId> <clipId…> [--intro inherit|none|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]");
    const { api } = await bumperApi(svc, p[0]);
    const r = await api.clips.setBumpersMany(clipBumpersCall({ projectId: p[0]!, clipIds: p.slice(1), intro: o.intro, outro: o.outro, introSec: o.introSec, outroSec: o.outroSec, rerender }));
    console.log(`updated ${r.updated} clip(s); ${r.rerendered} queued for re-render${rerender ? "" : " (pass --rerender to apply now)"}`);
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

/** Flags for the bumper commands (--rerender is boolean, so positional parsing must not treat the next word as its value). */
function bumperArgs() {
  const out = { pos: [] as string[], rerender: false, user: undefined as string | undefined, intro: undefined as string | undefined, outro: undefined as string | undefined, introSec: undefined as number | undefined, outroSec: undefined as number | undefined };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--rerender") out.rerender = true;
    else if (a === "--user") out.user = val();
    else if (a === "--intro") out.intro = val();
    else if (a === "--outro") out.outro = val();
    else if (a === "--intro-sec") out.introSec = Number(val());
    else if (a === "--outro-sec") out.outroSec = Number(val());
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else out.pos.push(a);
  }
  return out;
}

/**
 * A tRPC caller acting as one user. Resolution: --user <email>; else the owner of `projectId`; else the only
 * account on this install. Printed so the operator knows whose library they touched.
 */
async function bumperApi(svc: Services, projectId: string | undefined) {
  const { user: email } = bumperArgs();
  const db = svc.database.db;
  let user;
  if (email) user = await userByEmail(svc, email);
  else if (projectId) {
    const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId), columns: { userId: true } });
    if (!p) throw new Error("project not found");
    user = await db.query.user.findFirst({ where: eq(schema.user.id, p.userId) });
  } else {
    const all = await db.query.user.findMany({ limit: 2 });
    if (all.length !== 1) throw new Error("this install has several accounts: pass --user <email>");
    user = all[0];
  }
  if (!user) throw new Error("user not found");
  console.error(`acting as ${user.email}`);
  const req = new Request(svc.config.APP_URL);
  return { user, api: appRouter.createCaller({ svc, who: { user, via: "apikey", session: null, blocked: null }, req, requestId: "cli", log: svc.log.child({ module: "cli", userId: user.id }) }) };
}

async function userByEmail(svc: Services, email: string | undefined) {
  if (!email) throw new Error("usage: reelsaw <approve|make-admin> <email>");
  const u = await svc.database.db.query.user.findFirst({ where: eq(schema.user.email, email.toLowerCase()) });
  if (!u) throw new Error(`no account with email ${email}`);
  return u;
}

async function run() {
  const fn = cmd ? commands[cmd] : undefined;
  if (!fn) {
    console.log("usage: reelsaw <users|approve|make-admin|retention|deleted|restore|restore-clip|purge|status|storage|events|clip|faces|import-report|rerender|stuck|recover|logs|log-level|cuts|align|hear|flags|scenes|overlays|bumpers|project-bumpers|clip-bumpers> ...  (see src/cli.ts)");
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
