import { describeRun, runsOfProject } from "./pipeline/runs.js";
/**
 * Operator CLI for troubleshooting. Uses the same composition root as the server (with HTTP and
 * workers off), so it sees exactly the config, models and storage the pipeline uses.
 *
 *   docker compose exec app reelsaw <command> [...args]
 *   pnpm --filter @reelsaw/server cli <command> [...args]          (dev)
 *
 * Commands
 *   version [--json]                        running version, latest published release, how to upgrade
 *   releases [--json] [--limit n]           published versions from GitHub (reelsaw.com/releases / list_releases)
 *   users                                   list accounts: role, status, sign-up date
 *   approve <email>                         approve a waiting account (when email is off or the admin is locked out)
 *   make-admin <email>                      promote an account to admin (approves it first if needed)
 *   set-password <email> [--must-change]    set an account's password from a prompt (or two stdin lines);
 *                                           `--must-change` requires a new one at next sign-in. Do not put
 *                                           the secret on the command line
 *   retention                               run the retention sweep now (SOURCE_RETENTION_DAYS / CLIP_RETENTION_DAYS)
 *   deleted [email]                         restorable deletes as one list with their purge date. No email: projects
 *                                           across the install. With email: that account (the Deleted page / list_deleted)
 *   restore <projectId>                     undo a project delete (same as projects.restore and the restore_project tool)
 *   restore-clip <clipId>                   bring back a deleted clip or one a re-analyze replaced
 *   delete-clip <clipId>                    delete one clip, restorable like a project (same as clips.delete and delete_clip)
 *   delete-clips <projectId> <clipId…>      delete several clips of one project at once (same as the selection bar, clips.deleteMany and delete_clips)
 *   purge-clip <clipId>                     delete one already-deleted clip forever (same as clips.purge and purge_clip)
 *   captions <clipId> [--format srt|vtt] [--words]   print a clip's rendered captions as an SRT or VTT file (same as clips.captions and get_clip_captions)
 *   transcript-file <projectId> [--format srt|vtt] [--words]   print a project's transcript as an SRT or VTT file (same as projects.transcriptFile and get_project_transcript_file)
 *   import-transcript <projectId> <file.srt|file.vtt> [--language xx]   use a subtitle file as the transcript instead of transcribing (same as projects.importTranscript and import_transcript)
 *   update-project <projectId> [--title t] [--set key=value]… [--clear key]…
 *                                           rename a project or change its settings without re-running anything
 *                                           (same as projects.update and update_project); values are JSON or text
 *   source-text <projectId> <hide|keep|always>
 *                                           hide or keep text burned into the source and re-render finished clips (same as projects.setSourceText and set_project_source_text)
 *   update-style <projectId> [--set key=value]… [--keep-overrides] [--no-rerender]
 *                                           change the caption/hook style of the whole project, clearing per-clip overrides and re-rendering
 *                                           (same as projects.updateStyle and update_project_style); values are JSON or text
 *   create-project <url> [--user <email|id>] [--title t] [--set key=value]…
 *                                           start a project from a link for an account (the given user, else the only account);
 *                                           same as projects.create and create_project; takes the same settings as update-project
 *   retry <projectId>                       resume a failed or stuck project from its furthest completed stage (same as the Retry button, projects.retry and retry_project)
 *   reanalyze <projectId> [--set key=value]…
 *                                           pick clips again from the existing transcript, optionally with new selection settings; clips made or edited
 *                                           by hand stay (same as projects.reanalyze and reanalyze_project)
 *   refine <projectId> [--steps entities,disfluency,scenes] [--vocabulary text]
 *                                           re-run refine steps on the existing transcript, then re-render (same as projects.refine and refine_project)
 *   delete-project <projectId> [--forget-decisions]   delete a project, restorable like a clip (same as projects.delete and delete_project); --forget-decisions forgets its decisions when it is purged
 *   export <projectId> [clipId…] --out <file.zip>
 *                                           write the zip of rendered clips with YouTube / TikTok metadata; the same conditions as the Export button and
 *                                           export_project (every picked clip must belong to the project, at least one rendered)
 *   create-clip <projectId> <startSec> <endSec> [--mode exact|ai]
 *                                           add a clip from a time range of the source: exact keeps the bounds, ai picks the best moment inside them
 *                                           (same as clips.create and create_clip)
 *   update-clip <clipId> [--title t] [--hook t] [--caption t] [--start s] [--end s] [--rerender|--no-rerender]
 *                                           edit one clip; a change burned into the video re-renders it unless told not to (same as clips.update and update_clip)
 *   purge [--dry-run]                       remove deleted projects and replaced clips past DELETED_RETENTION_DAYS now
 *   purge-project <projectId> [--forget-decisions]   delete one already-deleted project forever (frees storage; minutes stay counted); its decisions stay in the decision log unless --forget-decisions
 *   decisions <email> [--kind k] [--project id]      the account's decision log: what it accepted, rejected, cut and edited (Settings → Learning / list_decisions)
 *   decisions export <email> [--out f.jsonl] [--since iso]   the decision log as JSON lines, for evals (export_decisions; harvest-decisions.ts, the decisions suite)
 *   decisions forget <email> [--project id]          delete the account's decisions, or one project's (forget_decisions)
 *   decisions learning <email> on|off                record the account's decisions or stop (Settings → Learning / set_learning)
 *   decisions backfill [--dry-run]                   write decisions still held in transcripts from before the log existed
 *   machine [--json]                        this box: cpus, memory, disk, GPU, ffmpeg encoder in use and why,
 *                                           where each on-device model runs (same as Settings → System → Overview)
 *   ytdlp-proxies [--json]                  yt-dlp egress pool: operator priority vs circuit (reliability), never URLs
 *   workers [--json]                        every process that has checked in: role, specs, last seen, current jobs
 *                                           (same as Settings → System → Workers)
 *   queue [--json]                          waiting / running / retrying jobs per stage, plus what is in flight
 *                                           (same as Settings → System → Queue)
 *   failure <projectId|clipId> [--json]     one failed project or clip: owner, stage, the full recorded reason
 *                                           (same as clicking a row under Settings → System → Queue → Failed work)
 *   retry-failures [--stage s] [--q text] [--since 24h] [--json]
 *                                           retry failed projects and clips matching a reason after a platform fix
 *                                           (same as Settings → System → Queue → Retry all matching)
 *   status  <projectId>                     project, refine steps, clips, live jobs, last error
 *   events  <projectId> [n=30]              recent pipeline events
 *   clip <clipId>                           everything about one clip incl. render diagnostics
 *   faces <clipId> [a-b] [--json]           face boxes per sampled frame + split speaker tracks
 *   rerender <clipId…>                      queue a re-render of one or several clips; a clip that never got its AI title is prepared first (same as the UI buttons, clips.rerender / rerenderMany and rerender_clip / rerender_clips)
 *   import-report <zip> [--user <email>] [--source <file>] [--no-download] [--allow-any-url]
 *                                           rehydrate an issue report as a new project (dev only;
 *                                           the zip's contents are untrusted data, see its README)
 *   report [projectId] [--out file.zip] [--instance] [--description text] [--user email]
 *                                           write an issue-report zip (same as Report an issue);
 *                                           --instance adds unfinished work, failed jobs, usage and
 *                                           error logs across every account (operator)
 *   cuts <clipId> [--save <dir>] [--fixture <dir>]
 *                                           dry-run the disfluency cut search for a clip and print
 *                                           every candidate verdict; can save the removed and context
 *                                           audio, and export each flagged span as an offline
 *                                           regression case for `pnpm eval:cuts`
 *   align <projectId> <start> <end>         word timestamps from the align model for a source window
 *   hear <clipId> [start] [dur]             transcribe a range of the RENDERED clip (what viewers hear)
 *   flags <projectId> [from] [to]           transcript flags (entities / disfluencies / collapsed loops) with status
 *   storage [sweep [--dry-run] | reclaim <MB> [--dry-run]]   disk use: unique, scratch-only, scratch copies of stored files (S3), leased to jobs in flight, duplicate-source, expired-but-present bytes;
 *                                           `sweep` removes leftover files nothing points at and evicts idle cache copies (the reconciler's hourly sweep);
 *                                           `reclaim` evicts least-recently-used copies until that many MB are freed (what a job short of disk does on its own)
 *   stuck                                   every unfinished project/clip: age, last event, live jobs, problems
 *   recover <clipId|projectId>              clip: re-run the right step (prepare or render); failed project: retry it; any other project: put its lost jobs back
 *   logs <id> [n=60] [--since 2h] [--level debug] [--module render] [--raw]
 *                                           log lines mentioning a project/clip/job/request id from LOG_FILE (survives redeploys)
 *   log-level [<level|module=level,...>|reset] [--for 15m]
 *                                           show the log levels in force, or set them for a while (e.g. render=debug); all processes follow within ~5 s
 *   scenes  <projectId> [--store]           re-detect shot cuts (adaptive); --store saves them for layout/snapping/overlays
 *   library list|search|add|update|rename|delete|restore|purge|usage|default|reindex [--user <email>]
 *                                           the library: intro/outro videos and images, logos, stickers, GIFs, SVGs, music and
 *                                           sound effects. `list` shows your files, `search` looks in your library, the Reelsaw catalog (default) or an
 *                                           enabled provider (pexels, pixabay, freesound, iconify, openverse, giphy, klipy); `add` takes a file, a link
 *                                           or a search hit (license and credit are recorded); `update` sets tags, `rename` the name, `default` the
 *                                           intro or outro for new projects. Acts as the given user, else the only account on this install.
 *                                           `reindex` rebuilds the asset reference table ("used by", purge safety) for every project, to completion

 *   catalog status|refresh                  the Reelsaw catalog manifest in force (version, source, last check); refresh asks CATALOG_URL now
 *   project-bumpers <projectId> [--intro default|none|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]
 *                                           a project's intro/outro: the library default, none or a specific item
 *   clip-bumpers <projectId> <clipId…> [--intro inherit|none|<id>] [--outro …] [--intro-sec n] [--outro-sec n] [--rerender]
 *                                           a clip's own choice (inherit the project's, none or an item);
 *                                           both act as the project's owner;
 *                                           --rerender re-renders only the affected clips
 *   clip-layers <projectId> <clipId> [--set '<json array>' | --add <assetId> --from <sec> --to <sec> [--x f] [--y f] [--w f] [--opacity f] [--loop|--no-loop] | --add-text <text> --from <sec> --to <sec> [--x f] [--y f] [--size f] [--color #RRGGBB] [--font <family>] [--box] [--opacity f] | --add-sound <assetId> --from <sec> [--to <sec>] [--volume 0-1] [--offset <sec>] [--fade <sec>] [--duck|--no-duck] [--loop|--no-loop] | --remove <layerId> | --clear] [--rerender]
 *                                           everything laid over or played under a clip, one list (source seconds, x/y/w/size as
 *                                           fractions of the 9:16 frame); a sound of 8 s or less, is a one-shot at
 *                                           full level, anything else music (ducked, faded, looped); with no change flag it lists them
 *   apply-framing <clipId> [--at <sec>] [--keep-overrides] [--no-rerender]   make one clip's framing (its section at --at, else its first framed one: mode plus
 *                                           nudge / subject / crop) the project's default for every clip, clearing the others' own sections
 *                                           and re-rendering the finished ones (same as the editor's "Use for all clips" and apply_framing)
 *   templates list | show <id> | save <projectId> <clipId> <name…> | rename <id> <name…> | set <id> --layers '<json array>' | delete <id> | restore <id> | purge <id> | apply <templateId> <projectId> [clipId…] [--add] [--rerender]
 *                                           layer templates: layers whose timing fits any clip length (head / tail / fill / relative);
 *                                           `save` builds one from a clip's layers, `apply` writes them onto the clips of a project
 *                                           (all of them without clip ids; --add keeps the clip's own layers, default replaces);
 *                                           --rerender re-renders the finished ones. Same procedures as the Templates page and the MCP tools
 *   overlays <projectId> [--store]          scan the source for burned-in captions / watermarks;
 *                                           --store saves them (renders then hide them)
 *   usage [--days 30]                       per account: projects, source minutes, clips, model calls / tokens / reported
 *                                           cost, minutes transcribed, stored bytes (same numbers as Users → Usage)
 *   limits  <email> [--watermark always|never|follow]
 *                                           an account's quotas: instance value, plan, override, in force, in use now;
 *                                           --watermark sets the per-user override (same as Users → Limits)
 *   abuse [--run]                           accounts the hourly abuse pass flagged (shared sign-up address, bursts,
 *                                           temporary domains); --run recomputes the flags now
 *   billing <email> | sync [<email>] | set-plan <email> <plan|none>
 *                                           hosted (REELSAW_EE): an account's plan, subscription, Stripe's view and its
 *                                           last webhook events; `sync` re-reads Stripe for one account or every
 *                                           subscription (the daily reconcile, by hand); `set-plan` grants a plan
 *                                           without Stripe (none removes it)
 *   settings [KEY=value…] [--clear KEY…]    instance settings in force (sign-up mode, quotas, retention, …): .env default,
 *                                           admin override, effective; KEY=value changes one without a restart,
 *                                           --clear KEY goes back to .env (same as Settings → System and set_instance_settings)
 *   mcp                                     the MCP server over stdio for clients that launch a command:
 *                                           same tools as /api/mcp, forwarded to REELSAW_URL with
 *                                           REELSAW_API_KEY (needs no database; see src/mcp-stdio.ts)
 */
import { projectBumperSummaries } from "./library/service.js";
import { describeCoverage } from "./library/summary.js";
import { eq, desc, and, inArray, or, sql } from "drizzle-orm";
import { needsPrepare } from "./pipeline/manual.js";
import { sampleFaces, dropStaticFaces, decideLayout, segmentLayouts, newLayoutDiag } from "./pipeline/layout.js";
import { attachText, voteTrace } from "./pipeline/content-region.js";
import { sampleClipText } from "./pipeline/overlays.js";
import { createReportZip } from "./report/bundle.js";
import { importReport } from "./report/import.js";
import { reconcile } from "./queue/reconcile.js";
import { listWorkers } from "./ops/workers.js";
import { summarizeQueue } from "./ops/queue.js";
import { FAILURE_STAGES, getFailure, listFailures, retryFailures, type FailureStage } from "./ops/failures.js";
import { flagAccounts, FLAG_HELP } from "./abuse.js";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { backfillDecisions, decisionSummary, EXPORT_MAX, exportDecisions, forgetDecisions, listDecisions, setLearning } from "./decisions/service.js";
import fsSync from "node:fs";
import readline from "node:readline";
import { clipCaptionsFile, importTranscript, projectTranscriptFile, type CaptionFormat } from "./transcript-files.js";
import { createServices, shutdownServices, type Services } from "./services.js";
import { approveUser, setUserPassword, setUserRole, setUserWatermark } from "./accounts.js";
import { LIMIT_KEYS, limitsFor, limitUsage, usageByUser, watermarkFor } from "./quota.js";
import { RUNTIME_KEYS, settingsPatchSchema, SettingsError } from "./instance-settings.js";
import { sweepRetention } from "./retention.js";
import { sweepScratch, purgeBumperAssets, readSweepState, reclaimScratch } from "./storage/sweep.js";
import { storageReport, formatBytes } from "./storage/usage.js";
import { schema } from "./db/index.js";
import { planClipCuts } from "./pipeline/render.js";
import { detectOverlays } from "./pipeline/overlays.js";
import { toWords } from "./pipeline/transcript.js";
import { readLogLines, LEVEL_NUM, LEVEL_LABEL } from "./log-read.js";
import { parseDuration, mergeLogLevels, DEFAULT_LOG_OVERRIDE_MS } from "./log-level.js";
import { formatTime, timingText, templateLayerSchema, clipLayerSchema, clipLayers, audioLayerDefaultsFor, SFX_AUDIO_DEFAULTS, CLIP_AUDIO_DEFAULTS, TEXT_OVERLAY_DEFAULTS, ASSET_OVERLAY_DEFAULT_W, type ClipLayer } from "@reelsaw/shared";
import { z } from "zod";
import { appRouter } from "./trpc/router.js";
import { clipBumpersCall, libraryView, projectBumpersCall, uploadLocalFile } from "./library/service.js";
import { backfillAssetRefs } from "./library/refs.js";
import { libraryProviders } from "./library/import.js";
import { assetVisibleTo } from "./library/visible.js";
import { runMcpStdio } from "./mcp-stdio.js";
import { listReleasesResult } from "./releases.js";
import { listDeleted } from "./deleted.js";
import { createProject, deleteClip, deleteClips, deleteOwnedProject, deletedProjects, framingOfClip, purgeDeleted, purgeOwnedClip, purgeOwnedProject, reanalyzeProject, refineProject, restoreClip, restoreProject, retryOwnedProject, setProjectSourceText, updateProject, updateProjectStyle } from "./projects/service.js";
import { createClip, readClip, rerenderClip, rerenderClips, updateClip } from "./clips/service.js";
import { createExportZip, exportPlan } from "./export.js";
import { DECISION_KINDS, CLEARABLE_SETTINGS, REFINE_STEPS, createProjectInputSchema, projectSettingsPatchSchema, styleOverrideSchema, type ClearableSetting, type ProjectSettingsPatch } from "@reelsaw/shared";

const [, , cmd, ...args] = process.argv;
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const pos = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));

/** "x+12% y-5% | x2+3%": the per-pane offsets of a layout segment, empty when none. */
function offsetsLabel(s: { offsetX?: number; offsetY?: number; offsetX2?: number; offsetY2?: number }) {
  const pct = (name: string, v: number | undefined) => (v ? `${name}${v > 0 ? "+" : ""}${Math.round(v * 100)}%` : "");
  const top = [pct("x", s.offsetX), pct("y", s.offsetY)].filter(Boolean).join(" ");
  const bottom = [pct("x2", s.offsetX2), pct("y2", s.offsetY2)].filter(Boolean).join(" ");
  return [top, bottom].filter(Boolean).join(" | ");
}
/** "followed" / "fixed" for the top pane, with a "·" prefixed second pane when the segment has one. */
function subjectLabel(s: { subject?: string; subject2?: string }) {
  return [s.subject, s.subject2 ? `·${s.subject2}` : ""].filter(Boolean).join(" ");
}

/** `--set key=value` (JSON, else text) and `--clear key` flags as a settings patch and the optional settings to reset. */
function settingsFlags(usage: string): { settings: ProjectSettingsPatch; clear: ClearableSetting[] } {
  const raw: Record<string, unknown> = {};
  const clear: ClearableSetting[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--set") {
      const kv = args[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq <= 0) throw new Error(`--set needs key=value\n${usage}`);
      const text = kv.slice(eq + 1);
      let v: unknown = text;
      try {
        v = JSON.parse(text);
      } catch {
        // plain text (focus, instructions, …)
      }
      raw[kv.slice(0, eq)] = v;
    } else if (args[i] === "--clear") {
      const name = args[++i];
      const k = CLEARABLE_SETTINGS.find((c) => c === name);
      if (!k) throw new Error(`--clear takes one of ${CLEARABLE_SETTINGS.join(", ")}`);
      clear.push(k);
    }
  }
  const parsed = projectSettingsPatchSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}\n${usage}`);
  return { settings: parsed.data, clear };
}

/** A non-negative number of seconds from a command-line word. */
function seconds(raw: string, what: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${what} must be a number of seconds, got "${raw}"`);
  return n;
}

/** `--user <email|id>`, else the only account on this install (printed, so the operator knows whose project it is). */
async function actingUser(svc: Services, who: string | undefined) {
  const db = svc.database.db;
  let user;
  if (who) user = await db.query.user.findFirst({ where: or(eq(schema.user.id, who), eq(schema.user.email, who.toLowerCase())) });
  else {
    const all = await db.query.user.findMany({ limit: 2 });
    if (all.length !== 1) throw new Error("this install has several accounts: pass --user <email|id>");
    user = all[0];
  }
  if (!user) throw new Error(`no account with email or id ${who}`);
  console.error(`acting as ${user.email}`);
  return user;
}

/** `--format srt|vtt` (default srt). */
function captionFormat(): CaptionFormat {
  const f = flag("format") ?? "srt";
  if (f !== "srt" && f !== "vtt") throw new Error("--format must be srt or vtt");
  return f;
}

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
  /** Running version against the latest GitHub release (updates.ts), with the upgrade command. */
  async version(svc) {
    const s = await svc.updates.check({ force: true });
    if (args.includes("--json")) return void console.log(JSON.stringify({ ...s, commit: svc.config.REELSAW_COMMIT, builtAt: svc.config.REELSAW_BUILT_AT }, null, 2));
    console.log(`running   ${s.current}  (${svc.config.REELSAW_COMMIT}, built ${svc.config.REELSAW_BUILT_AT})`);
    if (!s.enabled) return void console.log("latest    not checked (UPDATE_CHECK=false)");
    if (!s.latest) return void console.log(`latest    unknown: ${s.error ?? "no answer"}`);
    console.log(`latest    ${s.latest.version}  published ${s.latest.publishedAt?.slice(0, 10) ?? "-"}  ${s.latest.url}${s.error ? `  (stale: ${s.error})` : ""}`);
    if (s.available === null) console.log(`\nNot a release build, so the two cannot be compared. To update: ${s.upgrade.command}`);
    else if (s.available) console.log(`\nUpdate available. ${s.upgrade.note}\n  ${s.upgrade.command}\nSee ${s.upgrade.docsUrl}`);
    else console.log("\nUp to date.");
  },
  /** Published versions from GitHub (releases.ts / list_releases). */
  async releases(svc) {
    const limitRaw = flag("limit");
    const limit = limitRaw ? Number(limitRaw) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("--limit must be an integer 1-100");
    const s = await svc.releases.get();
    const listed = listReleasesResult(s, { limit });
    if (args.includes("--json")) return void console.log(JSON.stringify(listed, null, 2));
    if (listed.error && !listed.releases.length) return void console.log(`releases  unknown: ${listed.error}`);
    console.log(`${listed.total} published  ·  ${listed.commits ?? 0} commits in ${listed.windowDays ?? 90} days${listed.truncated ? "  (truncated)" : ""}${listed.error ? `  (stale: ${listed.error})` : ""}`);
    table(
      listed.releases.map((r) => ({
        version: r.version,
        date: r.publishedAt.slice(0, 10),
        kind: r.kinds.join(",") || (r.prerelease ? "pre" : ""),
        summary: r.summary,
      })),
    );
  },
  /** Accounts: list, approve, promote. For when the admin locked themselves out or email is off. */
  async users(svc) {
    const rows = await svc.database.db.query.user.findMany({ orderBy: schema.user.createdAt });
    table(rows.map((u) => ({ email: u.email, name: u.name, role: u.role, status: u.banned ? "suspended" : !u.approvedAt ? "pending" : u.mustChangePassword ? "must-change" : "active", created: u.createdAt.toISOString().slice(0, 10) })));
  },
  async approve(svc) {
    const u = await userByEmail(svc, pos[0]);
    const r = await approveUser(svc, null, u.id);
    console.log(r.changed ? `approved ${u.email}` : `${u.email} was already approved`);
  },
  /** Run the retention sweep now (SOURCE_RETENTION_DAYS / CLIP_RETENTION_DAYS). */
  async retention(svc) {
    const r = await sweepRetention(svc);
    const s = svc.settings.get();
    console.log(`removed ${r.sources} stored sources and ${r.clips} rendered clips (SOURCE_RETENTION_DAYS=${s.SOURCE_RETENTION_DAYS}, CLIP_RETENTION_DAYS=${s.CLIP_RETENTION_DAYS})`);
  },
  /** Restorable deletes. No email: every project's across the install. With email: that account (same as Deleted / list_deleted). */
  async deleted(svc) {
    const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "never");
    if (pos[0]) {
      const u = await userByEmail(svc, pos[0]);
      const page = await listDeleted(svc, u.id);
      console.log(`${u.email}: projects/clips restorable ${page.keepDays} day(s); library ${page.libraryDays}d; templates ${page.templateDays}d`);
      if (!page.items.length) {
        console.log("nothing waiting");
        return;
      }
      table(
        page.items.map((r) => ({
          kind: r.kind,
          id: r.id,
          name: r.title,
          bytes: r.storedBytes,
          deleted: r.deletedAt.slice(0, 16),
          purged: day(r.purgeAt),
          purge: r.canPurge ? "yes" : "held",
        })),
      );
      if (page.truncated) console.log(`showing first ${page.items.length} of ${page.total}`);
      return;
    }
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
  /** Soft-delete one clip: `reelsaw delete-clip <clipId>`. Same function as clips.delete and the delete_clip tool. */
  async "delete-clip"(svc) {
    if (!pos[0]) throw new Error("usage: reelsaw delete-clip <clipId>");
    const r = await deleteClip(svc, null, pos[0]);
    console.log(r.changed ? `deleted clip ${pos[0]}; reelsaw restore-clip brings it back ${r.restorable}` : `${pos[0]} was already deleted`);
  },
  /** Several clips of one project in one unit of work: `reelsaw delete-clips <projectId> <clipId…>`. Same as clips.deleteMany and delete_clips. */
  async "delete-clips"(svc) {
    const [projectId, ...clipIds] = pos;
    if (!projectId || !clipIds.length) throw new Error("usage: reelsaw delete-clips <projectId> <clipId…>");
    const r = await deleteClips(svc, null, projectId, clipIds);
    console.log(`deleted ${r.deleted} clip(s)${r.skipped ? `, ${r.skipped} already deleted` : ""}; reelsaw restore-clip brings each back ${r.restorable}`);
  },
  /** Delete one already-deleted clip forever: `reelsaw purge-clip <clipId>`. Same as clips.purge and the purge_clip tool. */
  async "purge-clip"(svc) {
    if (!pos[0]) throw new Error("usage: reelsaw purge-clip <clipId>   (must already be deleted; clips of a deleted project go with purge-project)");
    const r = await purgeOwnedClip(svc, null, pos[0]);
    console.log(r.message);
  },
  /** A clip's rendered captions as a file on stdout: `reelsaw captions <clipId> [--format srt|vtt] [--words] > clip.srt`. */
  async captions(svc) {
    if (!pos[0]) throw new Error("usage: reelsaw captions <clipId> [--format srt|vtt] [--words]");
    process.stdout.write((await clipCaptionsFile(svc, null, pos[0], { format: captionFormat(), words: args.includes("--words") })).text);
  },
  /** The project transcript as a file on stdout: `reelsaw transcript-file <projectId> [--format srt|vtt] [--words]`. */
  async "transcript-file"(svc) {
    if (!pos[0]) throw new Error("usage: reelsaw transcript-file <projectId> [--format srt|vtt] [--words]");
    process.stdout.write((await projectTranscriptFile(svc, null, pos[0], { format: captionFormat(), words: args.includes("--words") })).text);
  },
  /** Use a subtitle file as the transcript: `reelsaw import-transcript <projectId> <file.srt|file.vtt> [--language xx]`. Same function as projects.importTranscript. */
  async "import-transcript"(svc) {
    if (pos.length < 2) throw new Error("usage: reelsaw import-transcript <projectId> <file.srt|file.vtt> [--language xx]");
    const r = await importTranscript(svc, null, pos[0]!, { text: await readFile(pos[1]!, "utf8"), format: pos[1]!.toLowerCase().endsWith(".vtt") ? "vtt" : "auto", language: flag("language") });
    console.log(`${r.message}\n  ${r.format.toUpperCase()}: ${r.cues} cues, ${r.words} words${r.language ? `, language ${r.language}` : ""}`);
    for (const w of r.warnings) console.log(`  warning: ${w}`);
  },
  /** Title and settings without re-running anything. Same function as projects.update and the update_project tool. */
  async "update-project"(svc) {
    const usage = "usage: reelsaw update-project <projectId> [--title t] [--set key=value]… [--clear key]…";
    if (!pos[0]) throw new Error(usage);
    const { settings, clear } = settingsFlags(usage);
    const r = await updateProject(svc, null, pos[0], { title: flag("title"), settings, clear });
    console.log(r.changed.length ? `changed ${r.changed.join(", ")}${r.hint ? `. ${r.hint}` : ""}` : "nothing changed");
  },
  /** Hide or keep source text: `reelsaw source-text <projectId> <hide|keep|always>`. Same function as projects.setSourceText and the set_project_source_text tool. */
  async "source-text"(svc) {
    const mode = z.enum(["hide", "keep", "always"]).safeParse(pos[1]);
    if (!pos[0] || !mode.success) throw new Error("usage: reelsaw source-text <projectId> <hide|keep|always>");
    const r = await setProjectSourceText(svc, null, pos[0], mode.data);
    console.log(`source text ${mode.data}; ${r.rerendered} clip(s) queued to re-render${r.skipped ? `; ${r.skipped} still preparing or rendering keep the old text (re-render them when done)` : ""}`);
  },
  /** Project-wide caption style: `reelsaw update-style <projectId> [--set key=value]… [--keep-overrides] [--no-rerender]`. Same function as projects.updateStyle and the update_project_style tool. */
  async "update-style"(svc) {
    const usage = "usage: reelsaw update-style <projectId> [--set key=value]… [--keep-overrides] [--no-rerender]";
    if (!pos[0]) throw new Error(usage);
    const { settings } = settingsFlags(usage);
    const style = styleOverrideSchema.safeParse(settings);
    if (!style.success) throw new Error(`${style.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}\n${usage}`);
    if (!Object.keys(style.data).length) throw new Error(usage);
    const r = await updateProjectStyle(svc, null, pos[0], { style: style.data, keepOverrides: args.includes("--keep-overrides"), rerender: !args.includes("--no-rerender") });
    console.log(`changed ${Object.keys(style.data).join(", ")}; ${r.rerendered} clip(s) queued to re-render${r.skipped ? `; ${r.skipped} still preparing or rendering keep the old style (re-render them when done)` : ""}`);
  },
  /** Start a project from a link: `reelsaw create-project <url> [--user email|id] [--title t] [--set key=value]…`. Same function as projects.create and the create_project tool. */
  async "create-project"(svc) {
    const usage = "usage: reelsaw create-project <url> [--user <email|id>] [--title t] [--set key=value]…";
    if (!pos[0]) throw new Error(usage);
    const { settings } = settingsFlags(usage);
    const input = createProjectInputSchema.safeParse({ sourceUrl: pos[0], title: flag("title"), settings: Object.keys(settings).length ? settings : undefined });
    if (!input.success) throw new Error(input.error.issues.map((i) => `${i.path.join(".") || "url"}: ${i.message}`).join("; "));
    const user = await actingUser(svc, flag("user"));
    const p = await createProject(svc, user.id, input.data);
    console.log(`created ${p.id} "${p.title}" for ${user.email}; reelsaw status ${p.id} follows it`);
  },
  /** Resume a project from where it stopped: `reelsaw retry <projectId>`. Same function as projects.retry and the retry_project tool. */
  async retry(svc) {
    if (!pos[0]) throw new Error("usage: reelsaw retry <projectId>");
    const r = await retryOwnedProject(svc, null, pos[0]);
    console.log(`resumed ${pos[0]} at ${r.queue}`);
  },
  /** Pick clips again: `reelsaw reanalyze <projectId> [--set key=value]…`. Same function as projects.reanalyze and the reanalyze_project tool. */
  async reanalyze(svc) {
    const usage = "usage: reelsaw reanalyze <projectId> [--set key=value]…";
    if (!pos[0]) throw new Error(usage);
    const { settings } = settingsFlags(usage);
    const r = await reanalyzeProject(svc, null, pos[0], Object.keys(settings).length ? settings : undefined);
    console.log(`picking clips again: kept ${r.kept} (made or edited by hand), replaced ${r.replaced}; the replaced ones can be restored ${r.restorable}`);
  },
  /** Re-run refine steps: `reelsaw refine <projectId> [--steps entities,disfluency,scenes] [--vocabulary text]`. Same function as projects.refine and the refine_project tool. */
  async refine(svc) {
    const usage = "usage: reelsaw refine <projectId> [--steps entities,disfluency,scenes] [--vocabulary text]";
    if (!pos[0]) throw new Error(usage);
    const steps = (flag("steps") ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
      const step = REFINE_STEPS.find((x) => x === s);
      if (!step) throw new Error(`--steps takes ${REFINE_STEPS.join(", ")}\n${usage}`);
      return step;
    });
    const r = await refineProject(svc, null, pos[0], { steps: steps.length ? steps : undefined, vocabulary: flag("vocabulary") });
    console.log(`refining ${pos[0]}: ${r.steps.join(", ")}; clips re-render afterwards`);
  },
  /** Soft-delete a project: `reelsaw delete-project <projectId>`. Same function as projects.delete and the delete_project tool. */
  async "delete-project"(svc) {
    if (!pos[0]) throw new Error("usage: reelsaw delete-project <projectId> [--forget-decisions]");
    const r = await deleteOwnedProject(svc, null, pos[0], { forgetDecisions: args.includes("--forget-decisions") });
    console.log(r.changed ? r.message : `${pos[0]} was already deleted`);
  },
  /** The zip of rendered clips with platform metadata: `reelsaw export <projectId> [clipId…] --out file.zip`. Same preconditions as the Export button and the export_project tool. */
  async export(svc) {
    const usage = "usage: reelsaw export <projectId> [clipId…] --out <file.zip>";
    const [projectId, ...clipIds] = pos;
    const out = flag("out");
    if (!projectId || !out) throw new Error(usage);
    const plan = await exportPlan(svc, null, projectId, clipIds);
    const { createWriteStream } = await import("node:fs");
    const { pipeline } = await import("node:stream/promises");
    const { stream } = await createExportZip({ storage: svc.storage, paths: svc.paths, log: svc.log }, { project: plan.project, clips: plan.clips, language: plan.language, subset: plan.subset });
    await pipeline(stream, createWriteStream(out));
    console.log(`${out}: ${plan.rendered} clip(s)${plan.notRendered ? `; ${plan.notRendered} picked clip(s) are not rendered and were left out` : ""}`);
  },
  /** A new clip from a time range: `reelsaw create-clip <projectId> <startSec> <endSec> [--mode exact|ai]`. Same function as clips.create and the create_clip tool. */
  async "create-clip"(svc) {
    const usage = "usage: reelsaw create-clip <projectId> <startSec> <endSec> [--mode exact|ai]";
    const [projectId, start, end] = pos;
    if (!projectId || start === undefined || end === undefined) throw new Error(usage);
    const mode = flag("mode") ?? "exact";
    if (mode !== "exact" && mode !== "ai") throw new Error(`--mode is exact or ai\n${usage}`);
    const r = await createClip(svc, null, { projectId, startSec: seconds(start, "startSec"), endSec: seconds(end, "endSec"), mode });
    console.log(`created clip ${r.clip.id} (${formatTime(r.clip.startSec)}-${formatTime(r.clip.endSec)}); it is ${r.queued === "prepare" ? "being prepared and renders afterwards" : "queued"}`);
  },
  /** Edit one clip: `reelsaw update-clip <clipId> [--title t] [--hook t] [--caption t] [--start s] [--end s] [--rerender|--no-rerender]`. Same function as clips.update and the update_clip tool. */
  async "update-clip"(svc) {
    const usage = "usage: reelsaw update-clip <clipId> [--title t] [--hook t] [--caption t] [--start s] [--end s] [--rerender|--no-rerender]";
    if (!pos[0]) throw new Error(usage);
    const start = flag("start");
    const end = flag("end");
    const r = await updateClip(svc, null, {
      id: pos[0],
      title: flag("title"),
      hook: flag("hook"),
      caption: flag("caption"),
      startSec: start === undefined ? undefined : seconds(start, "--start"),
      endSec: end === undefined ? undefined : seconds(end, "--end"),
      rerender: args.includes("--no-rerender") ? false : args.includes("--rerender") ? true : undefined,
    });
    if (!r.changed.length) return void console.log("nothing changed");
    console.log(`changed ${r.changed.join(", ")}; ${!r.needsRerender ? "nothing burned into the video changed, no re-render needed" : r.rerendered ? "re-rendering" : "the video still shows the old version: reelsaw rerender " + pos[0]}`);
  },
  /** Remove deleted projects and replaced clips past DELETED_RETENTION_DAYS now (the storage sweep does this hourly). */
  async purge(svc) {
    const dry = args.includes("--dry-run");
    const r = await purgeDeleted(svc, { dryRun: dry });
    console.log(`${dry ? "would purge" : "purged"} ${r.projects.length} project(s) and ${r.clips.length} replaced clip(s) deleted over ${svc.config.DELETED_RETENTION_DAYS} days ago (DELETED_RETENTION_DAYS=${svc.config.DELETED_RETENTION_DAYS}; 0 keeps them)`);
  },
  /** Delete one already-deleted project forever: `reelsaw purge-project <projectId>`. Same as projects.purge and the purge_project tool. */
  async "purge-project"(svc) {
    if (!pos[0]) throw new Error("usage: reelsaw purge-project <projectId> [--forget-decisions]   (reelsaw deleted lists them; they must already be deleted)");
    const r = await purgeOwnedProject(svc, null, pos[0], { forgetDecisions: args.includes("--forget-decisions") });
    console.log(r.message);
  },
  /**
   * The decision log (docs/specs/decision-log.md), same service as Settings → Learning and the *_decisions tools:
   *   reelsaw decisions <email> [--kind fix.reject] [--project <id>] [--limit 50]
   *   reelsaw decisions export <email> [--out f.decisions.jsonl] [--since <iso>] [--kind <k>]   (JSON lines, for evals)
   *   reelsaw decisions forget <email> [--project <id>]
   *   reelsaw decisions learning <email> on|off   (Settings → Learning's switch, set_learning)
   *   reelsaw decisions backfill [--dry-run]    (decisions still held in transcripts, from before the log existed)
   */
  async decisions(svc) {
    const db = svc.database.db;
    const sub = ["export", "forget", "learning", "backfill"].includes(pos[0] ?? "") ? pos[0] : undefined;
    const usage = "usage: reelsaw decisions <email> | export <email> [--out f.jsonl] | forget <email> [--project id] | learning <email> on|off | backfill [--dry-run]";
    const kindArg = flag("kind");
    const kind = kindArg ? DECISION_KINDS.find((k) => k === kindArg) : undefined;
    if (kindArg && !kind) throw new Error(`--kind must be one of ${DECISION_KINDS.join(", ")}`);
    if (sub === "backfill") {
      const dry = args.includes("--dry-run");
      const r = await backfillDecisions(svc, { dryRun: dry });
      console.log(`${dry ? "would write" : "wrote"} ${r.decisions} decision(s) from ${r.projects} project(s)${r.complete ? "" : " (stopped early; run again to continue)"}; fixes already in the log were skipped`);
      return;
    }
    const email = sub ? pos[1] : pos[0];
    if (!email) throw new Error(usage);
    const u = await userByEmail(svc, email);
    if (sub === "learning") {
      const on = pos[2] === "on" ? true : pos[2] === "off" ? false : undefined;
      if (on === undefined) throw new Error("usage: reelsaw decisions learning <email> on|off");
      await svc.tx((tx) => setLearning(tx.db, u.id, on));
      console.log(`learning ${on ? "on" : "off"} for ${u.email}${on ? "" : " (decisions already kept stay; reelsaw decisions forget removes them)"}`);
      return;
    }
    if (sub === "forget") {
      const n = await svc.tx((tx) => forgetDecisions(tx.db, u.id, { projectId: flag("project") }));
      console.log(`forgot ${n} decision(s) of ${u.email}${flag("project") ? ` about ${flag("project")}` : ""}`);
      return;
    }
    if (sub === "export") {
      const out = flag("out");
      const since = flag("since");
      const lines: string[] = [];
      let cursor: number | undefined;
      let cases = 0;
      for (;;) {
        const page = await exportDecisions(db, u.id, { cursor, limit: EXPORT_MAX, since: since ? new Date(since) : undefined, kind });
        lines.push(...page.items.map((d) => JSON.stringify(d)));
        cases += page.cases.disfluency.length;
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      if (!out) {
        for (const l of lines) console.log(l);
        return;
      }
      await writeFile(out, lines.length ? lines.join("\n") + "\n" : "");
      console.log(`wrote ${lines.length} decision(s) of ${u.email} to ${out} (${cases} disfluency case(s)); harvest with src/eval/tools/harvest-decisions.ts, replay with EVAL_DECISIONS=${out} pnpm eval decisions`);
      return;
    }
    const s = await decisionSummary(db, u.id);
    console.log(`${u.email}: learning ${s.enabled ? "on" : "off"}; ${s.total} decision(s) about ${s.projects} project(s)${s.total ? ` (${Object.entries(s.byKind).map(([k, n]) => `${k} ${n}`).join(", ")})` : ""}`);
    const page = await listDecisions(db, u.id, { kind, projectId: flag("project"), limit: Number(flag("limit") ?? 50) || 50 });
    if (!page.items.length) return;
    const what = (d: (typeof page.items)[number]) => {
      const c = d.context;
      if (Array.isArray(c.words) && c.target && typeof c.target === "object" && "index" in c.target && "span" in c.target && typeof c.target.index === "number" && typeof c.target.span === "number") {
        return c.words.slice(c.target.index, c.target.index + c.target.span).map((w: { text?: string }) => w.text ?? "").join(" ").slice(0, 40);
      }
      return Array.isArray(c.fields) ? c.fields.join(",") : String(d.before?.title ?? d.after?.title ?? "").slice(0, 40);
    };
    table(page.items.map((d) => ({ id: d.id, at: d.createdAt.slice(0, 16), kind: d.kind, explicit: d.explicit ? "yes" : "no", project: d.projectId.slice(0, 8), what: what(d) })));
    if (page.nextCursor) console.log(`showing ${page.items.length} of ${page.total}; --limit raises it (max 200)`);
  },
  abuse: async (svc) => {
    if (args.includes("--run")) {
      const r = await flagAccounts(svc);
      console.log(`checked ${r.checked} recent accounts: ${r.flagged} flagged, ${r.changed} changed`);
    }
    const rows = await svc.database.db.select({ email: schema.user.email, flags: schema.user.flags, signupIp: schema.user.signupIp, banned: schema.user.banned, createdAt: schema.user.createdAt }).from(schema.user).where(sql`jsonb_array_length(${schema.user.flags}) > 0`).orderBy(desc(schema.user.createdAt)).limit(200);
    table(rows.map((r) => ({ email: r.email, flags: r.flags.join(","), signupIp: r.signupIp ?? "", status: r.banned ? "suspended" : "active", created: r.createdAt.toISOString().slice(0, 10) })));
    if (rows.length) console.log("\nflags: " + Object.entries(FLAG_HELP).map(([k, v]) => `${k} = ${v}`).join("; "));
  },
  billing: async (svc) => {
    if (!svc.ee) throw new Error("billing is not enabled on this instance (REELSAW_EE is off)");
    const b = svc.ee.billing;
    const sub = pos[0];
    if (sub === "sync") {
      const user = pos[1] ? await userByEmail(svc, pos[1]) : null;
      const r = await b.reconcile(user ? { userId: user.id } : {});
      console.log(`checked ${r.checked} subscription(s), synced ${r.synced}, pending events retried ${r.pendingEvents}${r.orphans.length ? `, orphans (no account): ${r.orphans.join(", ")}` : ""}`);
      return;
    }
    if (sub === "set-plan") {
      const user = await userByEmail(svc, pos[1]);
      const plan = pos[2];
      if (!plan) throw new Error("usage: reelsaw billing set-plan <email> <plan|none>");
      const r = await b.setComplimentary("cli", user.id, plan === "none" ? null : plan);
      console.log(r.plan ? `${user.email} now has ${r.plan} (complimentary)` : `${user.email}: complimentary plan removed`);
      return;
    }
    const user = await userByEmail(svc, sub);
    const i = await b.inspect(user.id);
    console.log(`${user.email}: ${i.effective.plan.label} (${i.effective.reason})`);
    console.log(`customer: ${i.customer ?? "none"}`);
    if (i.row) table([{ subscription: i.row.stripeSubscriptionId ?? "(complimentary)", plan: i.row.plan, status: i.row.status, interval: i.row.interval ?? "", periodEnd: i.row.periodEnd?.toISOString() ?? "", cancelAtPeriodEnd: i.row.cancelAtPeriodEnd, pastDueSince: i.row.pastDueSince?.toISOString() ?? "", syncedAt: i.row.syncedAt.toISOString() }]);
    else console.log("no subscription row (Free)");
    console.log("\nStripe:");
    table(i.stripe.map((s) => ({ id: s.id, status: s.status, price: s.price ?? "", cancelAtPeriodEnd: s.cancelAtPeriodEnd })));
    console.log("\nwebhook events:");
    table(i.events.map((e) => ({ id: e.id, type: e.type, created: e.created.toISOString(), processed: e.processedAt ? "yes" : "PENDING", error: e.error ?? "" })));
  },
  "make-admin": async (svc) => {
    const u = await userByEmail(svc, pos[0]);
    if (!u.approvedAt) await approveUser(svc, null, u.id);
    const r = await setUserRole(svc, null, u.id, "admin");
    console.log(r.changed ? `${u.email} is now an admin` : `${u.email} was already an admin`);
  },
  /**
   * Forgotten password on a box without email: hash a new secret (stdin, never argv), revoke
   * sessions, optionally require they pick their own at next sign-in (`--must-change`).
   */
  "set-password": async (svc) => {
    if (pos[1]) throw new Error("do not put the password on the command line; you will be prompted, or pipe it twice on stdin");
    const u = await userByEmail(svc, pos[0]);
    const mustChange = args.includes("--must-change");
    const password = await readSecret("New password: ");
    const confirm = await readSecret("Confirm password: ");
    if (password !== confirm) throw new Error("passwords did not match");
    await setUserPassword(svc, null, u.id, password, { mustChange });
    console.log(mustChange ? `password set for ${u.email}; they must choose a new one at next sign-in` : `password set for ${u.email}`);
  },
  /** Usage per account over the last --days (default 30); stored bytes are all time. */
  async usage(svc) {
    const days = Number(flag("days") ?? 30);
    const rows = await usageByUser(svc.database.db, Number.isFinite(days) && days > 0 ? days : 30);
    const emails = new Map((await svc.database.db.query.user.findMany({ columns: { id: true, email: true } })).map((u) => [u.id, u.email]));
    console.log(`last ${days} days${rows.length >= 500 ? " (first 500 accounts only)" : ""}`);
    table(
      rows.map((u) => ({
        email: emails.get(u.id) ?? u.id,
        projects: u.projects,
        "source min": u.sourceMinutes,
        clips: u.clipsRendered,
        "llm calls": u.llmCalls,
        "tokens in/out": `${Math.round(u.llmInputTokens / 1000)}k/${Math.round(u.llmOutputTokens / 1000)}k`,
        "llm $": u.llmCostUsd == null ? "-" : u.llmCostUsd.toFixed(2),
        "stt min": u.sttMinutes,
        stored: formatBytes(u.storedBytes),
      })),
    );
  },
  /**
   * What this box runs on and what the pipeline can use of it: CPUs, memory, disk, the GPU the process
   * sees, the ffmpeg encoder in use and why, and the execution provider of each on-device model. The
   * same facts as Settings → System → Overview; `--json` for scripts.
   */
  async machine(svc) {
    const r = await svc.resources.snapshot();
    const gpu = svc.resources.gpu();
    const enc = svc.media.encoder();
    const onDevice = { requested: svc.config.ONNX_EXECUTION_PROVIDER, faces: svc.faces?.provider ?? null, text: svc.text?.provider ?? null, vad: svc.vad ? "cpu" : null, aligner: svc.aligner?.provider ?? null };
    const renders = { ...svc.resources.renders(), max: svc.resources.maxRenders() };
    if (args.includes("--json")) return void console.log(JSON.stringify({ resources: r, gpu, videoEncoder: enc, onDevice, renders, models: svc.models.get(), ytdlpProxies: svc.media.ytdlpProxies() }, null, 2));
    const line = (k: string, v: string) => console.log(`${k.padEnd(16)} ${v}`);
    line("platform", `${r.platform} ${process.arch}, node ${process.version}`);
    line("cpu", `${r.cpus} cores, ${r.cpuPercent}% busy${r.load1 !== null ? `, load ${r.load1}` : ""}`);
    line("memory", `${r.memAvailableMB} MB free of ${r.memTotalMB} MB`);
    line("disk", r.diskFreeMB >= 0 ? `${r.diskFreeMB} MB free of ${r.diskTotalMB} MB` : "not measurable on this filesystem");
    line("gpu", gpu ? `${gpu.vendor}: ${gpu.devices.join(", ") || "device present, no driver tools"}\n${"".padEnd(17)}${gpu.note}` : "none visible to this process (Docker: start with docker-compose.gpu.yml to hand an NVIDIA card over)");
    line("video encoder", `${enc.name} (FFMPEG_ENCODER=${enc.requested}): ${enc.reason}`);
    line("renders", renders.mode === "auto" ? `${renders.running} running, up to ${renders.max} (RENDER_CONCURRENCY=auto)` : `${renders.running} running, fixed ${renders.max}`);
    line("on-device", `ONNX_EXECUTION_PROVIDER=${onDevice.requested}; faces ${onDevice.faces ?? "off"}, text ${onDevice.text ?? "off"}, alignment ${onDevice.aligner ?? "off"}, vad ${onDevice.vad ?? "off"} (the vad is always cpu)`);
    line("models", `${svc.models.get().language}, ${svc.models.get().transcription}${svc.models.get().align ? `, align ${svc.models.get().align}` : ""}`);
    const proxies = svc.media.ytdlpProxies();
    line("ytdlp proxies", proxies.candidates.length ? `${proxies.candidates.map((c) => `${c.id} p${c.priority}`).join(", ")}${proxies.next ? ` (next ${proxies.next})` : ""}` : "this server's IP (set YTDLP_PROXY)");
    console.log("\nSpeech-to-text and the language model run in their own containers: Speaches uses the GPU with SPEACHES_IMAGE=ghcr.io/speaches-ai/speaches:latest-cuda, Ollama when its container has the device (docker-compose.gpu.yml).");
  },
  /**
   * Operator-ranked yt-dlp egress candidates and the circuit breaker on each. Priority is what you
   * set; the circuit is runtime reliability and never changes the ranking among healthy candidates.
   * URLs (and passwords) are not printed. `--json` for scripts.
   */
  async "ytdlp-proxies"(svc) {
    const snap = svc.media.ytdlpProxies();
    if (args.includes("--json")) return void console.log(JSON.stringify(snap, null, 2));
    if (!snap.candidates.length) return void console.log("none: yt-dlp uses this server's IP. Set YTDLP_PROXY.");
    console.log(`next  ${snap.next ?? "-"}`);
    table(snap.candidates.map((c) => ({
      id: c.id,
      host: c.host,
      priority: c.priority,
      circuit: c.circuit,
      inflight: c.concurrency ? `${c.inFlight}/${c.concurrency}` : c.inFlight,
      ok: c.successes,
      faults: c.faults,
      rate: c.successRate === null ? "-" : `${Math.round(c.successRate * 100)}%`,
    })));
  },
  /**
   * Every process that has checked in (API, worker, combined app): specs and what it last reported
   * it was processing. Same as Settings → System → Workers; `--json` for scripts.
   */
  async workers(svc) {
    const { items, live, stale } = await listWorkers(svc);
    if (args.includes("--json")) return void console.log(JSON.stringify({ items, live, stale }, null, 2));
    if (!items.length) return console.log("no processes have checked in yet (the app and worker containers report every 15 s)");
    console.log(`${live} online${stale ? `, ${stale} last seen over 45s ago` : ""}`);
    const ago = (s: number) => (s < 5 ? "now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`);
    const gpu = (w: (typeof items)[number]) => (w.gpu ? `${w.gpu.vendor}${w.gpu.devices[0] ? ` ${w.gpu.devices[0]}` : ""}` : "none");
    const jobs = (w: (typeof items)[number]) =>
      w.processing.length ? w.processing.map((p) => `${p.queue}${p.title ? ` ${p.title}` : ` ${p.projectId.slice(0, 8)}`}`).join(", ") : "idle";
    table(
      items.map((w) => ({
        id: w.id,
        role: w.role,
        status: w.live ? "online" : `gone ${ago(w.lastSeenAgoSec)}`,
        cpus: w.cpus,
        mem: `${w.memTotalMB} MB`,
        disk: w.diskFreeMB < 0 ? "n/a" : `${w.diskFreeMB} MB free of ${w.diskTotalMB} MB${w.diskLeasedMB ? `, ${w.diskLeasedMB} MB leased to jobs in flight` : ""}`,
        gpu: gpu(w),
        renders: `${w.renders.running}/${w.renders.max}`,
        processing: jobs(w),
      })),
    );
  },
  /**
   * Waiting / running / retrying jobs per stage from pg-boss, plus the jobs in flight.
   * Same as Settings → System → Queue; `--json` for scripts.
   */
  async queue(svc) {
    const q = await summarizeQueue(svc);
    const failed = await listFailures(svc, { limit: 50 });
    if (args.includes("--json")) return void console.log(JSON.stringify({ ...q, failures: failed }, null, 2));
    if (q.error) console.log(`queue tables: ${q.error}`);
    table(q.queues.map((r) => ({ stage: r.label, waiting: r.waiting, running: r.running, retrying: r.retrying, failed: r.failed })));
    if (q.active.length) {
      console.log(q.truncated ? `\nin flight (showing ${q.active.length}; more exist)` : "\nin flight");
      table(
        q.active.map((j) => ({
          stage: j.label,
          state: j.state,
          project: j.title ?? j.projectId?.slice(0, 8) ?? "—",
          attempt: j.attempt,
          since: j.startedAt ?? j.createdAt,
        })),
      );
    } else console.log("\nnothing in flight");
    if (!failed.items.length) return console.log("\nno failed projects or clips");
    console.log(`\nfailed work: showing ${failed.items.length} of ${failed.total}${failed.truncated ? "+" : ""}${failed.nextCursor ? " (more pages)" : ""}`);
    table(
      failed.items.map((f) => ({
        kind: f.kind,
        stage: f.stage,
        owner: f.ownerEmail,
        title: f.title,
        reason: f.snippet,
        when: f.failedAt,
      })),
    );
  },
  /**
   * One failed project or clip with the full recorded reason. Same as opening a row under
   * Settings → System → Queue → Failed work. Tries project id first, then clip id.
   */
  async failure(svc) {
    if (!pos[0]) throw new Error("usage: reelsaw failure <projectId|clipId>");
    const item = (await getFailure(svc, "project", pos[0])) ?? (await getFailure(svc, "clip", pos[0]));
    if (args.includes("--json")) return void console.log(JSON.stringify(item, null, 2));
    if (!item) return console.log("not a failed project or clip (or the clip's project already failed — retry the project)");
    console.log(`${item.kind}  ${item.title}${item.kind === "clip" ? `  (${item.projectTitle})` : ""}`);
    console.log(`owner   ${item.ownerEmail}`);
    console.log(`stage   ${item.stage}`);
    console.log(`when    ${item.failedAt}`);
    console.log(`id      ${item.id}`);
    console.log(`\n${item.error ?? "(no reason recorded)"}`);
  },
  /**
   * Retry failed projects and clips that match `--stage` / `--q` / `--since`. Same path as the owner's
   * Retry button. Cap 50 per call; run again if it prints a next page.
   */
  async ["retry-failures"](svc) {
    const stageArg = flag("stage");
    if (stageArg && !(FAILURE_STAGES as readonly string[]).includes(stageArg)) {
      throw new Error(`usage: reelsaw retry-failures [--stage ${FAILURE_STAGES.join("|")}] [--q text] [--since 24h|ISO] [--json]`);
    }
    const sinceArg = flag("since");
    let since: string | undefined;
    if (sinceArg) {
      const ms = parseDuration(sinceArg);
      since = ms !== undefined ? new Date(Date.now() - ms).toISOString() : new Date(sinceArg).toISOString();
      if (Number.isNaN(Date.parse(since))) throw new Error("--since takes a duration like 24h or an ISO timestamp");
    }
    const filter = { q: flag("q"), stage: stageArg as FailureStage | undefined, since };
    const r = await retryFailures(svc, filter, null);
    if (args.includes("--json")) return void console.log(JSON.stringify(r, null, 2));
    console.log(`retried ${r.retried}, skipped ${r.skipped}${r.nextCursor ? " (more match; run again)" : ""}`);
  },
  /** One account's quotas (0 = unlimited) and watermark. Change them in Users → Limits, or `--watermark always|never|follow`. */
  async limits(svc) {
    const u = await userByEmail(svc, pos[0]);
    const wmArg = flag("watermark");
    if (wmArg !== undefined) {
      const parsed = wmArg === "always" || wmArg === "on" ? true : wmArg === "never" || wmArg === "off" ? false : wmArg === "follow" || wmArg === "default" ? null : undefined;
      if (parsed === undefined) throw new Error("usage: reelsaw limits <email> [--watermark always|never|follow]");
      await setUserWatermark(svc, null, u.id, parsed);
      console.log(`watermark ${parsed === true ? "always" : parsed === false ? "never" : "follow"} for ${u.email}; next render uses it`);
    }
    const row = await svc.database.db.query.userSettings.findFirst({ where: eq(schema.userSettings.userId, u.id), columns: { limits: true, watermark: true } });
    const [effective, used, wm] = await Promise.all([limitsFor(svc.database.db, svc.settings.get(), u.id, svc.entitlements), limitUsage(svc.database.db, u.id), watermarkFor(svc.database.db, svc.settings.get(), u, svc.entitlements)]);
    table(LIMIT_KEYS.map((k) => ({ limit: k, instance: svc.settings.get()[k], override: row?.limits?.[k] ?? "-", "in force": effective[k] || "unlimited", "in use": used[k] })));
    const override = row?.watermark === true ? "always" : row?.watermark === false ? "never" : "follow";
    console.log(`watermark next render: ${wm.on ? "on" : "off"} (${override === "follow" ? wm.source : `override ${override}`})`);
  },
  /**
   * Instance settings in force and where each comes from. `settings SIGNUP_MODE=approval MAX_UPLOAD_MB=2048`
   * changes them (validated as a whole, applied by every process within ~5 s); `--clear KEY` returns a key to .env.
   */
  async settings(svc) {
    const sets = pos.filter((a) => a.includes("="));
    const clears = args.flatMap((a, i) => (a === "--clear" && args[i + 1] ? [args[i + 1]!] : []));
    if (sets.length || clears.length) {
      const coerce = (v: string) => (v === "true" ? true : v === "false" ? false : /^-?\d+$/.test(v) ? Number(v) : v);
      const patch: Record<string, unknown> = {};
      for (const kv of sets) {
        const i = kv.indexOf("=");
        patch[kv.slice(0, i)] = coerce(kv.slice(i + 1));
      }
      for (const k of clears) patch[k] = null;
      const parsed = settingsPatchSchema.strict().safeParse(patch);
      if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("\n"));
      try {
        await svc.settings.set(parsed.data, { id: "cli", email: "cli" });
        console.log(`saved ${[...sets.map((s) => s.split("=")[0]), ...clears.map((k) => `${k} (back to .env)`)].join(", ")}; every process applies it within ~5 s`);
      } catch (err) {
        if (err instanceof SettingsError) throw new Error(err.message);
        throw err;
      }
    }
    const st = svc.settings.state();
    const fmt = (v: unknown) => (v === null || v === undefined || v === "" ? "-" : String(v));
    table(RUNTIME_KEYS.map((k) => ({ setting: k, "in force": fmt(st.values[k]), source: st.source[k] === "db" ? `set by ${st.updatedBy ?? "?"}` : ".env", ".env": fmt(st.env[k]), note: st.ignored[k] ?? "" })));
  },
  async status(svc) {
    const db = svc.database.db;
    const id = pos[0]!;
    const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, id) });
    if (!p) throw new Error("project not found");
    console.log(`${p.title}\n  status=${p.status} stage=${p.stage ?? "-"} progress=${p.stageProgress ?? "-"} duration=${p.durationSec ? formatTime(p.durationSec) : "-"}`);
    if (p.stageDetail) console.log(`  parts: ${p.stageDetail.done} of ${p.stageDetail.total}${p.stageDetail.etaSec !== null ? `, about ${formatTime(p.stageDetail.etaSec)} left` : ""}`);
    if (p.error) console.log(`  error: ${p.error}`);
    if (p.deletedAt) console.log(`  DELETED ${p.deletedAt.toISOString()} (reelsaw restore ${p.id})`);
    const ev = await svc.database.pool.query<{ total: string; progress: string }>(`select count(*) as total, count(*) filter (where type = 'stage.progress') as progress from project_events where project_id = $1`, [id]);
    console.log(`  events: ${ev.rows[0]!.total} stored (progress ticks are live-only and never stored; ${ev.rows[0]!.progress} refine step updates; EVENT_RETENTION_DAYS=${svc.settings.get().EVENT_RETENTION_DAYS})`);
    const t = await db.query.transcripts.findFirst({ where: eq(schema.transcripts.projectId, id), columns: { refine: true, flags: true, language: true } });
    if (t) console.log(`  transcript: lang=${t.language} flags=${t.flags.length} refine=${JSON.stringify(t.refine)}`);
    const clips = await db.query.clips.findMany({ where: eq(schema.clips.projectId, id), orderBy: [schema.clips.index, schema.clips.createdAt, schema.clips.id] });
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
    table((layoutSegments ?? []).map((s) => ({ range: `${s.start}-${s.end}`, layout: s.layout, manual: s.manual, cx: s.cx, offsets: offsetsLabel(s), subject: subjectLabel(s), reason: s.reason })));
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
    const project = await svc.database.db.query.projects.findFirst({ where: eq(schema.projects.id, c.projectId) });
    // exactly what a render feeds the layout: static faces dropped, the per-clip text scan (2 fps) attached
    // to the nearest face sample, the divider probe (`divider.s` is its strength, 0..1) and the webcam tile
    // rectangles (`tiles`) from the same frames
    let samples = dropStaticFaces(await sampleFaces(svc.faces, { ffmpegPath: svc.config.FFMPEG_PATH, source, startSec: c.startSec + from, durationSec: to - from, sampleFps: 4, srcAspect: (project?.width ?? 1920) / (project?.height ?? 1080) })).samples;
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

  async report(svc) {
    const { createWriteStream } = await import("node:fs");
    const { pipeline } = await import("node:stream/promises");
    const projectId = pos[0] ?? null;
    const instance = args.includes("--instance");
    const description = flag("description") ?? "CLI report";
    const db = svc.database.db;
    let user;
    if (flag("user")) user = await userByEmail(svc, flag("user")!);
    else if (projectId) {
      const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, projectId), columns: { userId: true } });
      if (!p) throw new Error("project not found");
      user = await db.query.user.findFirst({ where: eq(schema.user.id, p.userId) });
    } else {
      const admins = instance ? await db.query.user.findMany({ where: eq(schema.user.role, "admin"), limit: 1 }) : [];
      const all = admins.length ? admins : await db.query.user.findMany({ limit: 2 });
      if (all.length !== 1 && !instance) throw new Error("this install has several accounts: pass --user <email> or a project id");
      user = all[0];
    }
    if (!user) throw new Error("no account");
    // docker exec is operator access: --instance is always allowed
    const actor = instance ? { id: user.id, role: "admin" as const } : { id: user.id, role: user.role };
    const zip = await createReportZip(svc, actor, projectId, {
      description,
      clipIds: [],
      include: { logs: true, system: true, instance, previews: false, allClips: false, source: false },
      client: { route: "cli" },
    });
    if (!zip) throw new Error("could not build the report (no such project, or zip reports are disabled on this instance)");
    const dest = flag("out") ?? `${svc.paths.tmp}/${zip.filename}`;
    await pipeline(zip.stream, createWriteStream(dest));
    console.log(dest);
  },

  /** The same two paths as the buttons: clips.rerenderMany for finished / failed clips, clips.rerender (prepare first) for one that was never prepared. */
  async rerender(svc) {
    const db = svc.database.db;
    if (!pos.length) throw new Error("usage: reelsaw rerender <clipId…>");
    const rows = [];
    for (const id of new Set(pos)) rows.push(await readClip(db, null, id));
    const unprepared = rows.filter((c) => !c.deletedAt && needsPrepare(c));
    for (const c of unprepared) {
      const r = await rerenderClip(svc, null, c.id);
      console.log(`clip ${c.id.slice(0, 8)} was never prepared: queued ${r.step} (it renders afterwards)`);
    }
    for (const projectId of new Set(rows.filter((c) => !unprepared.includes(c)).map((c) => c.projectId))) {
      const r = await rerenderClips(svc, null, { projectId, clipIds: rows.filter((c) => c.projectId === projectId && !unprepared.includes(c)).map((c) => c.id) });
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
      console.log(`${dry ? "would purge" : "purged"} ${gone.length} library asset(s) (removed over 30 days ago, or shared and unused) and used nowhere`);
      const del = await purgeDeleted(svc, { dryRun: dry });
      console.log(`${dry ? "would purge" : "purged"} ${del.projects.length} deleted project(s) and ${del.clips.length} replaced clip(s) (DELETED_RETENTION_DAYS=${svc.config.DELETED_RETENTION_DAYS})`);
      return;
    }
    if (pos[0] === "reclaim") {
      // what a job short of disk does on its own: evict the least recently used scratch copies until this many MB are freed
      const mb = Number(pos[1] ?? 0);
      if (!Number.isFinite(mb) || mb <= 0) throw new Error("usage: reelsaw storage reclaim <MB> [--dry-run]");
      const dry = args.includes("--dry-run");
      const r = await reclaimScratch(svc, mb * 1048576, { dryRun: dry });
      table(r.removals.map((x) => ({ kind: x.kind, path: x.path, size: formatBytes(x.bytes), project: x.projectId?.slice(0, 8) ?? "", clip: x.clipId?.slice(0, 8) ?? "" })));
      console.log(`${dry ? "would evict" : "evicted"} ${r.removals.length} file(s), ${formatBytes(r.bytes)}${r.enough ? "" : " (not enough: nothing else is evictable)"}`);
      if (svc.storage.driver !== "s3") console.log("the local store hardlinks scratch and store: nothing to evict (set SOURCE_RETENTION_DAYS / CLIP_RETENTION_DAYS to free disk)");
      return;
    }
    const r = await storageReport(svc);
    console.log(`unique bytes under DATA_DIR (hardlinks counted once)  ${formatBytes(r.uniqueBytes)}`);
    console.log(`scratch-only leftovers (sweep would remove)          ${formatBytes(r.scratchOrphanBytes)} in ${r.scratchOrphanFiles} file(s)`);
    console.log(
      r.cacheIdleHours === null
        ? `scratch copies of stored files                       not evictable (${svc.storage.driver === "s3" ? "SCRATCH_CACHE_HOURS=0" : "local store: scratch and store are one file"})`
        : `scratch copies of stored files (S3 has them)         ${formatBytes(r.cacheBytes)} in ${r.cacheFiles} file(s); evicted after ${r.cacheIdleHours}h idle (SCRATCH_CACHE_HOURS), sooner when a job is short of disk`,
    );
    console.log(`leased to jobs in flight on this volume              ${r.leasedMB} MB by ${r.leasedJobs} job(s) (claimed before the bytes land; free space minus this is what a new job may take)`);
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
    const id = pos[0];
    if (!id) throw new Error("usage: reelsaw recover <clipId|projectId>");
    const c = await db.query.clips.findFirst({ where: eq(schema.clips.id, id), columns: { id: true } });
    if (c) {
      const r = await rerenderClip(svc, null, c.id);
      return console.log(r.step === "prepare" ? `clip ${c.id.slice(0, 8)} was never prepared: queued clip.prepare (renders afterwards)` : `queued render for clip ${c.id.slice(0, 8)}`);
    }
    const p = await db.query.projects.findFirst({ where: eq(schema.projects.id, id) });
    if (!p) throw new Error("no clip or project with that id");
    // a failed project is resumed the way the Retry button does it; anything else only needs its lost jobs put back
    if (p.status === "failed" && !p.deletedAt) {
      const r = await retryOwnedProject(svc, null, p.id);
      return console.log(`project ${p.id.slice(0, 8)} failed: resumed at ${r.queue}`);
    }
    const r = await reconcile(svc);
    console.log(`reconciled: re-enqueued ${r.requeued} job(s) (project status ${p.status}${p.deletedAt ? ", deleted" : ""})`);
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

  /** The library (intro/outro videos and images, logos, stickers, sounds). Same tRPC procedures as the web app and the MCP tools, called as the resolved user. */
  async library(svc) {
    const o = bumperArgs();
    const [sub, a, b] = o.pos;
    const usage = "usage: reelsaw library list [--kind video|image|audio] [--q text] | search <q…> [--source library|catalog|<provider>] [--kind k] [--license cc0|by] | add <file|url|provider:externalId> [--name n] [--tags a,b] [--color #hex] | update <id> --tags a,b | rename <id> <name…> | delete <id> | restore <id> | purge <id> | usage <id> | default <intro|outro> <id|none> | reindex   [--user <email>]";
    if (sub === "reindex") {
      const r = await backfillAssetRefs(svc, { all: true });
      console.log(`reindexed ${r.projects} project(s), ${r.clips} clip(s), ${r.refs} reference(s)`);
      return;
    }
    const { api, user } = await bumperApi(svc, undefined);
    const tagList = o.tags === undefined ? undefined : o.tags.split(",").map((t) => t.trim()).filter(Boolean);
    if (sub === "list") {
      const lib = await libraryView(svc, api, user.id);
      const q = o.q?.toLowerCase();
      const keep = (x: (typeof lib.assets)[number]) => (!o.kind || x.kind === o.kind) && (!q || x.name.toLowerCase().includes(q) || x.tags.some((t) => t.includes(q)));
      const row = (x: (typeof lib.assets)[number]) => ({ id: x.id, name: x.name, kind: x.kind, type: x.mime ?? "", owner: x.owner, tags: x.tags.join(","), sec: x.durationSec, size: `${x.width}x${x.height}`, default: [x.isDefaultIntro && "intro", x.isDefaultOutro && "outro"].filter(Boolean).join("+"), usedBy: x.usedBy, clips: x.usedByClips, templates: x.usedByTemplates });
      table(lib.assets.filter(keep).map(row));
      const removed = lib.deleted.filter(keep);
      if (removed.length) {
        console.log("\nremoved (restorable for 30 days)");
        table(removed.map(row));
      }
    } else if (sub === "add" && a) {
      // a link, a file on this machine, or a search hit written provider:externalId (e.g. freesound:12345)
      const hit = !/^https?:\/\//i.test(a) && !fsSync.existsSync(a) ? /^([a-z][a-z0-9_-]*):(.+)$/i.exec(a) : null;
      const common = { ...(o.name ? { name: o.name } : {}), ...(tagList ? { tags: tagList } : {}) };
      const r = hit
        ? await api.library.add({ provider: hit[1]!, externalId: hit[2]!, ...(o.color ? { color: o.color } : {}), ...(tagList ? { tags: tagList } : {}) })
        : await api.library.add({ ...common, ...(/^https?:\/\//i.test(a) ? { url: a } : { uploadId: (await uploadLocalFile(svc, user.id, a)).uploadId }) });
      console.log(`${r.duplicate ? (r.restored ? "restored existing" : "already exists") : "added"} ${r.id}  ${r.name}  (${r.kind})`);
    } else if (sub === "usage" && a) {
      const u = await api.library.usage({ id: a });
      if (!u.projects.length && !u.templates.length) console.log("(not used)");
      for (const p of u.projects) {
        console.log(`${p.title}  ${p.id}  project slots: ${p.slots.join(",") || "-"}`);
        for (const c of p.clips) console.log(`  clip #${c.index + 1} ${c.id.slice(0, 8)} ${c.title}  ${c.slots.map((s) => (s === "overlay" && c.overlays > 1 ? `overlay×${c.overlays}` : s === "music" && c.music > 1 ? `music×${c.music}` : s)).join(",")} via ${c.via}`);
      }
      for (const t of u.templates) console.log(`template ${t.name}  ${t.id}  (${t.layers} layer(s))`);
    } else if (sub === "default" && (a === "intro" || a === "outro") && b) {
      await api.library.setDefault({ slot: a, assetId: b === "none" ? null : b });
      console.log(b === "none" ? `cleared default ${a}` : `default ${a} is now ${b}`);
    } else if (sub === "rename" && a && b) {
      const r = await api.library.update({ id: a, name: o.pos.slice(2).join(" ") });
      console.log(`renamed ${a}: ${r.previousName} → ${r.name}`);
    } else if (sub === "update" && a && tagList) {
      const r = await api.library.update({ id: a, tags: tagList });
      console.log(`updated ${a}: tags ${r.tags.join(",") || "-"}`);
    } else if (sub === "delete" && a) {
      await api.library.delete({ id: a });
      console.log(`deleted ${a} (restore with: reelsaw library restore ${a})`);
    } else if (sub === "restore" && a) {
      await api.library.restore({ id: a });
      console.log(`restored ${a}`);
    } else if (sub === "purge" && a) {
      const r = await api.library.purge({ id: a });
      console.log(r.message);
    } else if (sub === "search" && a) {
      // your library, the Reelsaw catalog (default) or an enabled provider: the same procedure as the Browse panel and search_assets
      const kind = o.kind as "video" | "image" | "audio" | undefined;
      const r = await api.library.search({ source: o.source, q: o.pos.slice(1).join(" "), kind, license: o.license as "cc0" | "by" | undefined, limit: 24 });
      if (r.unavailable) console.log(r.unavailable);
      table(r.items.map((i) => ({ provider: i.provider, externalId: i.externalId, kind: i.kind, name: i.name, license: i.license.name, sec: i.durationSec ?? "", attribution: i.attribution ?? "" })));
      if (r.nextCursor) console.log(`more results exist: narrow the query (the web Browse panel pages through them)`);
    } else throw new Error(usage);
  },
  /** The Reelsaw catalog manifest: what is in force, and a refresh from CATALOG_URL. */
  async catalog(svc) {
    const sub = pos[0];
    const { catalog, registry } = libraryProviders(svc);
    if (sub !== "status" && sub !== "refresh") throw new Error("usage: reelsaw catalog status|refresh");
    const st = sub === "refresh" ? (await catalog.refresh({ force: true })).status : await catalog.status();
    console.log(`catalog v${st.version} (${st.items} items, ${st.source}; bundled v${st.bundledVersion}) generated ${st.generatedAt}`);
    console.log(`source ${st.url}  etag ${st.etag ?? "-"}  last checked ${st.lastCheckedAt ?? "never"}${st.lastError ? `  last error: ${st.lastError}` : ""}`);
    console.log(`providers: ${registry.list().map((p) => `${p.id}${p.available ? "" : " (rate limited)"}`).join(", ")}`);
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
  async "clip-layers"(svc) {
    const { pos: p, rerender, set, add, addText, addSound, remove, clear, from, to, x, y, w, size, color, box, font, opacity, volume, offset, fade, duck, noDuck, loop, noLoop } = bumperArgs();
    const usage =
      "usage: reelsaw clip-layers <projectId> <clipId> [--set '<json array>' | --add <assetId> --from <sec> --to <sec> [--x f] [--y f] [--w f] [--opacity f] [--loop|--no-loop] | --add-text <text> --from <sec> --to <sec> [--x f] [--y f] [--size f] [--color #RRGGBB] [--font <family>] [--box] [--opacity f] | --add-sound <assetId> --from <sec> --to <sec> [--volume 0-1] [--offset <sec>] [--fade <sec>] [--duck|--no-duck] [--loop|--no-loop] | --remove <layerId> | --clear] [--rerender]";
    if (p.length < 2) throw new Error(usage);
    const { api, user } = await bumperApi(svc, p[0]);
    const clip = await svc.database.db.query.clips.findFirst({ where: and(eq(schema.clips.id, p[1]!), eq(schema.clips.projectId, p[0]!)), columns: { id: true, startSec: true, endSec: true, layers: true, overlays: true, audio: true } });
    if (!clip) throw new Error("clip not found in this project");
    const current = clipLayers(clip);
    const modes = [set !== undefined, add !== undefined, addText !== undefined, addSound !== undefined, remove !== undefined, clear].filter(Boolean).length;
    if (modes > 1) throw new Error(`pick one of --set, --add, --add-text, --add-sound, --remove, --clear\n${usage}`);
    const fail = (issues: { path: PropertyKey[]; message: string }[]) => new Error(issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    const newId = () => `ly-${Math.random().toString(36).slice(2, 6).padEnd(4, "0")}`;
    let next: ClipLayer[] = current;
    if (set !== undefined) {
      const parsed = z.array(clipLayerSchema).safeParse(JSON.parse(set));
      if (!parsed.success) throw new Error(`--set needs a JSON array of layers: ${fail(parsed.error.issues).message}`);
      next = parsed.data;
    } else if (add !== undefined || addText !== undefined) {
      if (from === undefined || to === undefined) throw new Error(`--add / --add-text need --from and --to\n${usage}`);
      const common = { id: newId(), start: from, end: to, x: x ?? 0.5, y: y ?? 0.5, ...(opacity !== undefined ? { opacity } : {}) };
      const parsed = clipLayerSchema.safeParse(
        addText !== undefined
          ? { ...common, kind: "text", text: addText, ...(size !== undefined ? { size } : {}), ...(color ? { color } : {}), ...(box ? { box: true } : {}), ...(font ? { font } : {}) }
          : { ...common, kind: "asset", assetId: add, w: w ?? ASSET_OVERLAY_DEFAULT_W, ...(loop ? { loop: true } : noLoop ? { loop: false } : {}) },
      );
      if (!parsed.success) throw fail(parsed.error.issues);
      next = [...current, parsed.data];
    } else if (addSound !== undefined) {
      if (from === undefined) throw new Error(`--add-sound needs --from (and --to; a sound effect defaults to its own length)\n${usage}`);
      const asset = await svc.database.db.query.assets.findFirst({ where: and(eq(schema.assets.id, addSound), assetVisibleTo(user.id)), columns: { kind: true, durationSec: true } });
      if (!asset) throw new Error(`no library item ${addSound}`);
      if (asset.kind !== "audio") throw new Error(`${addSound} is a ${asset.kind}, not a sound: use --add`);
      // a short file is a one-shot at full level; anything else is music (ducked, faded, looped)
      const defaults = audioLayerDefaultsFor(asset);
      const sfx = defaults === SFX_AUDIO_DEFAULTS;
      const end = to ?? (sfx ? Math.min(clip.endSec, from + asset.durationSec) : clip.endSec);
      const parsed = clipLayerSchema.safeParse({
        id: newId(),
        kind: "audio",
        assetId: addSound,
        start: from,
        end,
        ...defaults,
        ...(volume !== undefined ? { volume } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(fade !== undefined ? { fade } : {}),
        ...(noDuck ? { duck: false } : duck ? { duck: true } : {}),
        ...(noLoop ? { loop: false } : loop ? { loop: true } : {}),
      });
      if (!parsed.success) throw fail(parsed.error.issues);
      next = [...current, parsed.data];
    } else if (remove !== undefined) {
      next = current.filter((l) => l.id !== remove);
      if (next.length === current.length) throw new Error(`no layer ${remove} on this clip`);
    } else if (clear) next = [];
    if (modes) await api.clips.update({ id: clip.id, layers: next, rerender });
    const shown = modes ? clipLayers((await svc.database.db.query.clips.findFirst({ where: eq(schema.clips.id, clip.id), columns: { layers: true, overlays: true, audio: true } })) ?? {}) : next;
    if (!shown.length) console.log("no layers on this clip");
    else
      table(
        shown.map((l) => ({
          id: l.id,
          kind: l.kind,
          what: l.kind === "text" ? `“${l.text}”` : l.assetId,
          source: `${l.start}-${l.end}`,
          position: l.kind === "audio" ? "" : `${l.x ?? 0.5},${l.y ?? 0.5}${l.kind === "asset" ? ` w ${l.w ?? ASSET_OVERLAY_DEFAULT_W}` : ` size ${l.size ?? TEXT_OVERLAY_DEFAULTS.size}${l.box ? " box" : ""}`}`,
          sound: l.kind === "audio" ? `vol ${l.volume ?? CLIP_AUDIO_DEFAULTS.volume} duck ${l.duck ?? CLIP_AUDIO_DEFAULTS.duck} fade ${l.fade ?? CLIP_AUDIO_DEFAULTS.fade} loop ${l.loop ?? CLIP_AUDIO_DEFAULTS.loop}${l.offset ? ` offset ${l.offset}` : ""}` : "",
        })),
      );
    if (!modes) return;
    console.log(rerender ? "re-render requested" : "saved; no re-render requested (pass --rerender to apply now)");
  },

  /** One clip's framing for the whole project. Same procedure as the editor's "Use for all clips" and the apply_framing tool. */
  async "apply-framing"(svc) {
    const usage = "usage: reelsaw apply-framing <clipId> [--at <sec>] [--keep-overrides] [--no-rerender]   [--user <email>]";
    if (!pos[0]) throw new Error(usage);
    const c = await svc.database.db.query.clips.findFirst({ where: eq(schema.clips.id, pos[0]), columns: { id: true, projectId: true, startSec: true, layoutSections: true, layoutOverride: true } });
    if (!c) throw new Error("clip not found");
    const at = flag("at") !== undefined ? Number(flag("at")) : undefined;
    if (at !== undefined && !Number.isFinite(at)) throw new Error(`--at needs seconds\n${usage}`);
    const { api } = await bumperApi(svc, c.projectId);
    const t = framingOfClip(c, at);
    const r = await api.projects.applyFraming({ id: c.projectId, ...t, keepOverrides: args.includes("--keep-overrides"), rerender: !args.includes("--no-rerender") });
    console.log(`${c.projectId}: framing ${r.reframe}${r.adjust ? ` ${JSON.stringify(r.adjust)}` : ""}; ${r.cleared} clip(s) lost their own sections; queued ${r.rerendered} render(s)`);
  },

  async templates(svc) {
    const { pos: p, rerender, addMode, layers } = bumperArgs();
    const usage =
      "usage: reelsaw templates list | show <id> | save <projectId> <clipId> <name…> | rename <id> <name…> | set <id> --layers '<json array>' | delete <id> | restore <id> | purge <id> | apply <templateId> <projectId> [clipId…] [--add] [--rerender]   [--user <email>]";
    const [sub, a, b] = p;
    if (!sub) throw new Error(usage);
    const { api } = await bumperApi(svc, sub === "save" ? a : sub === "apply" ? b : undefined);
    const show = (t: { id: string; name: string; layerCount: number }) => console.log(`${t.id}  ${t.name}  (${t.layerCount} layer(s))`);
    if (sub === "list") {
      const r = await api.layerTemplates.list({ limit: 500 });
      if (!r.items.length) console.log("no layer templates");
      else table(r.items.map((t) => ({ id: t.id, name: t.name, layers: t.layerCount, updated: t.updatedAt })));
      if (r.nextCursor) console.log(`showing the newest ${r.items.length} of ${r.total}`);
      if (r.deleted.length) {
        console.log("removed in the last 30 days (reelsaw templates restore <id>):");
        table(r.deleted.map((t) => ({ id: t.id, name: t.name, layers: t.layerCount, deleted: t.deletedAt })));
      }
    } else if (sub === "show") {
      if (!a) throw new Error(usage);
      const t = await api.layerTemplates.get({ id: a });
      show(t);
      if (!t.layers.length) console.log("no layers");
      else
        table(
          t.layers.map((l) => ({
            id: l.id,
            kind: l.kind,
            what: l.kind === "text" ? `“${l.text}”` : l.assetId,
            timing: timingText(l.timing),
            position: l.kind === "audio" ? "" : `${l.x ?? 0.5},${l.y ?? 0.5}${l.kind === "asset" ? ` w ${l.w ?? ASSET_OVERLAY_DEFAULT_W}` : ` size ${l.size ?? TEXT_OVERLAY_DEFAULTS.size}${l.box ? " box" : ""}`}`,
            sound: l.kind === "audio" ? `vol ${l.volume ?? CLIP_AUDIO_DEFAULTS.volume} duck ${l.duck ?? CLIP_AUDIO_DEFAULTS.duck} fade ${l.fade ?? CLIP_AUDIO_DEFAULTS.fade} loop ${l.loop ?? CLIP_AUDIO_DEFAULTS.loop}${l.offset ? ` offset ${l.offset}` : ""}` : "",
          })),
        );
    } else if (sub === "save") {
      if (p.length < 4) throw new Error(usage);
      const t = await api.layerTemplates.fromClip({ clipId: b!, name: p.slice(3).join(" ") });
      console.log("saved:");
      show(t);
    } else if (sub === "rename") {
      if (p.length < 3) throw new Error(usage);
      const t = await api.layerTemplates.update({ id: a!, name: p.slice(2).join(" ") });
      console.log("renamed:");
      show(t);
    } else if (sub === "set") {
      if (!a || layers === undefined) throw new Error(usage);
      const parsed = z.array(templateLayerSchema).safeParse(JSON.parse(layers));
      if (!parsed.success) throw new Error(`--layers needs a JSON array of template layers: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      const t = await api.layerTemplates.update({ id: a, layers: parsed.data });
      console.log("updated:");
      show(t);
    } else if (sub === "delete") {
      if (!a) throw new Error(usage);
      const r = await api.layerTemplates.delete({ id: a });
      console.log(`deleted (restore with: reelsaw templates restore ${a})${r.clearedDefault ? "; it was your default for new projects, which is cleared" : ""}`);
    } else if (sub === "restore") {
      if (!a) throw new Error(usage);
      console.log("restored:");
      show(await api.layerTemplates.restore({ id: a }));
    } else if (sub === "purge") {
      if (!a) throw new Error(usage);
      const r = await api.layerTemplates.purge({ id: a });
      console.log(r.message);
    } else if (sub === "apply") {
      if (!a || !b) throw new Error(usage);
      const clipIds = p.slice(3);
      const r = await api.layerTemplates.applyToClips({ templateId: a, projectId: b, ...(clipIds.length ? { clipIds } : {}), mode: addMode ? "add" : "replace", rerender });
      console.log(`updated ${r.updated} clip(s) (${addMode ? "added to their layers" : "replacing their layers"}); ${r.rerendered} queued for re-render${rerender ? "" : " (pass --rerender to apply now)"}`);
      if (r.layersSkipped) console.log(`${r.layersSkipped} template layer(s) had no room on their clip and were left out`);
      for (const s of r.skipped) console.log(`skipped clip ${s.clipId}: ${s.reason}`);
    } else throw new Error(usage);
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
  const out = {
    pos: [] as string[],
    rerender: false,
    // templates: --add is a switch there (add to the clip's layers instead of replacing them)
    addMode: false,
    layers: undefined as string | undefined,
    clear: false,
    user: undefined as string | undefined,
    intro: undefined as string | undefined,
    outro: undefined as string | undefined,
    introSec: undefined as number | undefined,
    outroSec: undefined as number | undefined,
    // clip-layers
    set: undefined as string | undefined,
    add: undefined as string | undefined,
    addText: undefined as string | undefined,
    remove: undefined as string | undefined,
    from: undefined as number | undefined,
    to: undefined as number | undefined,
    x: undefined as number | undefined,
    y: undefined as number | undefined,
    w: undefined as number | undefined,
    size: undefined as number | undefined,
    color: undefined as string | undefined,
    box: false,
    font: undefined as string | undefined,
    opacity: undefined as number | undefined,
    // library
    kind: undefined as string | undefined,
    q: undefined as string | undefined,
    tags: undefined as string | undefined,
    name: undefined as string | undefined,
    // clip-layers
    addSound: undefined as string | undefined,
    loop: false,
    track: undefined as string | undefined,
    volume: undefined as number | undefined,
    offset: undefined as number | undefined,
    fade: undefined as number | undefined,
    duck: false,
    noDuck: false,
    noLoop: false,
    // library search
    source: undefined as string | undefined,
    license: undefined as string | undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--rerender") out.rerender = true;
    else if (a === "--clear") out.clear = true;
    else if (a === "--set") out.set = val();
    else if (a === "--add" && cmd === "templates") out.addMode = true;
    else if (a === "--layers") out.layers = val();
    else if (a === "--add") out.add = val();
    else if (a === "--add-text") out.addText = val();
    else if (a === "--size") out.size = Number(val());
    else if (a === "--color") out.color = val();
    else if (a === "--box") out.box = true;
    else if (a === "--font") out.font = val();
    else if (a === "--track") out.track = val();
    else if (a === "--volume") out.volume = Number(val());
    else if (a === "--offset") out.offset = Number(val());
    else if (a === "--fade") out.fade = Number(val());
    else if (a === "--duck") out.duck = true;
    else if (a === "--no-duck") out.noDuck = true;
    else if (a === "--no-loop") out.noLoop = true;
    else if (a === "--loop") out.loop = true;
    else if (a === "--add-sound") out.addSound = val();
    else if (a === "--kind") out.kind = val();
    else if (a === "--q") out.q = val();
    else if (a === "--tags") out.tags = val();
    else if (a === "--name") out.name = val();
    else if (a === "--source") out.source = val();
    else if (a === "--license") out.license = val();
    else if (a === "--remove") out.remove = val();
    else if (a === "--from") out.from = Number(val());
    else if (a === "--to") out.to = Number(val());
    else if (a === "--x") out.x = Number(val());
    else if (a === "--y") out.y = Number(val());
    else if (a === "--w") out.w = Number(val());
    else if (a === "--opacity") out.opacity = Number(val());
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
  return { user, api: appRouter.createCaller({ svc, who: { user, via: "apikey", canAdminister: true, session: null, blocked: null }, req, requestId: "cli", log: svc.log.child({ module: "cli", userId: user.id }) }) };
}

async function userByEmail(svc: Services, email: string | undefined) {
  if (!email) throw new Error(`usage: reelsaw ${cmd ?? "<command>"} <email>`);
  const u = await svc.database.db.query.user.findFirst({ where: eq(schema.user.email, email.toLowerCase()) });
  if (!u) throw new Error(`no account with email ${email}`);
  return u;
}

/** Hidden when stdin is a TTY; one line when piped. Never log the value. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    const line = await new Promise<string>((resolve) => {
      rl.once("line", (l) => {
        rl.close();
        resolve(l);
      });
    });
    const s = line.replace(/\r$/, "");
    if (!s) throw new Error("password is empty");
    return s;
  }
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let pw = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === "\n" || ch === "\r" || ch === "\u0004") {
            stdin.off("data", onData);
            resolve();
            return;
          }
          if (ch === "\u0003") {
            stdin.off("data", onData);
            reject(new Error("cancelled"));
            return;
          }
          if (ch === "\u007f" || ch === "\b") {
            pw = pw.slice(0, -1);
            continue;
          }
          if (ch >= " ") pw += ch;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write("\n");
  }
  if (!pw) throw new Error("password is empty");
  return pw;
}

async function run() {
  // the stdio MCP bridge talks to a running instance over HTTP and must not open the database or models
  if (cmd === "mcp") return runMcpStdio(process.env);
  const fn = cmd ? commands[cmd] : undefined;
  if (!fn) {
    console.log("usage: reelsaw <version|releases|users|approve|make-admin|set-password|usage|limits|abuse|billing|settings|retention|deleted|restore|restore-clip|delete-clip|delete-clips|purge-clip|captions|transcript-file|import-transcript|update-project|update-style|source-text|create-project|retry|reanalyze|refine|delete-project|export|create-clip|update-clip|purge|purge-project|decisions|machine|ytdlp-proxies|workers|queue|failure|retry-failures|status|storage|events|clip|faces|import-report|report|rerender|stuck|recover|logs|log-level|cuts|align|hear|flags|scenes|overlays|library|project-bumpers|clip-bumpers|clip-layers|apply-framing|templates|catalog|mcp> ...  (see src/cli.ts)");
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
